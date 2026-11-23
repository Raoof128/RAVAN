#if PAIRED
import WebKit
import XCTest
@testable import Ravan

final class ReadingRoomTests: XCTestCase {
    private let origin = URL(string: "https://cinema.example:8443")!
    private let value = String(repeating: "x", count: 43)
    private var header: String { "ravan_reader=" + value + "; Max-Age=1800; Path=/api; HttpOnly; Secure; SameSite=Strict" }

    func testReaderAcceptsOnlyTheMarkedShelfAtThePairedOrigin() throws {
        let session = try CinemaReaderSession(origin: origin, header: header)
        XCTAssertEqual(session.page.absoluteString, "https://cinema.example:8443/?client=apple-reader#/reading")
        XCTAssertTrue(session.permits(session.page))
        let localIPv6 = try CinemaReaderSession(origin: CinemaURL.origin("https://[::1]:8443"), header: header)
        XCTAssertEqual(localIPv6.page.absoluteString, "https://[::1]:8443/?client=apple-reader#/reading")
        XCTAssertTrue(localIPv6.permits(localIPv6.page))
        XCTAssertTrue(session.permits(try XCTUnwrap(URL(string: session.page.absoluteString + "/folder/folder_2"))))
        let document = try XCTUnwrap(URL(string: "https://cinema.example:8443/?client=apple-reader"))
        XCTAssertTrue(session.permits(document, requireReadingRoute: false))
        XCTAssertFalse(session.permits(document))
        for invalid in ["https://cinema.example:8443/#/reading", "https://cinema.example:8443/?client=apple-reader#/settings",
                        "http://cinema.example:8443/?client=apple-reader#/reading", "https://cinema.example/?client=apple-reader#/reading",
                        "https://other.example:8443/?client=apple-reader#/reading", "https://user@cinema.example:8443/?client=apple-reader#/reading",
                        "https://cinema.example:8443/api/reading", "https://cinema.example:8443/?client=apple-reader#/reading/folder/%2F",
                        "https://cinema.example:8443/?client=apple-reader&other=1#/reading", "file:///reading", "about:blank"] {
            XCTAssertFalse(session.permits(try XCTUnwrap(URL(string: invalid))), invalid)
        }
    }

    func testReaderRejectsWiderOrMalformedCookies() throws {
        let valid = try CinemaReaderSession(origin: origin, header: header)
        XCTAssertTrue(valid.expires.timeIntervalSinceNow > 1790)
        for invalid in [nil, "", header + "; Domain=cinema.example", header + "; HttpOnly",
                        header.replacingOccurrences(of: "ravan_reader", with: "mov_session"),
                        header.replacingOccurrences(of: "Path=/api", with: "Path=/"),
                        header.replacingOccurrences(of: "Path=/api", with: "Path=/API"),
                        header.replacingOccurrences(of: "; Secure", with: ""),
                        header.replacingOccurrences(of: "; HttpOnly", with: ""),
                        header.replacingOccurrences(of: "Strict", with: "None"),
                        header.replacingOccurrences(of: "1800", with: "999999"),
                        header.replacingOccurrences(of: value, with: String(value.dropLast())),
                        header.replacingOccurrences(of: value, with: "y," + value)] {
            XCTAssertThrowsError(try CinemaReaderSession(origin: origin, header: invalid))
        }
    }

    @MainActor func testScopedCookieSurvivesWebKitImportAndIsIsolatedFromANewShelf() async throws {
        let session = try CinemaReaderSession(origin: origin, header: header)
        let shelf = WKWebsiteDataStore.nonPersistent()
        XCTAssertFalse(shelf.isPersistent)
        await shelf.httpCookieStore.setCookie(session.cookie)
        let installed = await shelf.httpCookieStore.allCookies()
        XCTAssertEqual(installed.count, 1)
        let cookie = try XCTUnwrap(installed.first)
        XCTAssertEqual(cookie.domain, "cinema.example")
        XCTAssertEqual(cookie.path, "/api")
        XCTAssertEqual(cookie.value, value)
        XCTAssertTrue(cookie.isHTTPOnly)
        XCTAssertTrue(cookie.isSecure)
        XCTAssertEqual(cookie.sameSitePolicy?.rawValue.lowercased(), "strict")
        let separate = await WKWebsiteDataStore.nonPersistent().httpCookieStore.allCookies()
        XCTAssertTrue(separate.isEmpty)
    }
}

#if RAVAN_HOSTED_READER_CHECK
// Opt in only after deploying the matching web bundle. The test host loads public web assets;
// every book, position, and device credential used here is synthetic.
extension ReadingRoomTests {
    @MainActor @objc func testHostedReaderRecoveryAndFixtureBookmark() async throws {
        let session = try CinemaReaderSession(origin: RavanWebsite.origin, header: header)
        let released = try HostedReader(session: session)
        defer { released.close() }
        try await released.until("document.querySelector('main h1')?.textContent.includes('Reconnect your reading room')",
                                 step: "Hosted recovery for a synthetic, unrecognised cookie")
        released.close()

        let first = try HostedReader(session: session, fixture: hostedBook(section: 0))
        defer { first.close() }
        try await first.openBook(expectChapter: "The quiet chapter")
        _ = try await first.web.evaluateJavaScript("Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Next').click(); true")
        try await first.until("document.querySelector('.reading-prose')?.textContent.includes('A second morning')", step: "Second chapter")
        _ = try await first.web.evaluateJavaScript(#"document.querySelector('button[aria-label^="Back to reading room"]').click(); true"#)
        try await first.until("window.fixturePosition.section === 1 && !!document.querySelector('[data-book-id]')", step: "Saved the second chapter")
        let saved = try await first.web.evaluateJavaScript("window.fixturePosition.section")
        let section = try XCTUnwrap(saved as? Int)
        first.close()

        let reopened = try HostedReader(session: session, fixture: hostedBook(section: section))
        defer { reopened.close() }
        try await reopened.openBook(expectChapter: "A second morning")
        let localHistory = try await reopened.web.evaluateJavaScript("Object.keys(localStorage).some(key => key.startsWith('ravan:reading:'))")
        XCTAssertEqual(localHistory as? Bool, false)
    }

    // A two-chapter EPUB produced by the same epubFixture used in the browser suite.
    private func hostedBook(section: Int) -> String {
        let epub = """
        UEsDBBQACAAIAMe0d10AAAAAAAAAAAAAAAAIAAkAbWltZXR5cGVVVAUAAaUlBGtLLCjIyUxOLMnMz9NPLShN0q7KLAAAUEsHCG9h
        qywWAAAAFAAAAFBLAwQUAAgACADHtHddAAAAAAAAAAAAAAAAFgAJAE1FVEEtSU5GL2NvbnRhaW5lci54bWxVVAUAAaUlBGtNjDEO
        QiEQBa/yQ6/0Gz5X0MQTIC6RCPsIuyQe38TiazfFzIQMsVSF5/buTXR3awohaVWS1FnJMmGwPJBXZzH6anRkLoYJWKmN9YdbWa2d
        RrLn7i7Xm78DrzNGcT4G/+f74xM/UEsHCANWw6pkAAAAigAAAFBLAwQUAAgACADHtHddAAAAAAAAAAAAAAAADAAJAE9QUy9ib29r
        Lm9wZlVUBQABpSUEa5WQzQqDQAyEX2XJtdRIL4WivsviZjV0f4IGVt++aJV67W3IMN8MacT2bzuQWWJIcwujqrwQSykVO/FVngZ8
        1PUTs3jommgTe5q1a1gpGnYt5ERgxon8Lqtl1BjARHJs77oKtWBFAvdWOSfc7dsSA+CFoSWfDC35Lwb+Js3Cib7Uibxhd446uy7X
        rXFLHxk83tB9AFBLBwi9UHJwkwAAABABAABQSwMEFAAIAAgAx7R3XQAAAAAAAAAAAAAAAA0ACQBPUFMvb25lLnhodG1sVVQFAAGl
        JQRrJY4xC8IwEEb/yplZehSnlOuBWGcdujhGGxohbWJ6kvbfS+ry+IbHx6NDd7v0j/sVnEyeqRDWyc9Lq5xIbBBzzlU+VSGNWGut
        cS2OKlLjzTy2ys6K6RmGjcnV3DsLn+/bCryciWIToauZIp9hmYz3sEhI2xGSNcMGEvZREUYm/J/gnvIDUEsHCDM/m2WEAAAAmgAA
        AFBLAwQUAAgACADHtHddAAAAAAAAAAAAAAAADQAJAE9QUy90d28ueGh0bWxVVAUAAaUlBGslzMEJwzAMQNFVRAawMD25qILu0Ama
        mCgQS8ZWcbJ9CL3/90m87HCUXftrEvf6RBxjhPEI1laMKSU87mZi+tpyMknkN/Q8my5QrOmmK6FEpsofydDd2gmzqW/6yz0QVib8
        U7xHfAFQSwcI7XPJfWYAAABzAAAAUEsBAgADFAAIAAgAx7R3XW9hqywWAAAAFAAAAAgACQAAAAAAAAAAAKSBAAAAAG1pbWV0eXBl
        VVQFAAGlJQRrUEsBAgADFAAIAAgAx7R3XQNWw6pkAAAAigAAABYACQAAAAAAAAAAAKSBVQAAAE1FVEEtSU5GL2NvbnRhaW5lci54
        bWxVVAUAAaUlBGtQSwECAAMUAAgACADHtHddvVBycJMAAAAQAQAADAAJAAAAAAAAAAAApIEGAQAAT1BTL2Jvb2sub3BmVVQFAAGl
        JQRrUEsBAgADFAAIAAgAx7R3XTM/m2WEAAAAmgAAAA0ACQAAAAAAAAAAAKSB3AEAAE9QUy9vbmUueGh0bWxVVAUAAaUlBGtQSwEC
        AAMUAAgACADHtHdd7XPJfWYAAABzAAAADQAJAAAAAAAAAAAApIGkAgAAT1BTL3R3by54aHRtbFVUBQABpSUEa1BLBQYAAAAABQAF
        AFcBAABOAwAAAAA=
        """.filter { !$0.isWhitespace }
        return """
        (() => {
          const original = window.fetch.bind(window);
          const bytes = Uint8Array.from(atob('\(epub)'), character => character.charCodeAt(0));
          const generation = 'a'.repeat(64);
          window.fixturePosition = {section: \(section), fraction: 0};
          window.fetch = async (input, options = {}) => {
            const url = new URL(input instanceof Request ? input.url : input, location.href);
            if (url.origin !== location.origin) throw new Error('External network unavailable in this fixture');
            if (!url.pathname.startsWith('/api/')) return original(input, options);
            const json = value => new Response(JSON.stringify(value), {headers: {'Content-Type':'application/json'}});
            if (url.pathname === '/api/session') return json({configured:true, authenticated:true, readerOnly:true, csrfToken:'phone-fixture'});
            if (url.pathname === '/api/reading') return json({nextOffset:null, items:[{id:'phone-fixture', title:'Two mornings',
              name:'Two mornings.epub', format:'epub', sizeBytes:String(bytes.length), generation, position:window.fixturePosition}]});
            if (url.pathname === '/api/reading/phone-fixture/content' && url.searchParams.get('generation') === generation)
              return new Response(bytes, {headers:{'Content-Type':'application/epub+zip'}});
            if (url.pathname === '/api/reading/phone-fixture/progress' && options.method === 'PUT' &&
                new Headers(options.headers).get('x-csrf-token') === 'phone-fixture') {
              const saved = JSON.parse(options.body);
              if (saved.generation !== generation) return new Response(null, {status:409});
              window.fixturePosition = {section:saved.section, fraction:saved.fraction};
              return new Response(null, {status:204});
            }
            return new Response(null, {status:403});
          };
        })();
        """
    }
}

@MainActor private final class HostedReader {
    let web: WKWebView
    private let coordinator: ReaderWebView.Coordinator

    init(session: CinemaReaderSession, fixture: String? = nil) throws {
        let window = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows).first { $0.isKeyWindow })
        coordinator = ReaderWebView.Coordinator(session: session, loaded: {}, failed: { XCTFail($0) })
        web = coordinator.makeWebView()
        if let fixture {
            web.configuration.userContentController.addUserScript(
                WKUserScript(source: fixture, injectionTime: .atDocumentStart, forMainFrameOnly: true)
            )
        }
        web.frame = window.bounds
        window.addSubview(web)
        coordinator.install(session, into: web)
    }

    func close() {
        ReaderWebView.dismantleUIView(web, coordinator: coordinator)
        web.removeFromSuperview()
    }

    func until(_ expression: String, step: String) async throws {
        let deadline = Date().addingTimeInterval(25)
        repeat {
            if (try? await web.evaluateJavaScript("Boolean(" + expression + ")")) as? Bool == true { return }
            try await Task.sleep(for: .milliseconds(200))
        } while Date() < deadline
        throw NSError(domain: "RavanHostedReaderTests", code: 1, userInfo: [NSLocalizedDescriptionKey: step + " timed out"])
    }

    func openBook(expectChapter: String) async throws {
        try await until("document.querySelector('[data-book-id]')", step: "Hosted shelf")
        _ = try await web.evaluateJavaScript("document.querySelector('[data-book-id]').click(); true")
        try await until("document.querySelector('.reading-prose')?.textContent.includes('\(expectChapter)')", step: expectChapter)
    }
}
#endif
#endif
