#if PAIRED
import AVFoundation
import Foundation
import os
import XCTest
@testable import Ravan

/// The fixture sits below URLSession. AVPlayer, resource loading, Range
/// validation and the URLSession redirect delegate all execute normally.
private final class FilmRangeProtocol: URLProtocol, @unchecked Sendable {
    struct State {
        var bytes = Data()
        var edgeReads = 0
        var originReads = 0
        var rotatedReads = 0
        var sawNonzeroOffset = false
        var sawCredentials = false
    }
    static let fixture = OSAllocatedUnfairLock(initialState: State())
    static let first = String(repeating: "a", count: 43)
    static let second = String(repeating: "b", count: 43)
    static let edge = "cinema.invalid"
    static let media = "screen.invalid"

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        guard let url = request.url, let client else { return }
        guard let header = request.value(forHTTPHeaderField: "Range"), header.hasPrefix("bytes=") else {
            client.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        let credentials = request.value(forHTTPHeaderField: "Authorization") != nil ||
            request.value(forHTTPHeaderField: "Cookie") != nil
        if url.host == Self.edge {
            Self.fixture.withLock {
                $0.edgeReads += 1
                $0.sawCredentials = $0.sawCredentials || credentials
            }
            guard let target = URL(string: "https://" + Self.media + url.path),
                  let redirect = HTTPURLResponse(url: url, statusCode: 307, httpVersion: "HTTP/1.1",
                                                 headerFields: ["Location": target.absoluteString]) else { return }
            // Even if a redirect proposes credentials, the loader builds a clean request.
            var proposed = URLRequest(url: target)
            proposed.setValue("test-only", forHTTPHeaderField: "Authorization")
            proposed.setValue("fixture=1", forHTTPHeaderField: "Cookie")
            client.urlProtocol(self, wasRedirectedTo: proposed, redirectResponse: redirect)
            return
        }

        let bounds = header.dropFirst(6).split(separator: "-")
        guard url.host == Self.media, bounds.count == 2, let start = Int(bounds[0]), let end = Int(bounds[1]) else {
            client.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        let bytes = Self.fixture.withLock { state in
            state.originReads += 1
            if url.path.contains(Self.second) { state.rotatedReads += 1 }
            state.sawCredentials = state.sawCredentials || credentials
            state.sawNonzeroOffset = state.sawNonzeroOffset || start > 0
            return state.bytes
        }
        guard start >= 0, start < bytes.count, end >= start else {
            client.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        let last = min(end, bytes.count - 1)
        let response = HTTPURLResponse(url: url, statusCode: 206, httpVersion: "HTTP/1.1", headerFields: [
            "Content-Type": "video/mp4", "Accept-Ranges": "bytes",
            "Content-Range": "bytes \(start)-\(last)/\(bytes.count)",
            "Content-Length": String(last - start + 1)
        ])!
        // Give the test time to renew while AVFoundation probes the first range.
        Thread.sleep(forTimeInterval: 0.12)
        client.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client.urlProtocol(self, didLoad: bytes.subdata(in: start..<(last + 1)))
        client.urlProtocolDidFinishLoading(self)
    }
}

private final class CaptionProbe: NSObject, AVPlayerItemLegibleOutputPushDelegate {
    private let delivered = OSAllocatedUnfairLock(initialState: false)
    var receivedClosingCue: Bool { delivered.withLock { $0 } }

    func legibleOutput(_ output: AVPlayerItemLegibleOutput, didOutputAttributedStrings strings: [NSAttributedString],
                       nativeSampleBuffers: [Any], forItemTime itemTime: CMTime) {
        let text = strings.map(\.string).joined()
        if (81.5...89).contains(itemTime.seconds), text.contains("فردا دوباره آب را اندازه می‌گیریم.") {
            delivered.withLock { $0 = true }
        }
    }
}

@MainActor final class PairedMediaTests: XCTestCase {
    func testPlayerSeeksThroughRedirectAfterTicketRotation() async throws {
        let film = try XCTUnwrap(Bundle.main.url(forResource: "TideAlmanac", withExtension: "mp4"))
        let bytes = try Data(contentsOf: film)
        FilmRangeProtocol.fixture.withLock { $0 = .init(bytes: bytes) }
        defer { FilmRangeProtocol.fixture.withLock { $0 = .init() } }

        let server = try CinemaURL.origin("https://" + FilmRangeProtocol.edge)
        let capabilities = CinemaDiscovery(protocolMajor: 1, instanceId: "fixture", profiles: ["apple-sdr-v1"],
                                          mediaOrigins: ["https://" + FilmRangeProtocol.media], features: [:])
        func endpoint(_ ticket: String) throws -> CinemaMediaEndpoint {
            try CinemaMediaEndpoint(ticketPath: "/media/s/" + ticket + "/video.mp4", server: server, discovery: capabilities)
        }
        let loader = try CinemaMediaLoader(endpoint(FilmRangeProtocol.first)) {
            let config = cinemaConfiguration()
            config.protocolClasses = [FilmRangeProtocol.self]
            return config
        }
        defer { loader.stop() }
        let audioOwner = UUID()
        try await requireForegroundPlaybackHost()
        try await CinemaAudioSession.shared.acquire(audioOwner)
        let item = loader.item()
        let player = AVPlayer(playerItem: item)
        player.isMuted = true
        defer {
            player.pause()
            player.replaceCurrentItem(with: nil)
            CinemaAudioSession.shared.release(audioOwner)
        }
        let deadline = ContinuousClock.now + .seconds(30)
        while FilmRangeProtocol.fixture.withLock({ $0.originReads == 0 }), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertGreaterThan(FilmRangeProtocol.fixture.withLock { $0.originReads }, 0)
        loader.renew(try endpoint(FilmRangeProtocol.second))
        while item.status == .unknown && ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(40))
        }
        guard item.status == .readyToPlay else { XCTFail("The fixture did not become playable."); return }
        let captionGroup = try await item.asset.loadMediaSelectionGroup(for: .legible)
        let group = try XCTUnwrap(captionGroup)
        let persian = try XCTUnwrap(group.options.first { option in
            option.isPlayable && !option.hasMediaCharacteristic(.containsOnlyForcedSubtitles)
                && ["fa", "fas", "per"].contains(option.fixtureLanguageCode)
        })
        let probe = CaptionProbe()
        let output = AVPlayerItemLegibleOutput()
        output.setDelegate(probe, queue: .main)
        item.add(output)
        defer { item.remove(output) }
        item.select(persian, in: group)
        let sought = await player.seek(to: CMTime(seconds: 63, preferredTimescale: 1000),
                                      toleranceBefore: .zero, toleranceAfter: .zero)
        XCTAssertTrue(sought)
        XCTAssertTrue(player.currentItem === item)
        XCTAssertEqual(player.currentTime().seconds, 63, accuracy: 2)
        XCTAssertEqual(item.currentMediaSelection.selectedMediaOption(in: group), persian)
        // Start just before the last owned cue to verify actual timed text after another seek.
        let nearCue = await player.seek(to: CMTime(seconds: 81, preferredTimescale: 1000),
                                        toleranceBefore: .zero, toleranceAfter: .zero)
        XCTAssertTrue(nearCue)
        player.play()
        let captionDeadline = ContinuousClock.now + .seconds(12)
        while !probe.receivedClosingCue && ContinuousClock.now < captionDeadline {
            try await Task.sleep(for: .milliseconds(50))
        }
        let currentTime = player.currentTime().seconds
        let clockStatus = player.timeControlStatus.rawValue
        let waitReason = player.reasonForWaitingToPlay?.rawValue ?? "none"
        player.pause()
        XCTAssertTrue(probe.receivedClosingCue,
                      "Missing Persian closing cue at 82 seconds. Player reached \(currentTime)s, clock \(clockStatus), waiting \(waitReason).")
        let result = FilmRangeProtocol.fixture.withLock { $0 }
        XCTAssertGreaterThan(result.edgeReads, 0)
        XCTAssertGreaterThan(result.originReads, 0)
        XCTAssertGreaterThan(result.rotatedReads, 0)
        XCTAssertTrue(result.sawNonzeroOffset)
        XCTAssertFalse(result.sawCredentials)
    }
}
#endif
