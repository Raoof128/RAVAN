import SwiftUI
import UIKit

struct CinemaCollectionView: View {
    let savedOnly: Bool
    let rows: Bool
    @Binding var query: String
    let selected: String
    let selectFilm: (UUID) -> Void
    let selectRemote: (String) -> Void
    let remoteRoute: (String) -> String?
    let playFilm: (LocalFilm) -> Void
    let openFile: () -> Void
    @Environment(LocalLibrary.self) private var library
    @Environment(\.dynamicTypeSize) private var typeSize
    #if PAIRED
    @Environment(PairedCinema.self) private var paired
    @Environment(\.cinemaWindowID) private var window
    private var preferredAudio: String { CinemaLanguages.shared.audio }
    @State private var remoteRecent: ServerMovie?
    @State private var recentIssue: String?
    @State private var retryRecent = 0
    @State private var resuming = false
    private var recentRequest: [String] {
        [paired.scopeID ?? "", String(paired.changed), String(retryRecent), String(!savedOnly && query.isEmpty)]
    }
    #endif
    @SceneStorage(CinemaLaunch.sceneKey("collection.library.scroll")) private var libraryAnchor: String?
    @SceneStorage(CinemaLaunch.sceneKey("collection.watchlist.scroll")) private var watchlistAnchor: String?
    @State private var searchFocusRequest = 0
    @ScaledMetric(relativeTo: .body) private var searchLineHeight: CGFloat = 26
    @FocusState private var focusedFilm: UUID?

    private var scrollAnchor: Binding<UUID?> {
        let stored = savedOnly ? $watchlistAnchor : $libraryAnchor
        return Binding(get: { stored.wrappedValue.flatMap(UUID.init(uuidString:)) },
                       set: { stored.wrappedValue = $0?.uuidString })
    }

    private var films: [LocalFilm] {
        library.films.filter { film in
            (!savedOnly || film.isFavourite) && (query.isEmpty || film.title.localizedStandardContains(query))
        }
    }

    private var resumeFilm: LocalFilm? {
        guard !savedOnly, query.isEmpty, !rows else { return nil }
        return films.filter { $0.position > 0 && !$0.needsRelink }
            .max { ($0.lastPlayed ?? .distantPast) < ($1.lastPlayed ?? .distantPast) }
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 21) {
                HStack(alignment: .firstTextBaseline) {
                    Text(savedOnly ? "Watchlist" : "Library")
                        .font(CinemaTheme.filmFont(44, relativeTo: .largeTitle)).accessibilityAddTraits(.isHeader)
                    Spacer()
                    if !savedOnly {
                        Button(action: openFile) {
                            Image(systemName: "folder.badge.plus").frame(width: 44, height: 44)
                        }
                        .accessibilityLabel("Open a Film in Files").accessibilityIdentifier("library.files")
                    }
                }
                searchField
                #if PAIRED
                if !savedOnly && query.isEmpty, let remote = newestRemote {
                    CinemaSectionTitle(text: "Continue watching")
                    VStack(alignment: .leading, spacing: 10) {
                        if !rows && !typeSize.isAccessibilitySize {
                            ServerPoster(movie: remote, wide: true).contentShape(.rect)
                                .onTapGesture { selectRemote(remote.id) }.accessibilityHidden(true)
                        }
                        Button { selectRemote(remote.id) } label: {
                            VStack(alignment: .leading, spacing: 5) {
                                Text(verbatim: remote.title).font(CinemaTheme.filmFont(31, relativeTo: .title2))
                                    .foregroundStyle(CinemaTheme.ink)
                                Text("Personal server").font(.caption).foregroundStyle(CinemaTheme.muted)
                            }
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(.rect)
                        }.buttonStyle(.plain)
                        Button { Task { await resumeRemote(remote) } } label: {
                            Label("Resume at \(CinemaTime.stamp(Double(remote.resumeMs) / 1000))", systemImage: "play.fill")
                        }.buttonStyle(CinemaPrimaryButtonStyle()).disabled(resuming || paired.playback.busy)
                            .accessibilityIdentifier("continue.resume")
                    }
                } else if let resumeFilm {
                    CinemaSectionTitle(text: "Continue watching")
                    resumeCard(resumeFilm)
                }
                if !savedOnly && query.isEmpty, let recentIssue {
                    Text(recentIssue).font(.footnote)
                    Button("Retry Continue Watching") { retryRecent += 1 }.frame(minHeight: 44)
                }
                #else
                if let resumeFilm {
                    CinemaSectionTitle(text: "Continue watching")
                    resumeCard(resumeFilm)
                }
                #endif
                if films.isEmpty {
                    emptyState
                } else {
                    CinemaSectionTitle(text: savedOnly ? "Saved on this device" : "Films on this device")
                    if rows || typeSize.isAccessibilitySize {
                        LazyVStack(spacing: 6) {
                            ForEach(films, id: \.id) { film in
                                FilmDestinationLink(route: rows ? nil : film.id.uuidString, select: { selectFilm(film.id) }) {
                                    HStack(spacing: 13) {
                                        if !typeSize.isAccessibilitySize {
                                            CinemaPoster(title: film.title, isSample: film.isSample)
                                                .frame(width: 52)
                                        }
                                        filmLabel(film)
                                        Spacer(minLength: 4)
                                        Image(systemName: "chevron.right").font(.caption).foregroundStyle(CinemaTheme.muted)
                                    }
                                    .padding(8).frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                                    .background(selected == film.id.uuidString ? CinemaTheme.panel : .clear, in: RoundedRectangle(cornerRadius: 8))
                                    .contentShape(.rect)
                                }
                                .buttonStyle(.plain)
                                .focused($focusedFilm, equals: film.id)
                                .accessibilityIdentifier(film.isSample ? "film.sample" : "film." + film.id.uuidString)
                            }
                        }
                        .scrollTargetLayout()
                        .onMoveCommandForFilms(films: films.map(\.id), focused: $focusedFilm)
                    } else {
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 136, maximum: 245), spacing: 15)],
                                  alignment: .leading, spacing: 18) {
                            ForEach(films, id: \.id) { film in
                                VStack(alignment: .leading, spacing: 7) {
                                    posterLink(title: film.title, sample: film.isSample) { selectFilm(film.id) }
                                    FilmDestinationLink(route: rows ? nil : film.id.uuidString, select: { selectFilm(film.id) }) {
                                        filmLabel(film)
                                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                                            .contentShape(.rect)
                                    }
                                    .buttonStyle(.plain)
                                    .accessibilityIdentifier(film.isSample ? "film.sample" : "film." + film.id.uuidString)
                                }
                            }
                        }
                        .scrollTargetLayout()
                    }
                }
                #if PAIRED
                if paired.isConnected {
                    Divider()
                    ServerCollectionView(query: query, savedOnly: savedOnly, rows: rows, route: remoteRoute, onSelect: selectRemote)
                }
                #endif
            }
            .frame(maxWidth: 1000, alignment: .leading)
            .padding(.horizontal, rows ? 16 : 22).padding(.vertical, 16)
            .frame(maxWidth: .infinity)
        }
        #if PAIRED
        .refreshable { if paired.isConnected { paired.changed += 1 } }
        .task(id: recentRequest) {
            remoteRecent = nil
            recentIssue = nil
            guard paired.isConnected, paired.discovery?.features["continueWatching"] == true,
                  !savedOnly, query.isEmpty else { return }
            do {
                let data = try await paired.data("/api/continue-watching")
                let page = try JSONDecoder().decode(CinemaPage.self, from: data)
                try Task.checkCancellation()
                remoteRecent = page.items.first
            } catch { if !Task.isCancelled { recentIssue = cinemaMessage(error) } }
        }
        #endif
        .background(CinemaTheme.background)
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarVisibility(rows ? .automatic : .hidden, for: .navigationBar)
        .scrollPosition(id: scrollAnchor)
        .onChange(of: focusedFilm) { _, id in
            if let id { scrollAnchor.wrappedValue = id }
        }
        .scrollDismissesKeyboard(.interactively)
        .background {
            // Give keyboard users a command without adding a second visible search affordance.
            Button("Search") { searchFocusRequest += 1 }
                .keyboardShortcut("f").hidden().accessibilityHidden(true)
        }
    }

    #if PAIRED
    private var newestRemote: ServerMovie? {
        guard paired.isConnected, let remoteRecent, remoteRecent.available, remoteRecent.resumeMs > 0 else { return nil }
        if let date = resumeFilm?.lastPlayed,
           date.timeIntervalSince1970 >= Double(remoteRecent.lastPlayedAtMs ?? 0) / 1000 { return nil }
        return remoteRecent
    }

    private func resumeRemote(_ card: ServerMovie) async {
        guard !resuming else { return }
        resuming = true
        defer { resuming = false }
        let scope = paired.scopeID
        do {
            // The recency index is a summary. Resolve the current edition before opening a stream.
            let data = try await paired.data("/api/movies/" + CinemaURL.id(card.id))
            let film = try JSONDecoder().decode(ServerMovie.self, from: data)
            guard scope == paired.scopeID, film.id == card.id else { return }
            guard let edition = film.editions?.first(where: { film.resumeOffset(for: $0) > 0 }) else {
                selectRemote(film.id)
                return
            }
            recentIssue = nil
            let request = CinemaPlayRequest(movieId: film.id, startMs: film.resumeOffset(for: edition), editionId: edition.id,
                                            generation: edition.generation, quality: "auto",
                                            audioTrack: edition.preferredAudioIndex(language: preferredAudio))
            await paired.playback.play(request, title: film.title, window: window, on: paired)
        } catch { if scope == paired.scopeID && !Task.isCancelled { recentIssue = cinemaMessage(error) } }
    }
    #endif

    private var searchField: some View {
        HStack {
            Image(systemName: "magnifyingglass").foregroundStyle(CinemaTheme.muted).accessibilityHidden(true)
            ZStack(alignment: .leading) {
                if query.isEmpty {
                    Text("Search").font(.body).foregroundStyle(CinemaTheme.muted)
                        .fixedSize(horizontal: false, vertical: true)
                        .allowsHitTesting(false).accessibilityHidden(true)
                }
                CinemaTextInput(text: $query, focusRequest: searchFocusRequest,
                                label: savedOnly ? String(localized: "Search watchlist") : String(localized: "Search library"),
                                identifier: "collection.search")
                    .frame(height: max(48, searchLineHeight + 12))
            }
            if !query.isEmpty {
                Button { query = "" } label: {
                    Image(systemName: "xmark.circle.fill").frame(minWidth: 44, minHeight: 44)
                }
                .accessibilityLabel("Clear search")
                .accessibilityIdentifier("collection.search.clear")
            }
        }
        .padding(.horizontal, 12).frame(minHeight: 46)
        .background(CinemaTheme.panel, in: RoundedRectangle(cornerRadius: 9))
    }

    private func filmLabel(_ film: LocalFilm) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(verbatim: film.title).font(CinemaTheme.filmFont(24, relativeTo: .headline))
                .foregroundStyle(CinemaTheme.ink).lineLimit(typeSize.isAccessibilitySize ? nil : 2)
            Text(film.isSample ? "Sample film" : "Files")
                .font(.caption).foregroundStyle(CinemaTheme.muted)
            if film.needsRelink {
                Label("File needs locating", systemImage: "folder.badge.questionmark")
                    .font(.caption).foregroundStyle(CinemaTheme.muted)
            }
            if film.position > 0 {
                Text("Paused at \(CinemaTime.stamp(film.position))")
                    .font(.caption).foregroundStyle(CinemaTheme.muted)
            }
        }
        .multilineTextAlignment(.leading)
    }

    private func resumeCard(_ film: LocalFilm) -> some View {
        VStack(alignment: .leading, spacing: 11) {
            if !typeSize.isAccessibilitySize {
                posterLink(title: film.title, sample: film.isSample, wide: true) { selectFilm(film.id) }
            }
            FilmDestinationLink(route: rows ? nil : film.id.uuidString, select: { selectFilm(film.id) }) {
                Text(verbatim: film.title).font(CinemaTheme.filmFont(31, relativeTo: .title2))
                    .foregroundStyle(CinemaTheme.ink)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(.rect)
            }
            .buttonStyle(.plain)
            Button { playFilm(film) } label: {
                Label("Resume at \(CinemaTime.stamp(film.position))", systemImage: "play.fill")
            }
            .buttonStyle(CinemaPrimaryButtonStyle()).accessibilityIdentifier("continue.resume")
        }
    }

    private func posterLink(title: String, sample: Bool, wide: Bool = false, select: @escaping () -> Void) -> some View {
        // The adjacent named button provides keyboard and VoiceOver access. Keep the decorative
        // poster tappable without reporting its artwork as part of the text's accessibility frame.
        CinemaPoster(title: title, isSample: sample, wide: wide)
            .contentShape(.rect).onTapGesture(perform: select).accessibilityHidden(true)
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !query.isEmpty {
                Text("No films on this device match “\(query)”.")
            } else if savedOnly {
                Text("No saved films on this device").font(.headline)
                Text("Open a film and choose Save to Watchlist.").foregroundStyle(CinemaTheme.muted)
            } else {
                Text("No films on this device").font(.headline)
                Button("Open a Film in Files", action: openFile).buttonStyle(CinemaSecondaryButtonStyle())
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16).background(CinemaTheme.panel, in: RoundedRectangle(cornerRadius: 10))
    }
}

// UITextField owns the entire editable hit area and scales its text using the device's chosen size.
struct CinemaTextInput: UIViewRepresentable {
    @Binding var text: String
    let focusRequest: Int
    let label: String
    let identifier: String
    var keyboard: UIKeyboardType = .default
    var returnKey: UIReturnKeyType = .search
    var submit: () -> Void = {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> UITextField {
        let field = UITextField()
        field.font = .preferredFont(forTextStyle: .body)
        field.adjustsFontForContentSizeCategory = true
        field.textColor = UIColor(CinemaTheme.ink)
        field.backgroundColor = .clear
        field.autocorrectionType = .no
        field.autocapitalizationType = .none
        field.keyboardType = keyboard
        field.returnKeyType = returnKey
        field.accessibilityIdentifier = identifier
        field.delegate = context.coordinator
        field.addTarget(context.coordinator, action: #selector(Coordinator.textChanged(_:)), for: .editingChanged)
        field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return field
    }

    func updateUIView(_ field: UITextField, context: Context) {
        context.coordinator.input = self
        field.accessibilityLabel = label
        if field.text != text { field.text = text }
        if context.coordinator.lastFocusRequest != focusRequest {
            context.coordinator.lastFocusRequest = focusRequest
            // Keyboard shortcuts request focus once. UIKit owns taps and the entire
            // editing transition; re-entering it during updateUIView can attach its field editor twice.
            Task { @MainActor [weak field] in
                guard let field, field.window != nil, !field.isFirstResponder else { return }
                field.becomeFirstResponder()
            }
        }
    }

    @MainActor final class Coordinator: NSObject, UITextFieldDelegate {
        var input: CinemaTextInput
        var lastFocusRequest: Int
        init(_ input: CinemaTextInput) {
            self.input = input
            lastFocusRequest = input.focusRequest
        }
        @objc func textChanged(_ field: UITextField) { input.text = field.text ?? "" }
        func textFieldShouldReturn(_ textField: UITextField) -> Bool {
            textField.resignFirstResponder()
            input.submit()
            return false
        }
    }
}

private extension View {
    func onMoveCommandForFilms(films: [UUID], focused: FocusState<UUID?>.Binding) -> some View {
        self.onKeyPress(keys: [.upArrow, .downArrow]) { press in
            guard let current = focused.wrappedValue, let index = films.firstIndex(of: current) else { return .ignored }
            let next = index + (press.key == .downArrow ? 1 : -1)
            guard films.indices.contains(next) else { return .ignored }
            focused.wrappedValue = films[next]
            return .handled
        }
    }
}

/// Compact collections push through the active NavigationStack. Split collections select their detail column.
struct FilmDestinationLink<Label: View>: View {
    let route: String?
    let select: () -> Void
    @ViewBuilder let label: () -> Label

    var body: some View {
        if let route {
            NavigationLink(value: route, label: label)
        } else {
            Button(action: select, label: label)
        }
    }
}
