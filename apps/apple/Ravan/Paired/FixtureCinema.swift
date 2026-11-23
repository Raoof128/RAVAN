#if PAIRED && RAVAN_UI_TESTING
import Foundation
import UIKit

// Only the isolated UI-test launch branch constructs this client. URLProtocol handles
// every request in memory, including unexpected ones; the fixture never loads a network URL.
@MainActor enum FixtureCinema {
    static func make(session: String) -> PairedCinema {
        let url = URL(string: "https://screening-fixture.invalid")!
        let caps = CinemaDiscovery(protocolMajor: 1, instanceId: "isolated-fixture", profiles: ["apple-sdr-v1"],
                                   mediaOrigins: [url.absoluteString], features: ["continueWatching": true, "watchlistWrite": true])
        let readOnly = ProcessInfo.processInfo.arguments.contains("--ravan-paired-readonly")
        ScreeningFixtureProtocol.state.configure(cover: UIImage(named: "TidePoster")?.jpegData(compressionQuality: 0.65),
                                                readOnly: readOnly, failFirstPage: ProcessInfo.processInfo.arguments.contains("--ravan-fail-first-page"))
        func client(_ origin: URL) -> CinemaAPI {
            let config = cinemaConfiguration()
            config.protocolClasses = [ScreeningFixtureProtocol.self]
            return CinemaAPI(origin: origin, configuration: config)
        }
        let result = PairedCinema(service: "Ravan.fixture." + session, restoreAutomatically: false, client: client)
        result.connectFixture(client: client(url), capabilities: caps, readOnly: readOnly)
        return result
    }
}

private final class ScreeningFixtureState: @unchecked Sendable {
    private let lock = NSLock()
    private var cover: Data?
    private var readOnly = false
    private var failFirstPage = false
    private var saved = false
    private var created = false
    private var polls = 0
    private let artwork = "/api/artwork/" + String(repeating: "a", count: 32)
    private let preparation = String(repeating: "c", count: 64)

    func configure(cover: Data?, readOnly: Bool, failFirstPage: Bool) {
        lock.withLock {
            self.cover = cover; self.readOnly = readOnly; self.failFirstPage = failFirstPage
            saved = false; created = false; polls = 0
        }
    }

    func reply(to request: URLRequest) throws -> (Int, String, Data) {
        try lock.withLock {
            func json(_ status: Int, _ object: [String: Any]) throws -> (Int, String, Data) {
                (status, "application/json", try JSONSerialization.data(withJSONObject: object))
            }
            guard let url = request.url, url.scheme == "https", url.host == "screening-fixture.invalid" else {
                throw URLError(.unsupportedURL)
            }
            if url.path == "/api/capabilities" {
                return try json(200, ["protocolMajor": 1, "instanceId": "isolated-fixture", "profiles": ["apple-sdr-v1"],
                    "mediaOrigins": ["https://screening-fixture.invalid"], "features": ["watchlistWrite": true, "continueWatching": true]])
            }
            guard request.value(forHTTPHeaderField: "Authorization") == "Bearer fixture-only" else {
                return try json(401, ["error": "unauthorized"])
            }
            let movie: [String: Any] = ["id": "fixture-film", "title": "The Harbour Light", "available": true, "resumeMs": 0,
                "year": 2026, "saved": saved, "posterUrl": artwork, "editions": [["id": "cut", "generation": "v1",
                    "available": true, "label": "Festival cut", "audioTracks": [["index": 0, "label": "Persian", "language": "fas"]],
                    "subtitleTracks": [["label": "English", "language": "eng", "text": true]]]]]
            switch (request.httpMethod, url.path) {
            case ("GET", "/api/session"):
                return try json(200, ["authenticated": true, "deviceId": "test-screen", "permissions": readOnly ? [] : ["watchlist:write"]])
            case ("GET", "/api/movies"):
                if failFirstPage { failFirstPage = false; return try json(503, ["error": "fixture_busy"]) }
                let terms = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
                let query = terms.first { $0.name == "q" }?.value ?? ""
                let savedOnly = terms.contains { $0.name == "saved" && $0.value == "true" }
                let matches = query.isEmpty || "The Harbour Light".localizedCaseInsensitiveContains(query)
                return try json(200, ["items": matches && (!savedOnly || saved) ? [movie] : [], "nextCursor": NSNull()])
            case ("GET", "/api/continue-watching"):
                return try json(200, ["items": [], "nextCursor": NSNull()])
            case ("GET", "/api/movies/fixture-film"): return try json(200, movie)
            case ("GET", artwork):
                if let cover { return (200, "image/jpeg", cover) }
                return try json(404, ["error": "no_artwork"])
            case ("PUT", "/api/watchlist/fixture-film"):
                if readOnly { return try json(403, ["error": "owner_required"]) }
                var bytes = request.httpBody ?? Data()
                if bytes.isEmpty, let stream = request.httpBodyStream {
                    stream.open(); defer { stream.close() }
                    var buffer = [UInt8](repeating: 0, count: 512)
                    while bytes.count < 1024 {
                        let count = stream.read(&buffer, maxLength: buffer.count)
                        if count <= 0 { break }
                        bytes.append(contentsOf: buffer.prefix(count))
                    }
                }
                guard let fields = try JSONSerialization.jsonObject(with: bytes) as? [String: Bool],
                      let value = fields["saved"] else { return try json(400, ["error": "invalid_request"]) }
                saved = value; return (204, "application/json", Data())
            case ("POST", "/api/playback"):
                if created { return try json(409, ["kind": "conflict", "sessionId": "other-screen"]) }
                created = true
                return try json(202, ["kind": "preparing", "preparationId": preparation])
            case ("GET", "/api/preparations/" + preparation):
                polls += 1
                return try json(200, ["state": polls == 1 ? "preparing" : "ready", "progressPercent": polls == 1 ? 35 : 100])
            default: return try json(404, ["error": "unsupported_fixture_route"])
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
            let (status, mime, body) = try Self.state.reply(to: request)
            guard let url = request.url,
                  let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1",
                                                 headerFields: ["Content-Type": mime, "Content-Length": String(body.count)])
            else { throw URLError(.badServerResponse) }
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: body)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}
#endif
