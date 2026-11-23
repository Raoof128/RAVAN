#if PAIRED
import Foundation

enum RavanWebsite {
    static let origin = URL(string: "https://cinema.example.com")!

    static func settings(at origin: URL) -> URL {
        URL(string: "/#/settings", relativeTo: origin)!.absoluteURL
    }

    static func reader(at origin: URL) -> URL {
        URL(string: "/#/reading", relativeTo: origin)!.absoluteURL
    }
}
#endif
