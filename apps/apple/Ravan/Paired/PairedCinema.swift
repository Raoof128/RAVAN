#if PAIRED
import Foundation
import Observation
import Security

extension Notification.Name {
    static let ravanLocalPlaybackStarting = Notification.Name("ravan.localPlaybackStarting")
    static let ravanServerPlaybackStarting = Notification.Name("ravan.serverPlaybackStarting")
}

struct CinemaAccount: Codable, Equatable, Sendable {
    let origin, instance, device: String
    var key: String { [origin, instance, device].joined(separator: "|") }
}
struct CinemaSecret: Codable {
    let bearer: String
    var pendingAck: String?
}
struct CinemaJob: Codable, Identifiable {
    let id, title: String
    var request: CinemaPlayRequest
}

struct RememberedChallenge: Codable {
    let origin, instance: String
    let challenge: CinemaChallenge
}

private final class CinemaVault {
    let service: String
    init(service: String) { self.service = service }
    #if RAVAN_UI_TESTING
    var transient: [String: Data]?
    #endif
    func base(_ key: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: key, kSecAttrSynchronizable as String: false]
    }
    func read<T: Decodable>(_ key: String, _ type: T.Type) throws -> T? {
        #if RAVAN_UI_TESTING
        if let transient { return try transient[key].map { try JSONDecoder().decode(type, from: $0) } }
        #endif
        var q = base(key)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw CinemaFailure.keychain }
        return try JSONDecoder().decode(type, from: data)
    }
    func put<T: Encodable>(_ value: T, _ key: String) throws {
        #if RAVAN_UI_TESTING
        if transient != nil { transient?[key] = try JSONEncoder().encode(value); return }
        #endif
        let q = base(key)
        let attrs: [String: Any] = [kSecValueData as String: try JSONEncoder().encode(value),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let update = SecItemUpdate(q as CFDictionary, attrs as CFDictionary)
        if update == errSecSuccess { return }
        guard update == errSecItemNotFound,
              SecItemAdd(q.merging(attrs) { _, new in new } as CFDictionary, nil) == errSecSuccess
        else { throw CinemaFailure.keychain }
    }
    func remove(_ key: String) throws {
        #if RAVAN_UI_TESTING
        if transient != nil { transient?[key] = nil; return }
        #endif
        let status = SecItemDelete(base(key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw CinemaFailure.keychain }
    }
}

@MainActor @Observable
final class PairedCinema {
    private let vault: CinemaVault
    let newClient: (URL) -> CinemaAPI
    private let restoreAutomatically: Bool

    init(service: String = (Bundle.main.bundleIdentifier ?? "Ravan") + ".cinema",
         restoreAutomatically: Bool = true,
         client: @escaping (URL) -> CinemaAPI = { CinemaAPI(origin: $0) }) {
        vault = CinemaVault(service: service)
        #if RAVAN_UI_TESTING
        if let session = CinemaLaunch.testSession, service == "Ravan.isolated-test." + session {
            vault.transient = [:]
        }
        #endif
        newClient = client
        self.restoreAutomatically = restoreAutomatically
    }

    private(set) var account: CinemaAccount?
    private(set) var discovery: CinemaDiscovery?
    private var api: CinemaAPI?
    private var secret: CinemaSecret?
    private var permissions: Set<String> = []
    private(set) var restoring = false
    private var validation: Task<CinemaDiscovery, Error>?
    private var revision = 0
    private(set) var jobs: [CinemaJob] = []
    var notice: String?
    var changed = 0
    let playback = CinemaRemotePlayback()

    var isConnected: Bool { api != nil && secret != nil }
    var scopeID: String? { isConnected ? account?.key : nil }
    var canSave: Bool { discovery?.features["watchlistWrite"] == true && permissions.contains("watchlist:write") }
    var canRead: Bool { isConnected && permissions.contains("reading:read") }
    var hasRememberedServer: Bool { account != nil }
    var portal: URL? {
        guard let origin = account?.origin else { return nil }
        return URL(string: origin + "/#/settings")
    }

    #if RAVAN_UI_TESTING
    func connectFixture(client: CinemaAPI, capabilities: CinemaDiscovery, readOnly: Bool) {
        precondition(CinemaLaunch.testSession != nil && client.origin.host == "screening-fixture.invalid")
        vault.transient = [:]
        let fixture = CinemaAccount(origin: client.origin.absoluteString, instance: capabilities.instanceId, device: "test-screen")
        account = fixture; api = client; discovery = capabilities
        secret = CinemaSecret(bearer: "fixture-only", pendingAck: nil)
        permissions = readOnly ? [] : ["watchlist:write"]
    }
    #endif

    func saveChallenge(_ challenge: CinemaChallenge, origin: URL, instance: String) throws {
        _ = try CinemaURL.id(challenge.id)
        guard challenge.pollSecret.utf8.count == 43 else { throw CinemaFailure.invalidReply }
        _ = try CinemaURL.id(challenge.pollSecret)
        try vault.put(RememberedChallenge(origin: origin.absoluteString, instance: instance, challenge: challenge), "pending")
    }

    func recoverChallenge() throws -> RememberedChallenge? {
        guard let pending = try vault.read("pending", RememberedChallenge.self) else { return nil }
        if (pending.challenge.expiry ?? .distantPast) <= .now {
            try clearChallenge()
            return nil
        }
        return pending
    }

    func clearChallenge() throws { try vault.remove("pending") }

    func restore(explicit: Bool = false) async {
        guard (restoreAutomatically || explicit), !restoring, !isConnected else { return }
        restoring = true
        defer { restoring = false }
        let started = revision
        do {
            guard let saved = try vault.read("selected", CinemaAccount.self),
                  let credential = try vault.read(saved.key, CinemaSecret.self) else { return }
            account = saved
            let client = newClient(try CinemaURL.origin(saved.origin))
            let caps = try await client.discover()
            guard started == revision else { return }
            guard caps.instanceId == saved.instance else { throw CinemaFailure.identity }
            try await activate(saved, credential, client, caps, revision: started)
        } catch {
            guard started == revision, !Task.isCancelled else { return }
            switch error {
            case CinemaFailure.identity, CinemaFailure.http(401, _, _),
                 CinemaFailure.http(400, "pairing_unavailable", _): try? forget()
            default: break
            }
            notice = cinemaMessage(error)
        }
    }

    func finishPairing(client: CinemaAPI, caps: CinemaDiscovery, challenge: CinemaChallenge,
                       approval: CinemaApproval) async throws {
        guard !isConnected, !restoring, account == nil, approval.state == "approved",
              let device = approval.deviceId, let bearer = approval.credential, bearer.utf8.count == 43
        else { throw CinemaFailure.invalidReply }
        _ = try CinemaURL.id(device)
        _ = try CinemaURL.id(bearer)
        let saved = CinemaAccount(origin: client.origin.absoluteString, instance: caps.instanceId, device: device)
        let credential = CinemaSecret(bearer: bearer, pendingAck: challenge.id)
        revision += 1
        let started = revision
        restoring = true
        defer { restoring = false }
        // An interrupted ACK can be retried after relaunch, with the same device.
        try vault.put(credential, saved.key)
        do { try vault.put(saved, "selected") }
        catch { try? vault.remove(saved.key); throw error }
        account = saved
        try clearChallenge()
        do {
            try await activate(saved, credential, client, caps, revision: started)
        } catch {
            guard started == revision else { throw CancellationError() }
            switch error {
            case CinemaFailure.identity, CinemaFailure.http(401, _, _):
                try forget()
                throw CinemaFailure.identity
            case CinemaFailure.http(400, "pairing_unavailable", _):
                try forget()
                throw error
            default:
                throw error
            }
        }
    }

    private func activate(_ saved: CinemaAccount, _ original: CinemaSecret, _ client: CinemaAPI,
                          _ caps: CinemaDiscovery, revision started: Int) async throws {
        var credential = original
        if let pending = credential.pendingAck {
            _ = try await client.request("/api/pairing/ack", method: "POST",
                    body: try JSONEncoder().encode(["id": pending]), token: credential.bearer, accepting: [204])
            guard revision == started else { throw CancellationError() }
            // Keep the confirmed delivery even if the subsequent identity request is interrupted.
            credential.pendingAck = nil
            try vault.put(credential, saved.key)
        }
        let data = try await client.request("/api/session", token: credential.bearer)
        let identity = try JSONDecoder().decode(CinemaIdentity.self, from: data)
        try Task.checkCancellation()
        guard revision == started else { throw CancellationError() }
        guard identity.authenticated, identity.deviceId == saved.device else { throw CinemaFailure.identity }
        let recovered = try vault.read(saved.key + "|jobs", [CinemaJob].self) ?? []
        permissions = Set(identity.permissions ?? [])
        jobs = recovered; account = saved; discovery = caps; api = client; secret = credential
        notice = nil; changed += 1
        await flushProgress()
    }

    func data(_ path: String, _ method: String = "GET", query: [URLQueryItem] = [], body: Data? = nil,
              accepting: Set<Int> = [200]) async throws -> Data {
        try await authorized { client, bearer in
            try await client.request(path, method: method, query: query, body: body, token: bearer, accepting: accepting)
        }
    }

    func readerSession() async throws -> CinemaReaderSession {
        guard canRead else { throw CinemaFailure.http(403, "reading_required", nil) }
        do {
            return try await authorized { client, bearer in try await client.readerSession(token: bearer) }
        } catch CinemaFailure.http(403, _, _) {
            // An owner can withdraw this permission without removing the cinema pairing.
            permissions.remove("reading:read")
            throw CinemaFailure.http(403, "reading_required", nil)
        }
    }

    private func authorized<Value: Sendable>(_ operation: (CinemaAPI, String) async throws -> Value) async throws -> Value {
        guard let captured = account else { throw CinemaFailure.identity }
        guard let api, let secret else { throw CinemaFailure.offline }
        do {
            // While a foreground check is outstanding, wait for the public identity
            // response before sending any credential to that origin.
            if let validation {
                let checked = try await validation.value
                guard checked.instanceId == captured.instance, captured == account, self.api === api else {
                    throw CinemaFailure.identity
                }
            }
            let value = try await operation(api, secret.bearer)
            try Task.checkCancellation()
            guard captured == account, self.api === api else { throw CancellationError() }
            return value
        } catch {
            guard captured == account, self.api === api else { throw CancellationError() }
            if case CinemaFailure.http(401, _, _) = error {
                try forget()
                notice = CinemaFailure.identity.localizedDescription
                throw CinemaFailure.identity
            }
            throw error
        }
    }

    func foreground() async {
        guard let api, let saved = account else { await restore(); return }
        guard validation == nil, !restoring else { return }
        let check = Task { try await api.discover() }
        validation = check
        defer { if account == saved { validation = nil } }
        do {
            let current = try await check.value
            guard account == saved else { return }
            guard current.instanceId == saved.instance else { throw CinemaFailure.identity }
            let identity = try JSONDecoder().decode(CinemaIdentity.self, from: await data("/api/session"))
            guard account == saved else { return }
            guard identity.authenticated, identity.deviceId == saved.device else { throw CinemaFailure.identity }
            discovery = current; permissions = Set(identity.permissions ?? []); notice = nil
            await flushProgress()
        } catch {
            guard account == saved, !Task.isCancelled else { return }
            switch error {
            case CinemaFailure.identity, CinemaFailure.http(401, _, _):
                try? forget()
            default:
                // Retain the saved account, job list and final checkpoint for explicit reconnect.
                self.api = nil; secret = nil; permissions = []; discovery = nil; changed += 1
            }
            notice = cinemaMessage(error)
        }
    }

    func recheckIdentity() async {
        guard let captured = account else { return }
        do {
            let identity = try JSONDecoder().decode(CinemaIdentity.self, from: await data("/api/session"))
            guard captured == account else { return }
            if !identity.authenticated || identity.deviceId != captured.device {
                try forget(); notice = CinemaFailure.identity.localizedDescription
            } else { permissions = Set(identity.permissions ?? []) }
        } catch { /* Transport failure alone cannot revoke a pairing. */ }
    }

    func disconnect() async {
        let saved = account, client = api, credential = secret
        let started = revision
        do {
            // Clear local access immediately, including when this network cannot reach the server.
            try forget()
            let cleared = revision
            notice = String(localized: "Access was removed from this device. Open Your Cinema in the owner’s browser to revoke the device on the server.")
            guard let saved, let client, let credential else { return }
            let current = try await client.discover()
            guard current.instanceId == saved.instance, revision == cleared else { return }
            _ = try await client.request("/api/devices/self", method: "DELETE", token: credential.bearer, accepting: [204])
            if revision == cleared { notice = String(localized: "This device has been disconnected.") }
        } catch {
            if revision == started || (account == saved && account != nil) { notice = cinemaMessage(error) }
        }
    }

    private func forget() throws {
        revision += 1
        validation?.cancel(); validation = nil
        playback.abandon()
        let old = account
        api = nil; discovery = nil; secret = nil; permissions = []; jobs = []; changed += 1
        if let old {
            try vault.remove(old.key)
            try vault.remove(old.key + "|jobs")
            try vault.remove(old.key + "|progress")
        }
        try clearChallenge()
        try vault.remove("selected")
        account = nil
    }

    // Keep the last unsent event bound to its original lease and sequence. The
    // server can reject it as stale after another player takes over.
    func queueFinalProgress(_ event: CinemaProgress) throws {
        guard let scope = account?.key else { return }
        try vault.put(event, scope + "|progress")
    }

    func flushProgress() async {
        guard let scopeID else { return }
        let key = scopeID + "|progress"
        do {
            guard let pending = try vault.read(key, CinemaProgress.self) else { return }
            let response = try await data("/api/progress", "POST", body: JSONEncoder().encode(pending))
            let receipt = try JSONDecoder().decode([String: String].self, from: response)
            guard ["stale", "accepted"].contains(receipt["status"] ?? ""), self.scopeID == scopeID,
                  try vault.read(key, CinemaProgress.self) == pending else { return }
            try vault.remove(key)
        } catch { /* Retain for the next foreground or session check. */ }
    }

    func remember(_ job: CinemaJob) throws {
        guard let scopeID else { throw CinemaFailure.identity }
        let updated = [job] + jobs.filter { $0.id != job.id }.prefix(31)
        try vault.put(updated, scopeID + "|jobs")
        jobs = Array(updated)
    }
    func removeJob(_ id: String) throws {
        guard let scopeID else { return }
        let updated = jobs.filter { $0.id != id }
        try vault.put(updated, scopeID + "|jobs")
        jobs = updated
    }
    func save(_ id: String, _ value: Bool) async throws {
        do {
            _ = try await data("/api/watchlist/" + CinemaURL.id(id), "PUT",
                               body: JSONEncoder().encode(["saved": value]), accepting: [204])
            changed += 1
        } catch CinemaFailure.http(403, "owner_required", _) {
            permissions.remove("watchlist:write")
            throw CinemaFailure.http(403, "owner_required", nil)
        }
    }
}
#endif
