#if PAIRED
import XCTest
@testable import Ravan

final class PairedContractTests: XCTestCase {
    private func read<T: Decodable>(_ name: String, _ type: T.Type) throws -> T {
        let bundle = Bundle(for: Self.self)
        let url = try XCTUnwrap(bundle.url(forResource: name, withExtension: "json", subdirectory: "apple-v1")
                                ?? bundle.url(forResource: name, withExtension: "json"))
        return try JSONDecoder().decode(T.self, from: Data(contentsOf: url))
    }

    func testDiscoveryChecksMajorVersionAndToleratesNewFields() throws {
        let valid = try CinemaAPI.validate(read("discovery", CinemaDiscovery.self))
        XCTAssertEqual(valid.mediaOrigins.count, 2)
        XCTAssertThrowsError(try CinemaAPI.validate(read("unsupported-major", CinemaDiscovery.self)))
    }

    func testArtworkUsesOnlyTheAuthenticatedArtworkRoute() {
        let id = String(repeating: "f0", count: 16)
        let path = "/api/artwork/" + id
        XCTAssertEqual(CinemaURL.artwork(path), path)
        for invalid in [nil, "", "https://unexpected.example" + path, "//other.example" + path, path + "?auth=1",
                        "/api/artwork/../" + id, "/api/movies/" + id, "/api/artwork/%2F" + id, path + "#fragment"] {
            XCTAssertNil(CinemaURL.artwork(invalid))
        }
    }

    func testPreparationContract() throws {
        let reply = try read("preparing", CinemaPlayReply.self)
        XCTAssertEqual(reply.kind, "preparing")
        XCTAssertEqual(reply.preparationId?.count, 64)
        let state = try read("preparation-status", CinemaJobState.self)
        XCTAssertEqual(state.state, "preparing")
        XCTAssertEqual(state.progressPercent, 34)
    }

    func testMediaRedirectRequiresExactTicketAndDeclaredHTTPSOrigin() throws {
        let origin = try CinemaURL.origin("HTTPS://CINEMA.example:443/")
        XCTAssertEqual(origin.absoluteString, "https://cinema.example")
        let path = "/media/s/" + String(repeating: "x", count: 43) + "/video.mp4"
        let endpoint = try CinemaMediaEndpoint(ticketPath: path, server: origin, discovery: read("discovery", CinemaDiscovery.self))
        XCTAssertTrue(endpoint.permits(try XCTUnwrap(URL(string: "https://media.example" + path))))
        for address in ["https://unknown.example" + path, "http://media.example" + path,
                        "https://user@media.example" + path, "https://media.example:444" + path,
                        "https://media.example" + path + "?extra=1", "https://media.example/another-ticket"] {
            XCTAssertFalse(endpoint.permits(try XCTUnwrap(URL(string: address))))
        }
        XCTAssertThrowsError(try CinemaURL.origin("https://user:password@cinema.example"))
    }

    func testInitialPlaybackNeverIncludesTakeoverAndUsesMilliseconds() throws {
        let request = CinemaPlayRequest(movieId: "film-1", startMs: 30125, editionId: "edition-2",
                                        generation: "gen", quality: "auto")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any])
        XCTAssertNil(body["replaceSessionId"])
        XCTAssertEqual(body["startMs"] as? Int, 30125)
    }

    func testScreeningCardUsesEditionGenerationAndAvailableLanguageTracks() throws {
        let bytes = Data(#"""
        {"id":"film","title":"Film","available":true,"resumeMs":40000,
         "resumeEditionId":"cut","resumeGeneration":"g1",
         "editions":[{"id":"cut","label":"First cut","generation":"g2","available":true,
                     "audioTracks":[{"index":3,"label":"Persian","language":"fas-IR"}]},
                    {"id":"other","label":"Second cut","generation":"g1","available":true}]}
        """#.utf8)
        let movie = try JSONDecoder().decode(ServerMovie.self, from: bytes)
        let edition = try XCTUnwrap(movie.editions?.first)
        XCTAssertEqual(movie.resumeOffset(for: edition), 0)
        XCTAssertEqual(movie.resumeOffset(for: try XCTUnwrap(movie.editions?.last)), 0)
        XCTAssertEqual(edition.preferredAudioIndex(language: "fa"), 3)
        XCTAssertNil(edition.preferredAudioIndex(language: "en"))
        let matching = ServerEdition(id: "cut", label: "First cut", generation: "g1", available: true,
                                     audioTracks: [], subtitleTracks: [])
        XCTAssertEqual(movie.resumeOffset(for: matching), 40000)
    }

    @MainActor func testRestoresAfterAmbiguousAcknowledgementAndPurgesOnInstanceChange() async throws {
        let state = PairingScript()
        let origin = try CinemaURL.origin("https://" + UUID().uuidString.lowercased() + ".example")
        let host = try XCTUnwrap(origin.host())
        ScriptedCinemaProtocol.scripts.register(state, host)
        defer { ScriptedCinemaProtocol.scripts.remove(host) }
        let service = "Ravan.fixture." + UUID().uuidString
        func client(_ url: URL) -> CinemaAPI {
            let config = cinemaConfiguration()
            config.protocolClasses = [ScriptedCinemaProtocol.self]
            return CinemaAPI(origin: url, configuration: config)
        }
        let api = client(origin)
        let caps = try await api.discover()
        let first = PairedCinema(service: service, client: client)
        let challenge = CinemaChallenge(id: "challenge", code: "ABCDEFGH", pollSecret: "fixture",
                                       expiresAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(50)),
                                       pollIntervalMs: 5000)
        try first.saveChallenge(challenge, origin: origin, instance: caps.instanceId)
        XCTAssertEqual(try first.recoverChallenge()?.challenge.id, challenge.id)
        let issued = CinemaApproval(state: "approved", deviceId: "fixture-device", credential: String(repeating: "x", count: 43))
        do {
            try await first.finishPairing(client: api, caps: caps, challenge: challenge, approval: issued)
            XCTFail("An interrupted acknowledgement must be recoverable")
        } catch { XCTAssertFalse(first.isConnected) }
        let restored = PairedCinema(service: service, client: client)
        await restored.restore()
        XCTAssertTrue(restored.isConnected)
        XCTAssertTrue(restored.canSave)
        XCTAssertNil(try restored.recoverChallenge())
        state.setOffline(true)
        await restored.foreground()
        XCTAssertFalse(restored.isConnected)
        XCTAssertNotNil(restored.account)
        XCTAssertNotNil(restored.notice)
        state.setOffline(false)
        await restored.restore(explicit: true)
        XCTAssertTrue(restored.isConnected)
        XCTAssertNil(restored.notice)
        state.replaceInstance()
        let replaced = PairedCinema(service: service, client: client)
        await replaced.restore()
        XCTAssertFalse(replaced.isConnected)
        XCTAssertNil(replaced.account)
        XCTAssertEqual(state.credentialRequestsOnReplacement, 0)
        await replaced.disconnect()
    }
}

private final class PairingScript: @unchecked Sendable {
    private let lock = NSLock()
    private var firstAcknowledgement = true
    private var replaced = false
    private var offline = false
    func setOffline(_ value: Bool) { lock.withLock { offline = value } }
    private var wrongRequests = 0
    var credentialRequestsOnReplacement: Int { lock.withLock { wrongRequests } }
    func replaceInstance() { lock.withLock { replaced = true } }
    func reply(_ request: URLRequest) throws -> (Int, [String: Any]) {
        try lock.withLock {
            if offline { throw URLError(.timedOut) }
            if replaced, request.value(forHTTPHeaderField: "Authorization") != nil { wrongRequests += 1 }
            switch request.url?.path {
            case "/api/capabilities":
                return (200, ["protocolMajor": 1, "instanceId": replaced ? "second" : "first",
                              "profiles": ["apple-sdr-v1"], "mediaOrigins": ["https://media.example"], "features": ["watchlistWrite": true]])
            case "/api/pairing/ack":
                if firstAcknowledgement {
                    firstAcknowledgement = false
                    throw URLError(.networkConnectionLost)
                }
                return (400, ["error": "pairing_unavailable"])
            case "/api/session":
                return (200, ["authenticated": true, "deviceId": "fixture-device", "permissions": ["watchlist:write"]])
            default: return (404, [:])
            }
        }
    }
}

private final class CinemaScripts: @unchecked Sendable {
    private let lock = NSLock()
    private var byHost: [String: PairingScript] = [:]
    func register(_ script: PairingScript, _ host: String) { lock.withLock { byHost[host] = script } }
    func remove(_ host: String) { lock.withLock { byHost[host] = nil } }
    func script(_ host: String) -> PairingScript? { lock.withLock { byHost[host] } }
}

private final class ScriptedCinemaProtocol: URLProtocol, @unchecked Sendable {
    static let scripts = CinemaScripts()
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            guard let url = request.url, let host = url.host(), let script = Self.scripts.script(host) else { throw URLError(.badURL) }
            let (status, json) = try script.reply(request)
            let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: try JSONSerialization.data(withJSONObject: json))
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}
#endif
