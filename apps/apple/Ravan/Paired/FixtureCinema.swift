#if PAIRED && RAVAN_UI_TESTING
import Foundation
import UIKit
import WebKit

// Only the isolated UI-test launch branch constructs this client. URLProtocol handles
// every request in memory, including unexpected ones; the fixture never loads a network URL.
@MainActor enum FixtureCinema {
    private static var backgroundObserver: NSObjectProtocol?

    static func unpaired(session: String) -> PairedCinema {
        if ProcessInfo.processInfo.arguments.contains("--ravan-approve-fixture-in-background"), backgroundObserver == nil {
            // The owner acts in a separate browser while the phone app is suspended.
            backgroundObserver = NotificationCenter.default.addObserver(
                forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: nil
            ) { _ in ScreeningFixtureProtocol.state.approvePendingScreen() }
        }
        return PairedCinema(service: "Ravan.isolated-test." + session, restoreAutomatically: false, client: client)
    }

    static func loadReader(_ request: URLRequest, cookie: HTTPCookie, in view: WKWebView) {
        // WebKit does not use the native test URLProtocol. Serve this document entirely in memory.
        let granted = ScreeningFixtureProtocol.state.recognizesReaderCookie(cookie)
        let page = granted ? "<h1>The Lantern Shelf</h1>" : "<h1>Reader authorization required</h1>"
        let html = "<!doctype html><html lang='en'><meta name='viewport' content='width=device-width'>" + page + "</html>"
        guard let url = request.url, let response = HTTPURLResponse(url: url, statusCode: granted ? 200 : 403,
            httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "text/html; charset=utf-8",
                "Content-Security-Policy": "default-src 'none'"]) else { return }
        view.loadSimulatedRequest(request, response: response, responseData: Data(html.utf8))
    }

    private static func client(_ origin: URL) -> CinemaAPI {
        let config = cinemaConfiguration()
        config.protocolClasses = [ScreeningFixtureProtocol.self]
        return CinemaAPI(origin: origin, configuration: config)
    }

    static func make(session: String) -> PairedCinema {
        let url = URL(string: "https://screening-fixture.invalid")!
        let caps = CinemaDiscovery(protocolMajor: 1, instanceId: "isolated-fixture", profiles: ["apple-sdr-v1"],
                                   mediaOrigins: [url.absoluteString], features: ["continueWatching": true, "watchlistWrite": true])
        let readOnly = ProcessInfo.processInfo.arguments.contains("--ravan-paired-readonly")
        ScreeningFixtureProtocol.state.configure(cover: UIImage(named: "TidePoster")?.jpegData(compressionQuality: 0.65),
                                                readOnly: readOnly, failFirstPage: ProcessInfo.processInfo.arguments.contains("--ravan-fail-first-page"))
        let result = PairedCinema(service: "Ravan.fixture." + session, restoreAutomatically: false, client: client)
        result.connectFixture(client: client(url), capabilities: caps, readOnly: readOnly)
        return result
    }
}

private typealias FixtureReply = (status: Int, mime: String, body: Data, headers: [String: String])

private func fixtureJSON(_ status: Int, _ object: [String: Any]) throws -> FixtureReply {
    (status, "application/json", try JSONSerialization.data(withJSONObject: object), [:])
}

private func fixtureFields(_ request: URLRequest) throws -> [String: Any] {
    var bytes = request.httpBody ?? Data()
    if bytes.isEmpty, let stream = request.httpBodyStream {
        stream.open()
        defer { stream.close() }
        var buffer = [UInt8](repeating: 0, count: 512)
        while bytes.count <= 1024 {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count >= 0 else { throw URLError(.cannotParseResponse) }
            if count == 0 { break }
            bytes.append(contentsOf: buffer.prefix(count))
        }
    }
    guard bytes.count <= 1024, let fields = try JSONSerialization.jsonObject(with: bytes) as? [String: Any]
    else { throw URLError(.cannotParseResponse) }
    return fields
}

private struct FixtureWebsitePairing {
    enum Phase { case idle, pending, approved, delivered, acknowledged }
    var phase = Phase.idle
    let id = UUID().uuidString.lowercased()
    let device = UUID().uuidString.lowercased()
    let instance = UUID().uuidString.lowercased()
    let pollSecret = token()
    let bearer = token()
    let readerCookie = token()

    // The server uses 32 random bytes encoded as unpadded base64url for each of these values.
    private static func token() -> String {
        Data((0..<32).map { _ in UInt8.random(in: .min ... .max) }).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    mutating func reply(to request: URLRequest, path: String) throws -> FixtureReply {
        let authenticated = request.value(forHTTPHeaderField: "Authorization") == "Bearer " + bearer
        switch (request.httpMethod, path) {
        case ("GET", "/api/capabilities"):
            return try fixtureJSON(200, ["protocolMajor": 1, "instanceId": instance, "profiles": ["apple-sdr-v1"],
                "mediaOrigins": [RavanWebsite.origin.absoluteString], "features": ["continueWatching": true,
                    "watchlistWrite": true, "editionSelection": true, "preparationStatus": true,
                    "selfRevocation": true, "readingRoom": true]])
        case ("POST", "/api/pairing"):
            guard let name = try fixtureFields(request)["name"] as? String, !name.isEmpty else {
                return try fixtureJSON(400, ["error": "invalid_request"])
            }
            let date = ISO8601DateFormatter()
            date.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            phase = .pending
            return try fixtureJSON(200, ["code": "ABCDEFGH", "id": id, "pollSecret": pollSecret,
                "expiresAt": date.string(from: .now.addingTimeInterval(600)), "pollIntervalMs": 5000])
        case ("POST", "/api/pairing/poll"):
            guard try fixtureFields(request) as? [String: String] == ["id": id, "pollSecret": pollSecret] else {
                return try fixtureJSON(400, ["error": "pairing_unavailable"])
            }
            if phase == .pending { return try fixtureJSON(200, ["state": "pending"]) }
            guard phase == .approved || phase == .delivered else {
                return try fixtureJSON(400, ["error": "pairing_unavailable"])
            }
            phase = .delivered
            return try fixtureJSON(200, ["state": "approved", "deviceId": device, "credential": bearer])
        case ("POST", "/api/pairing/ack"):
            guard phase == .delivered, authenticated,
                  try fixtureFields(request) as? [String: String] == ["id": id] else {
                return try fixtureJSON(400, ["error": "pairing_unavailable"])
            }
            phase = .acknowledged
            return (204, "application/json", Data(), [:])
        case ("GET", "/api/session"):
            guard phase == .acknowledged, authenticated else {
                return try fixtureJSON(200, ["authenticated": false, "configured": true])
            }
            return try fixtureJSON(200, ["authenticated": true, "configured": true, "deviceId": device,
                "permissions": ["reading:read"]])
        default:
            guard phase == .acknowledged, authenticated else {
                return try fixtureJSON(401, ["error": "authentication_required"])
            }
            switch (request.httpMethod, path) {
            case ("GET", "/api/movies"):
                return try fixtureJSON(200, ["items": [["id": "paired-film", "title": "The Lantern Keeper",
                    "available": true, "resumeMs": 0]], "nextCursor": NSNull()])
            case ("GET", "/api/continue-watching"):
                return try fixtureJSON(200, ["items": [], "nextCursor": NSNull()])
            case ("POST", "/api/reading/session"):
                return (204, "application/json", Data(), ["Cache-Control": "no-store",
                    "Set-Cookie": "ravan_reader=" + readerCookie + "; Max-Age=1800; Path=/api; HttpOnly; Secure; SameSite=Strict"])
            default: return try fixtureJSON(404, ["error": "not_found"])
            }
        }
    }
}

private final class ScreeningFixtureState: @unchecked Sendable {
    private let lock = NSLock()
    private var website = FixtureWebsitePairing()
    private var cover: Data?
    private var readOnly = false
    private var failFirstPage = false
    private var saved = false
    private var created = false
    private var polls = 0
    private let artwork = "/api/artwork/" + String(repeating: "a", count: 32)
    private let preparation = String(repeating: "c", count: 64)

    func approvePendingScreen() {
        lock.withLock { if website.phase == .pending { website.phase = .approved } }
    }

    func recognizesReaderCookie(_ cookie: HTTPCookie) -> Bool {
        lock.withLock { website.phase == .acknowledged && cookie.name == "ravan_reader" && cookie.value == website.readerCookie }
    }

    func configure(cover: Data?, readOnly: Bool, failFirstPage: Bool) {
        lock.withLock {
            self.cover = cover; self.readOnly = readOnly; self.failFirstPage = failFirstPage
            saved = false; created = false; polls = 0
        }
    }

    func reply(to request: URLRequest) throws -> FixtureReply {
        try lock.withLock {
            guard let url = request.url, url.scheme == "https" else { throw URLError(.unsupportedURL) }
            if url.host == RavanWebsite.origin.host {
                return try website.reply(to: request, path: url.path)
            }
            guard url.host == "screening-fixture.invalid" else {
                throw URLError(.unsupportedURL)
            }
            if url.path == "/api/capabilities" {
                return try fixtureJSON(200, ["protocolMajor": 1, "instanceId": "isolated-fixture", "profiles": ["apple-sdr-v1"],
                    "mediaOrigins": ["https://screening-fixture.invalid"], "features": ["watchlistWrite": true, "continueWatching": true]])
            }
            guard request.value(forHTTPHeaderField: "Authorization") == "Bearer fixture-only" else {
                return try fixtureJSON(401, ["error": "unauthorized"])
            }
            let movie: [String: Any] = ["id": "fixture-film", "title": "The Harbour Light", "available": true, "resumeMs": 0,
                "year": 2026, "saved": saved, "posterUrl": artwork, "editions": [["id": "cut", "generation": "v1",
                    "available": true, "label": "Festival cut", "audioTracks": [["index": 0, "label": "Persian", "language": "fas"]],
                    "subtitleTracks": [["label": "English", "language": "eng", "text": true]]]]]
            switch (request.httpMethod, url.path) {
            case ("GET", "/api/session"):
                return try fixtureJSON(200, ["authenticated": true, "deviceId": "test-screen", "permissions": readOnly ? [] : ["watchlist:write"]])
            case ("GET", "/api/movies"):
                if failFirstPage { failFirstPage = false; return try fixtureJSON(503, ["error": "fixture_busy"]) }
                let terms = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
                let query = terms.first { $0.name == "q" }?.value ?? ""
                let savedOnly = terms.contains { $0.name == "saved" && $0.value == "true" }
                let matches = query.isEmpty || "The Harbour Light".localizedCaseInsensitiveContains(query)
                return try fixtureJSON(200, ["items": matches && (!savedOnly || saved) ? [movie] : [], "nextCursor": NSNull()])
            case ("GET", "/api/continue-watching"):
                return try fixtureJSON(200, ["items": [], "nextCursor": NSNull()])
            case ("GET", "/api/movies/fixture-film"): return try fixtureJSON(200, movie)
            case ("GET", artwork):
                if let cover { return (200, "image/jpeg", cover, [:]) }
                return try fixtureJSON(404, ["error": "no_artwork"])
            case ("PUT", "/api/watchlist/fixture-film"):
                if readOnly { return try fixtureJSON(403, ["error": "owner_required"]) }
                guard let value = try fixtureFields(request)["saved"] as? Bool else {
                    return try fixtureJSON(400, ["error": "invalid_request"])
                }
                saved = value; return (204, "application/json", Data(), [:])
            case ("POST", "/api/playback"):
                if created { return try fixtureJSON(409, ["kind": "conflict", "sessionId": "other-screen"]) }
                created = true
                return try fixtureJSON(202, ["kind": "preparing", "preparationId": preparation])
            case ("GET", "/api/preparations/" + preparation):
                polls += 1
                return try fixtureJSON(200, ["state": polls == 1 ? "preparing" : "ready", "progressPercent": polls == 1 ? 35 : 100])
            default: return try fixtureJSON(404, ["error": "unsupported_fixture_route"])
            }
        }
    }
}

private final class ScreeningFixtureProtocol: URLProtocol, @unchecked Sendable {
    static let state = ScreeningFixtureState()
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let (status, mime, body, fields) = try Self.state.reply(to: request)
            let headers = fields.merging(["Content-Type": mime, "Content-Length": String(body.count)]) { _, value in value }
            guard let url = request.url,
                  let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1",
                                                 headerFields: headers)
            else { throw URLError(.badServerResponse) }
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: body)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}
#endif
