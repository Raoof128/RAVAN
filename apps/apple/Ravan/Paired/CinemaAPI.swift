#if PAIRED
import Foundation
import Network

enum CinemaFailure: LocalizedError {
    case localAccess, address, incompatible, frontend, identity, offline, invalidReply, invalidMedia, keychain
    case http(Int, String, TimeInterval?)

    var errorDescription: String? {
        switch self {
        case .localAccess: String(localized: "Local network access is turned off for RAVĀN. Enable it in Settings to reach this server.")
        case .address: String(localized: "Enter an HTTPS server address without a path, account name or password.")
        case .incompatible: String(localized: "This server needs a version that supports RAVĀN for Apple devices.")
        case .frontend: String(localized: "This address hosts the website only. Connect it to a cinema server first.")
        case .identity: String(localized: "This cinema or device has changed. Connect your server again.")
        case .offline: String(localized: "Your server is offline. Reconnect in Your Cinema to try again.")
        case .invalidReply: String(localized: "The server returned an unreadable response. Try again after checking its version.")
        case .invalidMedia: String(localized: "The server did not provide a compatible, authorised MP4 stream.")
        case .keychain: String(localized: "Device credentials are unavailable. Unlock this device and try again.")
        case .http(429, _, _): String(localized: "The server is busy. Please wait before trying again.")
        case .http(403, "owner_required", _): String(localized: "Your device has read-only access to this action.")
        case .http(400, "pairing_unavailable", _): String(localized: "The pairing code is no longer available. Get a new code.")
        case .http(404, _, _): String(localized: "This item is no longer available on the server.")
        case .http(503, _, _): String(localized: "The server or source is temporarily unavailable.")
        case .http: String(localized: "The cinema could not complete the request. Try again.")
        }
    }
}

func cinemaMessage(_ error: Error) -> String {
    if let film = error as? FilmError { return film.localizedDescription }
    if let failure = error as? CinemaFailure { return failure.localizedDescription }
    if let error = error as? URLError {
        switch error.code {
        case .secureConnectionFailed, .serverCertificateUntrusted, .serverCertificateHasUnknownRoot,
             .serverCertificateHasBadDate, .serverCertificateNotYetValid:
            return String(localized: "This server’s certificate could not be trusted.")
        case .notConnectedToInternet:
            return String(localized: "The cinema is unreachable. Check Wi-Fi and local network access in Settings.")
        case .cancelled: return String(localized: "The request was cancelled.")
        default: return String(localized: "Could not reach the cinema. Check its address and your connection.")
        }
    }
    return String(localized: "The server returned an unexpected response. Try again.")
}

struct CinemaDiscovery: Decodable, Sendable {
    let protocolMajor: Int
    let instanceId: String
    let profiles: [String]
    let mediaOrigins: [String]
    let features: [String: Bool]
}

struct CinemaIdentity: Decodable, Sendable {
    let authenticated: Bool
    let deviceId: String?
    let permissions: [String]?
}

struct CinemaChallenge: Codable, Sendable {
    let id, code, pollSecret, expiresAt: String
    let pollIntervalMs: Int
    var expiry: Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: expiresAt) ?? ISO8601DateFormatter().date(from: expiresAt)
    }
}

struct CinemaApproval: Decodable, Sendable {
    let state: String
    let deviceId, credential: String?
}

struct ServerMovie: Identifiable, Decodable, Sendable {
    let id, title: String
    let year: Int?
    let available: Bool
    let resumeMs: Int
    let durationMs: Int?
    let lastPlayedAtMs: Int?
    let description: String?
    var saved: Bool?
    let posterUrl, stillUrl: String?
    let editions: [ServerEdition]?
    let resumeEditionId, resumeGeneration: String?

    func resumeOffset(for edition: ServerEdition) -> Int {
        guard edition.available else { return 0 }
        if resumeEditionId == nil && resumeGeneration == nil {
            return editions?.filter(\.available).count == 1 ? max(0, resumeMs) : 0
        }
        return resumeEditionId == edition.id && resumeGeneration == edition.generation ? max(0, resumeMs) : 0
    }
}

struct ServerEdition: Identifiable, Decodable, Equatable, Sendable {
    struct Audio: Decodable, Equatable, Sendable { let index: Int; let label, language: String }
    struct Subtitle: Decodable, Equatable, Sendable { let label, language: String; let text: Bool }
    let id, label: String
    let generation: String?
    let available: Bool
    let audioTracks: [Audio]?
    let subtitleTracks: [Subtitle]?

    func preferredAudioIndex(language: String) -> Int? {
        let aliases: [String: Set<String>] = ["en": ["en", "eng"], "fa": ["fa", "fas", "per"]]
        return audioTracks?.first { track in
            let base = track.language.lowercased().split(whereSeparator: { $0 == "-" || $0 == "_" }).first
            return base.map { aliases[language]?.contains(String($0)) == true } ?? false
        }?.index
    }
}

struct CinemaPage: Decodable, Sendable { let items: [ServerMovie]; let nextCursor: String? }
struct CinemaLease: Decodable, Sendable {
    let id, mediaUrl: String
    let startMs, epoch: Int
}
struct CinemaPlayReply: Decodable, Sendable {
    let kind: String
    let session: CinemaLease?
    let preparationId, sessionId, reason: String?
}
struct CinemaJobState: Decodable, Sendable {
    let state: String
    let progressPercent: Double?
    let reasonCode: String?
}
struct CinemaPlayRequest: Codable, Sendable {
    var profileId = "apple-sdr-v1"
    var movieId: String
    var startMs: Int
    var editionId, generation: String?
    var quality: String
    var audioTrack: Int?
    var replaceSessionId: String?
}
struct CinemaProgress: Codable, Equatable, Sendable {
    let sessionId: String
    let epoch, sequence, positionMs: Int
    let ended: Bool
}
private struct ErrorEnvelope: Decodable { let error: String }

final class NoCinemaRedirect: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

func cinemaConfiguration() -> URLSessionConfiguration {
    let config = URLSessionConfiguration.ephemeral
    config.httpCookieStorage = nil
    config.httpShouldSetCookies = false
    config.urlCredentialStorage = nil
    config.urlCache = nil
    config.timeoutIntervalForRequest = 18
    config.timeoutIntervalForResource = 40
    return config
}

enum CinemaURL {
    static func origin(_ raw: String) throws -> URL {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.contains("\\"), !value.contains("%"),
              var c = URLComponents(string: value),
              c.scheme?.lowercased() == "https", let host = c.host, !host.isEmpty,
              c.user == nil, c.password == nil, c.query == nil, c.fragment == nil,
              c.path == "" || c.path == "/", (1...65535).contains(c.port ?? 443)
        else { throw CinemaFailure.address }
        c.scheme = "https"; c.host = host.lowercased(); c.path = ""
        if c.port == 443 { c.port = nil }
        guard let url = c.url else { throw CinemaFailure.address }
        return url
    }

    static func artwork(_ path: String?) -> String? {
        guard let path, path.utf8.count == 45, path.hasPrefix("/api/artwork/"),
              path.dropFirst(13).utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) })
        else { return nil }
        return path
    }

    static func id(_ id: String) throws -> String {
        guard id.range(of: #"\A[A-Za-z0-9_-]{1,160}\z"#, options: .regularExpression) != nil
        else { throw CinemaFailure.invalidReply }
        return id
    }
}

actor CinemaAPI {
    nonisolated let origin: URL
    private let session: URLSession
    init(origin: URL, configuration: URLSessionConfiguration = cinemaConfiguration()) {
        self.origin = origin
        session = URLSession(configuration: configuration, delegate: NoCinemaRedirect(), delegateQueue: nil)
    }
    deinit { session.invalidateAndCancel() }

    func request(_ path: String, method: String = "GET", query: [URLQueryItem] = [],
                 body: Data? = nil, token: String? = nil, accepting: Set<Int> = [200]) async throws -> Data {
        try await response(path, method: method, query: query, body: body, token: token, accepting: accepting).0
    }

    func readerSession(token: String) async throws -> CinemaReaderSession {
        let (_, http) = try await response("/api/reading/session", method: "POST", token: token, accepting: [204])
        return try CinemaReaderSession(origin: origin, header: http.value(forHTTPHeaderField: "Set-Cookie"))
    }

    private func response(_ path: String, method: String, query: [URLQueryItem] = [],
                          body: Data? = nil, token: String?, accepting: Set<Int>) async throws -> (Data, HTTPURLResponse) {
        var parts = URLComponents(url: origin, resolvingAgainstBaseURL: false)!
        parts.path = path
        parts.queryItems = query.isEmpty ? nil : query
        guard let url = parts.url else { throw CinemaFailure.address }
        var r = URLRequest(url: url)
        r.httpMethod = method
        r.httpBody = body
        if body != nil { r.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        if let token { r.setValue("Bearer " + token, forHTTPHeaderField: "Authorization") }
        let (bytes, response) = try await session.bytes(for: r)
        guard let http = response as? HTTPURLResponse else { throw CinemaFailure.invalidReply }
        defer { bytes.task.cancel() }
        var data = Data()
        for try await byte in bytes {
            guard data.count < 2_097_152 else { throw CinemaFailure.invalidReply }
            data.append(byte)
        }
        if !accepting.contains(http.statusCode) {
            let code = (try? JSONDecoder().decode(ErrorEnvelope.self, from: data))?.error ?? ""
            throw CinemaFailure.http(http.statusCode, code, http.value(forHTTPHeaderField: "Retry-After").flatMap(Double.init))
        }
        return (data, http)
    }

    static func validate(_ cap: CinemaDiscovery) throws -> CinemaDiscovery {
        guard cap.protocolMajor == 1, cap.profiles.contains("apple-sdr-v1"),
              (try? CinemaURL.id(cap.instanceId)) != nil, !cap.mediaOrigins.isEmpty,
              cap.mediaOrigins.count <= 16 else { throw CinemaFailure.incompatible }
        for raw in cap.mediaOrigins { _ = try CinemaURL.origin(raw) }
        return cap
    }

    func discover() async throws -> CinemaDiscovery {
        do {
            let cap = try JSONDecoder().decode(CinemaDiscovery.self, from: await request("/api/capabilities"))
            return try Self.validate(cap)
        } catch CinemaFailure.http(_, "backend_not_connected", _) { throw CinemaFailure.frontend }
        catch CinemaFailure.http(401, _, _) { throw CinemaFailure.incompatible }
        catch CinemaFailure.http(404, _, _) { throw CinemaFailure.incompatible }
        catch let error as URLError where [.notConnectedToInternet, .cannotConnectToHost, .cannotFindHost].contains(error.code) {
            try Task.checkCancellation()
            if await localAccessDenied() { throw CinemaFailure.localAccess }
            throw error
        }
    }
    // URLSession often reports an offline error for a denied LAN request. Only
    // the path to the selected host can distinguish that from an offline server.
    private func localAccessDenied() async -> Bool {
        guard let host = origin.host(), let port = NWEndpoint.Port(rawValue: UInt16(origin.port ?? 443)) else { return false }
        let connection = NWConnection(host: NWEndpoint.Host(host), port: port, using: .tcp)
        let states = AsyncStream<Bool> { sink in
            connection.stateUpdateHandler = { state in
                if connection.currentPath?.unsatisfiedReason == .localNetworkDenied {
                    sink.yield(true); sink.finish(); return
                }
                switch state {
                case .ready, .failed, .cancelled: sink.yield(false); sink.finish()
                default: break
                }
            }
            sink.onTermination = { _ in connection.cancel() }
            connection.start(queue: .global(qos: .utility))
        }
        let timer = Task {
            try? await Task.sleep(for: .seconds(1))
            connection.cancel()
        }
        defer { timer.cancel(); connection.cancel() }
        for await denied in states { return denied }
        return false
    }
}
#endif
