#if PAIRED
import Foundation

struct CinemaReaderSession: Sendable {
    let origin: URL
    let cookie: HTTPCookie
    let expires: Date

    init(origin: URL, header: String?) throws {
        self.origin = try CinemaURL.origin(origin.absoluteString)
        guard let header, header.utf8.count <= 512 else { throw CinemaFailure.invalidReply }
        // Only the host-only reader cookie may cross from the authenticated transport into WebKit.
        let fields = header.components(separatedBy: ";").map { $0.trimmingCharacters(in: .whitespaces) }
        let required = Set(["max-age=1800", "path=/api", "secure", "httponly", "samesite=strict"])
        guard fields.count == required.count + 1, let pair = fields.first, pair.hasPrefix("ravan_reader="),
              Set(fields.dropFirst().map { $0.lowercased() }) == required else { throw CinemaFailure.invalidReply }
        let value = pair.dropFirst("ravan_reader=".count)
        guard value.utf8.count == 43, value.utf8.allSatisfy({
            (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95
        }) else { throw CinemaFailure.invalidReply }
        let parts = HTTPCookie.cookies(withResponseHeaderFields: ["Set-Cookie": header], for: self.origin)
        guard parts.count == 1, let parsed = parts.first, parsed.domain.lowercased() == self.origin.host()?.lowercased(),
              parsed.name == "ravan_reader", parsed.value == value, parsed.path == "/api",
              parsed.isSecure, parsed.isHTTPOnly, parsed.sameSitePolicy?.rawValue.lowercased() == "strict",
              let expires = parsed.expiresDate else { throw CinemaFailure.invalidReply }
        self.cookie = parsed
        self.expires = expires
    }

    var page: URL {
        // Preserve the validated authority, including brackets around IPv6 hosts.
        var parts = URLComponents(url: origin, resolvingAgainstBaseURL: false)!
        parts.path = "/"
        parts.queryItems = [.init(name: "client", value: "apple-reader")]
        parts.fragment = "/reading"
        // origin has already passed CinemaURL.origin's HTTPS host and port validation.
        return parts.url!
    }

    func permits(_ url: URL, requireReadingRoute: Bool = true) -> Bool {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme?.lowercased() == "https", parts.user == nil, parts.password == nil,
              url.host()?.lowercased() == origin.host()?.lowercased(), (parts.port ?? 443) == (origin.port ?? 443),
              parts.percentEncodedPath == "/", parts.percentEncodedQuery == "client=apple-reader" else { return false }
        // WebKit may omit the fragment in the HTTP response URL.
        guard let route = parts.percentEncodedFragment else { return !requireReadingRoute }
        if route == "/reading" { return true }
        let prefix = "/reading/folder/"
        return route.hasPrefix(prefix) && (try? CinemaURL.id(String(route.dropFirst(prefix.count)))) != nil
    }
}
#endif
