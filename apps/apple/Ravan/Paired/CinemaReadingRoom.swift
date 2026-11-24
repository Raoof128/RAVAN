#if PAIRED
import SafariServices
import SwiftUI
import WebKit

struct CinemaReadingRoom: View {
    let connect: () -> Void
    @Environment(PairedCinema.self) private var cinema

    var body: some View {
        ReadingRoomScreen(cinema: cinema, connect: connect)
            // Disconnecting or changing the grant destroys the previous account's in-memory web view.
            .id(cinema.canRead ? cinema.scopeID : nil)
    }
}

private struct ReadingRoomScreen: View {
    let cinema: PairedCinema
    let connect: () -> Void
    @Environment(\.scenePhase) private var phase
    @State private var website: URL?
    @State private var session: CinemaReaderSession?
    @State private var failure: String?
    @State private var revision = 0
    @State private var pageRevision = 0
    @State private var loaded = false

    private var websiteOrigin: URL {
        if let address = cinema.account?.origin, let origin = try? CinemaURL.origin(address) { return origin }
        return RavanWebsite.origin
    }

    var body: some View {
        Group {
            if let session, cinema.canRead {
                ReaderWebView(session: session, loaded: { loaded = true }, failed: showFailure)
                    .id(pageRevision)
                    .accessibilityIdentifier("reading.content")
                    .overlay { if !loaded { opening } }
            } else if cinema.canRead && failure == nil {
                opening
            } else {
                introduction
            }
        }
        .background(CinemaTheme.background)
        .background { ReaderWebsitePresenter(url: $website).frame(width: 0, height: 0) }
        .task(id: revision) { await openAndRenew() }
        .onChange(of: phase) { _, phase in
            guard phase == .active, let session, session.expires.timeIntervalSinceNow < 300 else { return }
            revision += 1
        }
    }

    private var opening: some View {
        ProgressView("Opening your shelf…")
            .foregroundStyle(CinemaTheme.muted)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(CinemaTheme.background)
    }

    private var introduction: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Image(systemName: "book.pages").font(.largeTitle).foregroundStyle(CinemaTheme.accent)
                    .accessibilityHidden(true)
                Text("Reading Room")
                    .font(CinemaTheme.filmFont(44, relativeTo: .largeTitle))
                    .accessibilityAddTraits(.isHeader)
                Text("Read EPUB books, PDFs and comics from your Drive. Your place is saved on the website.")
                    .font(.body).foregroundStyle(CinemaTheme.ink)
                Group {
                    if let failure { Text(verbatim: failure) }
                    else if cinema.isConnected { Text("Sign in to this cinema’s website to read with your account.") }
                    else { Text("Connect your cinema, or sign in to read on its website.") }
                }
                .font(.subheadline).foregroundStyle(CinemaTheme.muted)
                .accessibilityIdentifier("reading.status")
                VStack(spacing: 12) {
                    if cinema.canRead {
                        Button("Try Again") { failure = nil; revision += 1 }
                            .buttonStyle(CinemaPrimaryButtonStyle()).accessibilityIdentifier("reading.retry")
                    } else if !cinema.isConnected {
                        Button(action: connect) { Label("Connect to RAVĀN", systemImage: "link") }
                            .buttonStyle(CinemaPrimaryButtonStyle()).accessibilityIdentifier("reading.connect")
                    }
                    if cinema.isConnected && !cinema.canRead {
                        websiteButton.buttonStyle(CinemaPrimaryButtonStyle())
                    } else {
                        websiteButton.buttonStyle(CinemaSecondaryButtonStyle())
                    }
                }
            }
            .frame(maxWidth: 540, alignment: .leading)
            .padding(24).padding(.vertical, 16).frame(maxWidth: .infinity)
        }
    }

    private var websiteButton: some View {
        Button { website = RavanWebsite.reader(at: websiteOrigin) } label: {
            Label("Open website reader", systemImage: "safari")
        }
        .accessibilityIdentifier("reading.website")
        .accessibilityHint(Text(verbatim: websiteOrigin.host() ?? ""))
    }

    private func showFailure(_ message: String) {
        failure = message
        session = nil
        loaded = false
    }

    @MainActor private func openAndRenew() async {
        guard cinema.canRead else { return }
        do {
            while !Task.isCancelled && failure == nil {
                if let current = session, current.expires <= .now {
                    // After a long suspension the web page's CSRF token has expired too.
                    session = nil
                    pageRevision += 1
                    loaded = false
                }
                let next: CinemaReaderSession
                do { next = try await cinema.readerSession() }
                catch {
                    // Keep an open book on screen during a brief network interruption before its cookie expires.
                    if let current = session, current.expires > .now, error is URLError {
                        try await Task.sleep(for: .seconds(min(20, current.expires.timeIntervalSinceNow)))
                        continue
                    }
                    throw error
                }
                try Task.checkCancellation()
                guard failure == nil else { return }
                session = next
                // The server preserves the CSRF token on early renewal so the open book keeps its place.
                try await Task.sleep(for: .seconds(max(1, next.expires.timeIntervalSinceNow - 300)))
            }
        } catch CinemaFailure.http(404, _, _) {
            guard !Task.isCancelled else { return }
            showFailure(String(localized: "This cinema supports reading through its website."))
        } catch {
            guard !Task.isCancelled else { return }
            showFailure(cinemaMessage(error))
        }
    }
}

struct ReaderWebView: UIViewRepresentable {
    let session: CinemaReaderSession
    let loaded: () -> Void
    let failed: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(session: session, loaded: loaded, failed: failed) }

    func makeUIView(context: Context) -> WKWebView {
        context.coordinator.makeWebView()
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.install(session, into: webView)
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        coordinator.currentCookie = nil
        webView.navigationDelegate = nil
        webView.stopLoading()
    }

    @MainActor final class Coordinator: NSObject, WKNavigationDelegate {
        private let scope: CinemaReaderSession
        private let loaded: () -> Void
        private let failed: (String) -> Void
        var currentCookie: HTTPCookie?
        private var started = false
        private var opened = false

        init(session: CinemaReaderSession, loaded: @escaping () -> Void, failed: @escaping (String) -> Void) {
            self.scope = session
            self.loaded = loaded
            self.failed = failed
        }

        func makeWebView() -> WKWebView {
            let configuration = WKWebViewConfiguration()
            configuration.websiteDataStore = .nonPersistent()
            configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
            let view = WKWebView(frame: .zero, configuration: configuration)
            view.navigationDelegate = self
            view.allowsBackForwardNavigationGestures = true
            view.allowsLinkPreview = false
            view.isOpaque = false
            return view
        }

        func install(_ session: CinemaReaderSession, into view: WKWebView) {
            guard currentCookie?.value != session.cookie.value else { return }
            currentCookie = session.cookie
            view.configuration.websiteDataStore.httpCookieStore.setCookie(session.cookie) { [weak self, weak view] in
                guard let self, let view, self.currentCookie?.value == session.cookie.value, !self.started else { return }
                self.started = true
                let request = URLRequest(url: session.page, cachePolicy: .reloadIgnoringLocalCacheData)
                #if RAVAN_UI_TESTING
                if CinemaLaunch.testSession != nil && ProcessInfo.processInfo.arguments.contains("--ravan-approve-fixture-in-background") {
                    FixtureCinema.loadReader(request, cookie: session.cookie, in: view)
                    return
                }
                #endif
                view.load(request)
            }
        }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            let allowed = action.targetFrame?.isMainFrame == true && !action.shouldPerformDownload &&
                action.request.url.map { scope.permits($0, requireReadingRoute: opened) } == true
            if action.targetFrame?.isMainFrame == true && !opened && !allowed { unavailable() }
            return allowed ? .allow : .cancel
        }

        func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse) async -> WKNavigationResponsePolicy {
            let http = response.response as? HTTPURLResponse
            let allowed = response.isForMainFrame && response.canShowMIMEType &&
                http?.mimeType == "text/html" && http.map { (200..<300).contains($0.statusCode) } == true &&
                http?.url.map { scope.permits($0, requireReadingRoute: false) } == true
            if response.isForMainFrame && !allowed { unavailable() }
            return allowed ? .allow : .cancel
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            opened = true
            loaded()
        }
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { unavailable() }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { handle(error) }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            handle(error)
        }

        private func handle(_ error: Error) {
            let detail = error as NSError
            if detail.domain == NSURLErrorDomain && detail.code == NSURLErrorCancelled { return }
            unavailable()
        }

        private func unavailable() {
            failed(String(localized: "The reading room could not open. Try again or open the website reader."))
        }
    }
}

/// Safari owns the sign-in UI and its cookies. Present it directly so its security and dismissal controls stay visible.
private struct ReaderWebsitePresenter: UIViewControllerRepresentable {
    @Binding var url: URL?

    func makeUIViewController(context: Context) -> Host { Host() }

    func updateUIViewController(_ host: Host, context: Context) {
        host.finished = { url = nil }
        host.requested = url
        host.presentIfNeeded()
    }

    static func dismantleUIViewController(_ host: Host, coordinator: ()) {
        host.finished = nil
        host.requested = nil
        host.browser?.dismiss(animated: false)
    }

    final class Host: UIViewController, @MainActor SFSafariViewControllerDelegate, UIAdaptivePresentationControllerDelegate {
        var requested: URL?
        var finished: (() -> Void)?
        weak var browser: SFSafariViewController?

        override func viewDidAppear(_ animated: Bool) {
            super.viewDidAppear(animated)
            presentIfNeeded()
        }

        func presentIfNeeded() {
            guard let requested, browser == nil, viewIfLoaded?.window != nil else { return }
            let controller = SFSafariViewController(url: requested)
            controller.delegate = self
            browser = controller
            present(controller, animated: true)
            controller.presentationController?.delegate = self
        }

        func safariViewControllerDidFinish(_ controller: SFSafariViewController) { finish() }
        func presentationControllerDidDismiss(_ presentationController: UIPresentationController) { finish() }

        private func finish() {
            requested = nil
            browser = nil
            finished?()
        }
    }
}
#endif
