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
        let attempt = try PairingAttempt(.lostAcknowledgement)
        let state = attempt.state
        let first = attempt.makeCinema()
        do {
            try await attempt.approve(first)
            XCTFail("The acknowledgement reply was interrupted")
        } catch { XCTAssertFalse(first.isConnected) }
        let restored = attempt.makeCinema()
        await restored.restore()
        XCTAssertTrue(restored.isConnected)
        XCTAssertTrue(restored.canSave)
        XCTAssertEqual(state.acknowledgements, 2)
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
        let replaced = attempt.makeCinema()
        await replaced.restore()
        XCTAssertFalse(replaced.isConnected)
        XCTAssertNil(replaced.account)
        XCTAssertEqual(state.credentialRequestsOnReplacement, 0)
        await replaced.disconnect()
    }

    @MainActor func testMalformedCredentialNeverReachesAcknowledgement() async throws {
        let attempt = try PairingAttempt(.rejectedAcknowledgement)
        let cinema = attempt.makeCinema()
        for credential in [String(repeating: "a", count: 42), String(repeating: "a", count: 44),
                           String(repeating: "a", count: 42) + "\n"] {
            do {
                try await attempt.approve(cinema, credential: credential)
                XCTFail("Unexpected credential format")
            } catch CinemaFailure.invalidReply {
                XCTAssertNil(cinema.account)
            }
        }
        XCTAssertEqual(attempt.state.acknowledgements, 0)
        try cinema.clearChallenge()
    }

    @MainActor func testRestoreResumesAtIdentityAfterSuccessfulAcknowledgement() async throws {
        let attempt = try PairingAttempt(.lostIdentity)
        let first = attempt.makeCinema()
        do {
            try await attempt.approve(first)
            XCTFail("The identity reply was interrupted")
        } catch { XCTAssertFalse(first.isConnected) }

        let restored = attempt.makeCinema()
        await restored.restore()
        XCTAssertTrue(restored.isConnected)
        XCTAssertEqual(attempt.state.acknowledgements, 1)
        await restored.disconnect()
    }

    @MainActor func testRejectedAcknowledgementRequiresNewCode() async throws {
        let attempt = try PairingAttempt(.rejectedAcknowledgement)
        let first = attempt.makeCinema()
        do {
            try await attempt.approve(first)
            XCTFail("The server rejected this delivery")
        } catch CinemaFailure.http(400, "pairing_unavailable", _) {
            XCTAssertFalse(first.isConnected)
            XCTAssertNil(first.account)
        }
        let restored = attempt.makeCinema()
        await restored.restore()
        XCTAssertNil(restored.account)
        XCTAssertEqual(attempt.state.acknowledgements, 1)
        XCTAssertEqual(attempt.state.identityRequests, 0)
    }
}

private final class PairingAttempt {
    let state: PairingScript
    private let origin: URL
    private let host: String
    private let service = "Ravan.fixture." + UUID().uuidString

    init(_ scenario: PairingScript.Scenario) throws {
        state = PairingScript(scenario)
        origin = try CinemaURL.origin("https://" + UUID().uuidString.lowercased() + ".example")
        host = try XCTUnwrap(origin.host())
        ScriptedCinemaProtocol.scripts.register(state, host)
    }

    deinit { ScriptedCinemaProtocol.scripts.remove(host) }

    private static func client(_ url: URL) -> CinemaAPI {
        let config = cinemaConfiguration()
        config.protocolClasses = [ScriptedCinemaProtocol.self]
        return CinemaAPI(origin: url, configuration: config)
    }

    @MainActor func makeCinema() -> PairedCinema {
        PairedCinema(service: service, client: Self.client)
    }

    @MainActor func approve(_ cinema: PairedCinema, credential: String = PairingScript.bearer) async throws {
        let api = Self.client(origin)
        let caps = try await api.discover()
        let challenge = CinemaChallenge(id: "challenge", code: "ABCDEFGH", pollSecret: String(repeating: "p", count: 43),
                                        expiresAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(50)),
                                        pollIntervalMs: 5000)
        try cinema.saveChallenge(challenge, origin: origin, instance: caps.instanceId)
        XCTAssertEqual(try cinema.recoverChallenge()?.challenge.id, challenge.id)
        let issued = CinemaApproval(state: "approved", deviceId: "fixture-device", credential: credential)
        try await cinema.finishPairing(client: api, caps: caps, challenge: challenge, approval: issued)
    }
}

private final class PairingScript: @unchecked Sendable {
    enum Scenario { case lostAcknowledgement, lostIdentity, rejectedAcknowledgement }
    static let bearer = String(repeating: "x", count: 43)
    private let scenario: Scenario
    private let lock = NSLock()
    private var ackCount = 0
    private var identityCount = 0
    var acknowledgements: Int { lock.withLock { ackCount } }
    var identityRequests: Int { lock.withLock { identityCount } }
    init(_ scenario: Scenario) { self.scenario = scenario }
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
                guard request.httpMethod == "POST",
                      request.value(forHTTPHeaderField: "Authorization") == "Bearer " + Self.bearer
                else { return (401, ["error": "authentication_required"]) }
                ackCount += 1
                if scenario == .lostAcknowledgement && ackCount == 1 { throw URLError(.networkConnectionLost) }
                if scenario == .rejectedAcknowledgement { return (400, ["error": "pairing_unavailable"]) }
                return (204, [:])
            case "/api/session":
                identityCount += 1
                guard request.value(forHTTPHeaderField: "Authorization") == "Bearer " + Self.bearer
                else { return (200, ["authenticated": false]) }
                if scenario == .lostIdentity && identityCount == 1 { throw URLError(.networkConnectionLost) }
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
            if status != 204 { client?.urlProtocol(self, didLoad: try JSONSerialization.data(withJSONObject: json)) }
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}
#endif
