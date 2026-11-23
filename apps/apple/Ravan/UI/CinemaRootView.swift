import SwiftUI
import UniformTypeIdentifiers
#if PAIRED
import CryptoKit
#endif

enum CinemaDestination: String, CaseIterable, Identifiable {
    case library, watchlist
    #if PAIRED
    case reading
    #endif
    case cinema
    var id: Self { self }

    var title: LocalizedStringResource {
        switch self {
        case .library: "Library"
        case .watchlist: "Watchlist"
        #if PAIRED
        case .reading: "Reading Room"
        #endif
        case .cinema: "Your Cinema"
        }
    }

    var shortcut: KeyEquivalent {
        switch self {
        case .library: "1"
        case .watchlist: "2"
        #if PAIRED
        case .reading: "4"
        #endif
        case .cinema: "3"
        }
    }

    var icon: String {
        switch self {
        case .library: "books.vertical"
        case .watchlist: "bookmark"
        #if PAIRED
        case .reading: "book"
        #endif
        case .cinema: "person.crop.rectangle"
        }
    }
}

enum CinemaColumnLayout {
    case stacked, twoColumns, threeColumns

    init(width: CGFloat, regular: Bool, typeScale: CGFloat) {
        let scale = max(1, typeScale)
        if regular && width >= 950 * scale { self = .threeColumns }
        else if regular && width >= 720 * scale { self = .twoColumns }
        else { self = .stacked }
    }
}

struct CinemaRootView: View {
    @Environment(LocalLibrary.self) private var library
    @Environment(PlaybackCoordinator.self) private var player
    @ScaledMetric(relativeTo: .body) private var typeScale: CGFloat = 1
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Namespace private var sidebarSelection
    #if PAIRED
    @Environment(PairedCinema.self) private var paired
    @State private var connectionPresented = false
    #endif

    @SceneStorage(CinemaLaunch.sceneKey("cinema.tab")) private var savedDestination = CinemaDestination.library.rawValue
    @SceneStorage(CinemaLaunch.sceneKey("cinema.library.selection")) private var librarySelection = ""
    @SceneStorage(CinemaLaunch.sceneKey("cinema.watchlist.selection")) private var watchlistSelection = ""
    @SceneStorage(CinemaLaunch.sceneKey("cinema.library.search")) private var librarySearch = ""
    @SceneStorage(CinemaLaunch.sceneKey("cinema.watchlist.search")) private var watchlistSearch = ""
    @State private var columns = NavigationSplitViewVisibility.all
    @State private var filePickerPresented = false
    @State private var replacing: LocalFilm?
    @State private var openingTask: Task<Void, Never>?
    @State private var problem: String?

    private var destination: CinemaDestination { CinemaDestination(rawValue: savedDestination) ?? .library }

    private var showCinema: Bool {
        #if PAIRED
        library.hasEntered || paired.isConnected
        #else
        library.hasEntered
        #endif
    }

    var body: some View {
        GeometryReader { proxy in
            if showCinema {
                let scale = max(1, typeScale)
                let layout = CinemaColumnLayout(width: proxy.size.width, regular: horizontalSizeClass == .regular, typeScale: scale)
                #if PAIRED
                if destination == .reading && layout != .stacked {
                    NavigationSplitView {
                        sidebar
                            .navigationSplitViewColumnWidth(min: 175 * scale, ideal: 205 * scale, max: 245 * scale)
                    } detail: {
                        CinemaReadingRoom(connect: connect)
                    }
                    .navigationSplitViewStyle(.balanced)
                } else {
                    cinemaLayout(layout, scale: scale)
                }
                #else
                cinemaLayout(layout, scale: scale)
                #endif
            } else {
                CinemaWelcomeView(openFile: { chooseFile() }, openConnection: connect, playSample: { play(library.sample) }, openReading: openReading)
            }
        }
        .onChange(of: library.films.map(\.id), initial: true) { _, ids in
            for tab in [CinemaDestination.library, .watchlist] {
                let binding = selection(tab)
                if let id = UUID(uuidString: binding.wrappedValue), !ids.contains(id) { binding.wrappedValue = "" }
                #if !PAIRED
                if !binding.wrappedValue.isEmpty, UUID(uuidString: binding.wrappedValue) == nil { binding.wrappedValue = "" }
                #endif
            }
        }
        .tint(CinemaTheme.accent)
        .foregroundStyle(CinemaTheme.ink)
        .background(CinemaTheme.background)
        .fileImporter(isPresented: $filePickerPresented, allowedContentTypes: [.movie, .video, .mpeg4Movie, .quickTimeMovie]) { result in
            importFile(result)
        }
        #if PAIRED
        .sheet(isPresented: $connectionPresented) { ServerConnectionView() }
        .onChange(of: paired.isConnected) { _, connected in
            if connected { library.hasEntered = true }
            else {
                if librarySelection.hasPrefix("remote/") { librarySelection = "" }
                if watchlistSelection.hasPrefix("remote/") { watchlistSelection = "" }
            }
        }
        #endif
        .disabled(openingTask != nil)
        .accessibilityHidden(openingTask != nil)
        .overlay {
            if openingTask != nil {
                VStack(spacing: 12) {
                    ProgressView("Opening film…")
                    Button("Cancel", role: .cancel) {
                        openingTask?.cancel()
                        openingTask = nil
                    }
                    .frame(minHeight: 44)
                    .keyboardShortcut(.cancelAction)
                }
                .padding(18)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
                .accessibilityElement(children: .contain)
                .accessibilityAddTraits(.isModal)
            }
        }
        .alert("Film could not be opened", isPresented: Binding(get: { problem != nil }, set: { if !$0 { problem = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(problem ?? "") }
        .modifier(LocalPlayerHost())
        #if PAIRED
        .modifier(ServerPlaybackHost {
            librarySelection = ""
            savedDestination = CinemaDestination.library.rawValue
        })
        #endif
    }

    @ViewBuilder private func cinemaLayout(_ layout: CinemaColumnLayout, scale: CGFloat) -> some View {
        switch layout {
        case .threeColumns:
            NavigationSplitView(columnVisibility: $columns) {
                sidebar
                    .navigationSplitViewColumnWidth(min: 175 * scale, ideal: 205 * scale, max: 245 * scale)
            } content: {
                mainColumn(destination, rows: true)
                    .navigationSplitViewColumnWidth(min: 260 * scale, ideal: 300 * scale, max: 395 * scale)
            } detail: {
                selectedDetail(destination: destination)
            }
            .navigationSplitViewStyle(.balanced)
        case .twoColumns:
            NavigationSplitView {
                mainColumn(destination, rows: true)
                    .toolbar { ToolbarItem(placement: .topBarLeading) { destinationMenu } }
                    .navigationSplitViewColumnWidth(min: 245 * scale, ideal: 290 * scale, max: 375 * scale)
            } detail: {
                selectedDetail(destination: destination)
            }
            .navigationSplitViewStyle(.balanced)
        case .stacked:
            VStack(spacing: 0) {
                // Scene storage retains each destination’s path, search text and film scroll anchor.
                NavigationStack(path: navigationPath(destination)) {
                    mainColumn(destination, rows: false)
                        .navigationDestination(for: String.self) { route in detail(route) }
                }
                .id(destination)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .clipped()

                CinemaTaskBar(selection: destination) { savedDestination = $0.rawValue }
                    .layoutPriority(1)
            }
        }
    }

    private func openReading() {
        #if PAIRED
        savedDestination = CinemaDestination.reading.rawValue
        library.hasEntered = true
        #endif
    }

    private var sidebar: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 25) {
                CinemaWordmark().padding(.leading, 12)
                VStack(spacing: 4) {
                    ForEach(CinemaDestination.allCases) { tab in
                        Button {
                            savedDestination = tab.rawValue
                        } label: {
                            Label {
                                Text(tab.title)
                            } icon: {
                                Image(systemName: tab.icon)
                                    .symbolVariant(tab == destination ? .fill : .none)
                                    .foregroundStyle(tab == destination ? CinemaTheme.accent : CinemaTheme.muted)
                            }
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                            .padding(.horizontal, 12)
                            .background {
                                if tab == destination {
                                    RoundedRectangle(cornerRadius: 8).fill(CinemaTheme.panel)
                                        .matchedGeometryEffect(id: "selected destination", in: sidebarSelection)
                                }
                            }
                            .contentShape(.rect)
                        }
                        .buttonStyle(.plain)
                        .keyboardShortcut(tab.shortcut, modifiers: .command)
                        .accessibilityAddTraits(tab == destination ? .isSelected : [])
                        .accessibilityIdentifier("destination." + tab.rawValue)
                    }
                }
                .animation(reduceMotion ? nil : .easeInOut(duration: 0.18), value: destination)
            }
            .padding(14)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(CinemaTheme.background)
    }

    private var destinationMenu: some View {
        Menu {
            ForEach(CinemaDestination.allCases) { tab in
                Button { savedDestination = tab.rawValue } label: { Label(tab.title, systemImage: tab.icon) }
                    .keyboardShortcut(tab.shortcut, modifiers: .command)
                    .accessibilityAddTraits(tab == destination ? .isSelected : [])
            }
        } label: { Label("Destinations", systemImage: "sidebar.left") }
        .accessibilityIdentifier("destinations.menu")
    }

    @ViewBuilder private func mainColumn(_ tab: CinemaDestination, rows: Bool) -> some View {
        switch tab {
        #if PAIRED
        case .reading:
            CinemaReadingRoom(connect: connect)
        #endif
        case .cinema:
            YourCinemaView(openFile: { chooseFile() })
        case .library, .watchlist:
            let selected = selection(tab)
            CinemaCollectionView(
                savedOnly: tab == .watchlist,
                rows: rows, query: tab == .watchlist ? $watchlistSearch : $librarySearch,
                selected: selected.wrappedValue,
                selectFilm: { selected.wrappedValue = $0.uuidString },
                selectRemote: { id in
                    #if PAIRED
                    if let prefix = remotePrefix { selected.wrappedValue = prefix + id }
                    #endif
                },
                remoteRoute: { id in
                    #if PAIRED
                    return remotePrefix.map { $0 + id }
                    #else
                    return nil
                    #endif
                },
                playFilm: { play($0) }, openFile: { chooseFile() }
            )
        }
    }

    private func selection(_ tab: CinemaDestination) -> Binding<String> {
        tab == .watchlist ? $watchlistSelection : $librarySelection
    }

    private func navigationPath(_ tab: CinemaDestination) -> Binding<[String]> {
        let selected = selection(tab)
        guard tab == .library || tab == .watchlist else { return .constant([]) }
        return Binding(get: { selected.wrappedValue.isEmpty ? [] : [selected.wrappedValue] },
                       set: { selected.wrappedValue = $0.last ?? "" })
    }

    @ViewBuilder private func selectedDetail(destination: CinemaDestination) -> some View {
        let route = selection(destination).wrappedValue
        if destination == .cinema {
            CinemaInfoPanel()
        } else if !route.isEmpty {
            detail(route)
        } else if destination == .library && librarySearch.isEmpty {
            detail(library.sample.id.uuidString)
        } else {
            ContentUnavailableView("Select a film", systemImage: "film", description: Text("Choose a title to see its screening card."))
                .frame(maxWidth: .infinity, maxHeight: .infinity).background(CinemaTheme.background)
        }
    }

    #if PAIRED
    // Scene storage needs a scoped route, but does not need to retain a server address or device identity.
    private var remotePrefix: String? {
        paired.scopeID.map { "remote/" + SHA256.hash(data: Data($0.utf8)).map { String(format: "%02x", $0) }.joined() + "/" }
    }
    #endif

    @ViewBuilder private func detail(_ route: String) -> some View {
        if let id = UUID(uuidString: route), let film = library.films.first(where: { $0.id == id }) {
            LocalScreeningView(film: film, play: { play(film, fromBeginning: $0) }, locate: { chooseFile(film) }, forget: {
                library.forget(film)
                if librarySelection == route { librarySelection = "" }
                if watchlistSelection == route { watchlistSelection = "" }
            })
        } else {
            #if PAIRED
            if let prefix = remotePrefix, route.hasPrefix(prefix) {
                ServerScreeningView(movieID: String(route.dropFirst(prefix.count))).id(route)
            } else { unavailableFilm }
            #else
            unavailableFilm
            #endif
        }
    }

    private var unavailableFilm: some View {
        ContentUnavailableView("Film unavailable", systemImage: "film", description: Text("Choose another film from your library."))
    }

    private func connect() {
        #if PAIRED
        connectionPresented = true
        #endif
    }

    private func chooseFile(_ film: LocalFilm? = nil) {
        guard openingTask == nil else { return }
        replacing = film
        filePickerPresented = true
    }

    private func importFile(_ result: Result<URL, Error>) {
        let original = replacing
        replacing = nil
        switch result {
        case .success(let url):
            startOpening {
                let film = try await library.importFilm(url, replacing: original)
                guard original == nil else { return }
                try await player.play(film, library: library)
                savedDestination = CinemaDestination.library.rawValue
                librarySelection = film.id.uuidString
                library.hasEntered = true
            }
        case .failure(let error): present(error)
        }
    }

    private func play(_ film: LocalFilm, fromBeginning: Bool = false) {
        let entering = !showCinema
        startOpening {
            try await player.play(film, library: library, fromBeginning: fromBeginning)
            if entering {
                savedDestination = CinemaDestination.library.rawValue
                librarySelection = ""
                librarySearch = ""
            }
            library.hasEntered = true
        }
    }

    private func startOpening(_ operation: @escaping @MainActor () async throws -> Void) {
        guard openingTask == nil else { return }
        openingTask = Task { @MainActor in
            do { try await operation() }
            catch { if !Task.isCancelled { present(error) } }
            // A cancelled file provider can finish after another film has started opening.
            if !Task.isCancelled { openingTask = nil }
        }
    }

    private func present(_ error: Error) {
        let cocoa = error as NSError
        guard !(error is CancellationError), !(cocoa.domain == NSCocoaErrorDomain && cocoa.code == NSUserCancelledError) else { return }
        // System error descriptions may include a provider's private filesystem path.
        problem = (error as? FilmError)?.errorDescription ?? String(localized: "Choose the file again in Files and check that it has downloaded to this device.")
    }
}
