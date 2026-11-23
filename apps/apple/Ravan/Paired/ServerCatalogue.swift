#if PAIRED
import SwiftUI
import ImageIO
import Accessibility
import Combine

struct ServerPoster: View {
    let movie: ServerMovie
    var wide = false
    var aspectRatio: CGFloat?
    @Environment(PairedCinema.self) private var cinema
    @State private var picture: CGImage?
    private var path: String? {
        let poster = CinemaURL.artwork(movie.posterUrl), still = CinemaURL.artwork(movie.stillUrl)
        return wide ? (still ?? poster) : (poster ?? still)
    }

    var body: some View {
        CinemaPoster(title: movie.title, isSample: false, wide: wide, aspectRatio: aspectRatio)
            .overlay {
                if let picture {
                    GeometryReader { geometry in
                        Image(decorative: picture, scale: 1)
                            .resizable().scaledToFill()
                            .frame(width: geometry.size.width, height: geometry.size.height)
                            .clipped()
                    }.clipShape(RoundedRectangle(cornerRadius: 8))
                }
            }
            .accessibilityHidden(true)
            .task(id: [cinema.scopeID ?? "", path ?? ""]) {
                picture = nil
                guard let path, let scope = cinema.scopeID else { return }
                do {
                    let bytes = try await cinema.data(path)
                    let thumbnail = await Self.thumbnail(bytes)
                    try Task.checkCancellation()
                    if cinema.scopeID == scope { picture = thumbnail }
                } catch { /* The title poster remains usable when artwork is unavailable. */ }
            }
    }

    @concurrent private static func thumbnail(_ bytes: Data) async -> CGImage? {
        guard let source = CGImageSourceCreateWithData(bytes as CFData, nil),
              let type = CGImageSourceGetType(source) as String?, ["public.jpeg", "public.png"].contains(type),
              let info = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = info[kCGImagePropertyPixelWidth] as? Int, let height = info[kCGImagePropertyPixelHeight] as? Int,
              (1...8192).contains(width), (1...8192).contains(height), width * height <= 40_000_000
        else { return nil }
        let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true,
                                        kCGImageSourceCreateThumbnailWithTransform: true,
                                        kCGImageSourceThumbnailMaxPixelSize: 900]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
    }
}

struct ServerCollectionView: View {
    let query: String
    let savedOnly: Bool
    var rows = false
    @Environment(\.dynamicTypeSize) private var typeSize
    let route: (String) -> String?
    let onSelect: (String) -> Void
    @Environment(PairedCinema.self) private var cinema
    @State private var films: [ServerMovie] = []
    @State private var cursor: String?
    @State private var busy = false
    @State private var issue: String?
    @State private var retryFromStart = true
    @State private var generation = UUID()

    private var identity: [String] { [query, savedOnly.description, cinema.scopeID ?? "", String(cinema.changed)] }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            CinemaSectionTitle(text: savedOnly ? "Saved on your server" : "Films on your server")
            if rows || typeSize.isAccessibilitySize {
                LazyVStack(spacing: 7) { ForEach(films) { row($0) } }
            } else {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 136, maximum: 245), spacing: 15)], alignment: .leading, spacing: 18) {
                    ForEach(films) { movie in
                        VStack(alignment: .leading, spacing: 7) {
                            ServerPoster(movie: movie).contentShape(.rect).onTapGesture { onSelect(movie.id) }
                            FilmDestinationLink(route: rows ? nil : route(movie.id), select: { onSelect(movie.id) }) {
                                filmLabel(movie).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(.rect)
                            }.buttonStyle(.plain).accessibilityIdentifier("server.film." + movie.id)
                        }
                    }
                }
            }
            if let issue {
                Text(issue).font(.footnote)
                Button("Retry") { Task { await load(reset: retryFromStart) } }.buttonStyle(CinemaSecondaryButtonStyle()).disabled(busy)
                    .accessibilityIdentifier("server.catalogue.retry")
            } else if busy {
                ProgressView("Loading server films")
            } else if cursor != nil {
                Button("Load more films") { Task { await load(reset: false) } }.buttonStyle(CinemaSecondaryButtonStyle()).disabled(busy)
            } else if films.isEmpty {
                Text(!query.isEmpty ? "No matching server films." : savedOnly ? "Films saved on your server appear here." :
                        "Open the owner portal in Your Cinema to add films.")
                    .font(.subheadline).foregroundStyle(CinemaTheme.muted)
            }
        }
        .task(id: identity) {
            generation = UUID()
            films = []; cursor = nil; issue = nil; busy = true
            do { if !query.isEmpty { try await Task.sleep(for: .milliseconds(300)) } }
            catch { return }
            await load(reset: true)
        }
    }

    private func row(_ movie: ServerMovie) -> some View {
        FilmDestinationLink(route: rows ? nil : route(movie.id), select: { onSelect(movie.id) }) {
            HStack(spacing: 12) {
                Image(systemName: "film.stack").foregroundStyle(CinemaTheme.accent)
                filmLabel(movie)
                Spacer()
                Image(systemName: "chevron.right").font(.caption)
            }.padding(12).frame(minHeight: 48).background(CinemaTheme.panel, in: RoundedRectangle(cornerRadius: 9))
        }.buttonStyle(.plain).accessibilityIdentifier("server.film." + movie.id)
    }

    private func filmLabel(_ movie: ServerMovie) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(verbatim: movie.title).font(CinemaTheme.filmFont(25, relativeTo: .headline))
            Text(movie.resumeMs > 0 && movie.available ? "Paused at \(CinemaTime.stamp(Double(movie.resumeMs) / 1000))" :
                    (movie.available ? "Personal server" : "Source unavailable"))
                .font(.caption).foregroundStyle(CinemaTheme.muted)
        }.multilineTextAlignment(.leading)
    }

    private func load(reset: Bool) async {
        guard reset || !busy else { return }
        let captured = generation
        busy = true; issue = nil
        defer { if generation == captured { busy = false } }
        do {
            var terms = [URLQueryItem]()
            if !query.isEmpty { terms.append(.init(name: "q", value: query)) }
            if savedOnly { terms.append(.init(name: "saved", value: "true")) }
            if !reset, let cursor { terms.append(.init(name: "cursor", value: cursor)) }
            let page = try JSONDecoder().decode(CinemaPage.self, from: await cinema.data("/api/movies", query: terms))
            guard generation == captured, !Task.isCancelled else { return }
            var seen = Set(reset ? [] : films.map(\.id))
            let unique = page.items.filter { seen.insert($0.id).inserted }
            films = reset ? unique : films + unique
            cursor = page.nextCursor
        } catch {
            if generation == captured && !Task.isCancelled {
                retryFromStart = reset
                issue = cinemaMessage(error)
            }
        }
    }
}

struct ServerScreeningView: View {
    let movieID: String
    @Environment(PairedCinema.self) private var cinema
    @Environment(\.cinemaWindowID) private var window
    @Environment(\.horizontalSizeClass) private var horizontalSize
    @Environment(\.dynamicTypeSize) private var typeSize
    private var preferredAudio: String { CinemaLanguages.shared.audio }
    @State private var film: ServerMovie?
    @State private var editionID = ""
    @State private var audioIndex: Int?
    @State private var quality = "auto"
    @State private var issue: String?
    @State private var saving = false
    @State private var retryDesired: Bool?
    @State private var retry = 0
    private var available: [ServerEdition] { film?.editions?.filter(\.available) ?? [] }
    private var edition: ServerEdition? { available.first { $0.id == editionID } }
    private func qualityLabel(_ option: String) -> Text {
        switch option {
        case "auto": Text("Auto")
        case "original": Text("Original")
        default: Text(verbatim: option.capitalized)
        }
    }
    private var resume: Int {
        guard let film, let edition else { return 0 }
        return film.resumeOffset(for: edition)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: horizontalSize == .compact ? 10 : 17) {
                if let film {
                    if !typeSize.isAccessibilitySize {
                        ServerPoster(movie: film, wide: true, aspectRatio: horizontalSize == .compact ? 2.6 : nil)
                    }
                    Text(verbatim: film.title)
                        .font(.system(.largeTitle, design: .serif, weight: .medium))
                        .fixedSize(horizontal: false, vertical: true)
                        // Reserve the display face’s overhang and descenders inside its accessible bounds.
                        .padding(.vertical, 3)
                        .padding(.horizontal, 2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(Text(verbatim: film.title))
                        .accessibilityAddTraits([.isHeader, .isStaticText])
                    Text([film.year.map(String.init), "Personal server", film.available ? "Source available" : "Source unavailable"]
                        .compactMap { $0 }.joined(separator: " · ")).font(.subheadline).foregroundStyle(CinemaTheme.muted)
                    if let description = film.description, !description.isEmpty { Text(verbatim: description) }
                    if available.count > 1 {
                        Picker("Edition", selection: $editionID) {
                            ForEach(available) { Text(verbatim: $0.label).tag($0.id) }
                        }
                    } else if let edition {
                        LabeledContent("Edition", value: edition.label)
                    }
                    ForEach(film.editions?.filter { !$0.available } ?? []) { unavailable in
                        Label("\(unavailable.label) · Source unavailable", systemImage: "exclamationmark.circle")
                            .font(.subheadline).foregroundStyle(CinemaTheme.muted)
                    }
                    if let edition {
                        Button { start(resume) } label: {
                            Label(resume > 0 ? "Resume at \(CinemaTime.stamp(Double(resume) / 1000))" : "Play", systemImage: "play.fill")
                        }.buttonStyle(CinemaPrimaryButtonStyle()).disabled(cinema.playback.busy).accessibilityIdentifier("film.resume")
                        if cinema.playback.busy { ProgressView("Opening screening") }
                        if resume > 0 { Button("Play from beginning") { start(0) }.buttonStyle(CinemaSecondaryButtonStyle()).disabled(cinema.playback.busy) }
                        VStack(spacing: 0) {
                            if let tracks = edition.audioTracks, !tracks.isEmpty {
                                let current = tracks.first { $0.index == audioIndex }
                                CinemaChoiceRow(title: "Audio", value: current.map { Text(verbatim: $0.label) } ?? Text("Automatic")) {
                                    Button("Automatic") { audioIndex = nil }
                                    ForEach(tracks, id: \.index) { track in
                                        Button { audioIndex = track.index } label: { Text(verbatim: track.label) }
                                    }
                                }
                                Divider()
                            }
                            CinemaChoiceRow(title: "Quality", value: qualityLabel(quality)) {
                                ForEach(["auto", "original", "480p", "720p", "1080p"], id: \.self) { option in
                                    Button { quality = option } label: { qualityLabel(option) }
                                }
                            }
                        }
                        .padding(.horizontal, 14)
                        .background(CinemaTheme.panel, in: RoundedRectangle(cornerRadius: 10))
                        if audioIndex != nil || quality != "auto" {
                            Text("The server may need to prepare this edition for your selection.").font(.footnote)
                        }
                        if let tracks = edition.subtitleTracks, !tracks.isEmpty {
                            let available = tracks.filter(\.text)
                            if !available.isEmpty { LabeledContent("Text subtitles", value: available.map(\.label).joined(separator: ", ")) }
                            if tracks.contains(where: { !$0.text }) {
                                Text("Image-based subtitles are unavailable in this edition.").font(.footnote)
                            }
                        }
                    } else {
                        Label("No available edition. Ask the server owner to check the source file.", systemImage: "exclamationmark.circle")
                            .font(.subheadline)
                    }
                    if cinema.canSave {
                        Button { Task { await save(desired: film.saved != true) } } label: {
                            Label(film.saved == true ? "Remove from Watchlist" : "Save to Watchlist",
                                  systemImage: film.saved == true ? "bookmark.fill" : "bookmark")
                        }.buttonStyle(CinemaSecondaryButtonStyle()).disabled(saving).accessibilityIdentifier("server.watchlist")
                    } else {
                        Label(film.saved == true ? "In server Watchlist · Read only" : "Server Watchlist · Read only", systemImage: "lock")
                            .font(.footnote).accessibilityIdentifier("server.readonly")
                    }
                } else if issue == nil { ProgressView("Loading screening card") }
                if let issue {
                    Text(issue).font(.subheadline)
                    Button("Retry") {
                        if let desired = retryDesired, cinema.canSave { Task { await save(desired: desired) } } else { retry += 1 }
                    }
                }
            }.padding().frame(maxWidth: 640, alignment: .leading).frame(maxWidth: .infinity)
        }
        .background(CinemaTheme.background)
        .onChange(of: issue) { _, text in if let text { AccessibilityNotification.Announcement(text).post() } }
        .task(id: [movieID, cinema.scopeID ?? "", String(retry), String(cinema.changed)]) {
            do {
                let next = try JSONDecoder().decode(ServerMovie.self, from: await cinema.data("/api/movies/" + CinemaURL.id(movieID)))
                try Task.checkCancellation()
                guard next.id == movieID else { throw CinemaFailure.invalidReply }
                film = next; issue = nil
                if !available.contains(where: { $0.id == editionID }) {
                    editionID = available.first(where: { $0.id == next.resumeEditionId })?.id ?? available.first?.id ?? ""
                }
            } catch { if !Task.isCancelled { issue = cinemaMessage(error) } }
        }
        .onChange(of: edition) { _, selection in
            audioIndex = selection?.preferredAudioIndex(language: preferredAudio)
        }
        .onChange(of: preferredAudio) { _, language in
            audioIndex = edition?.preferredAudioIndex(language: language)
        }
    }

    private func start(_ milliseconds: Int) {
        guard let film, let edition else { return }
        let request = CinemaPlayRequest(movieId: film.id, startMs: max(0, milliseconds), editionId: edition.id,
                                        generation: edition.generation, quality: quality, audioTrack: audioIndex)
        Task { await cinema.playback.play(request, title: film.title, window: window, on: cinema) }
    }
    private func save(desired: Bool) async {
        guard let film, let scope = cinema.scopeID, !saving else { return }
        saving = true; retryDesired = nil; self.film?.saved = desired
        defer { saving = false }
        do { try await cinema.save(film.id, desired); issue = nil }
        catch {
            guard cinema.scopeID == scope, self.film?.id == film.id else { return }
            self.film?.saved = film.saved; retryDesired = cinema.canSave ? desired : nil; issue = cinemaMessage(error)
        }
    }
}

struct ServerPreparationView: View {
    let job: CinemaJob
    let window: UUID
    let foreground: Bool
    let returnToLibrary: () -> Void
    @Environment(PairedCinema.self) private var cinema
    @Environment(\.dismiss) private var dismiss
    @State private var status: CinemaJobState?
    @State private var issue: String?
    @State private var attempt = 0
    @State private var requestID: UUID?
    private let pollTimer = Timer.publish(every: 5, on: .main, in: .common).autoconnect()
    private var state: String { status?.state ?? "loading" }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Text(verbatim: job.title).font(.system(.title, design: .serif, weight: .medium))
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.vertical, 5).padding(.trailing, 4)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(Text(verbatim: job.title)).accessibilityAddTraits(.isHeader)
                    let quality = job.request.quality == "auto" ? String(localized: "Auto") : job.request.quality.capitalized
                    Text("Quality · \(quality)").foregroundStyle(CinemaTheme.ink)
                        .accessibilityIdentifier("preparation.quality")
                    if let index = job.request.audioTrack {
                        Text("Audio · Track \(index + 1)").foregroundStyle(CinemaTheme.ink)
                    }
                    Text(label).font(.headline).accessibilityIdentifier("preparation.status")
                    if ["ready", "failed", "invalidated", "evicted", "unavailable"].contains(state) {
                        if state == "ready" || state == "evicted" || (state == "failed" && status?.reasonCode != "media_unsupported") {
                            Button(state == "ready" ? "Play" : "Retry preparation") {
                                cinema.playback.clearPrompt()
                                Task { await cinema.playback.play(job.request, title: job.title, window: window, on: cinema) }
                            }.buttonStyle(CinemaPrimaryButtonStyle()).accessibilityIdentifier("preparation.play")
                        }
                        Button("Remove from preparations") {
                            do { try cinema.removeJob(job.id); dismiss() } catch { issue = cinemaMessage(error) }
                        }.buttonStyle(.plain).foregroundStyle(CinemaTheme.accent).frame(minHeight: 44)
                    } else if let percent = status?.progressPercent, (0...100).contains(percent) {
                        ProgressView(value: percent, total: 100) {
                            Text("\(Int(percent))% prepared")
                        }.accessibilityLabel("Preparation progress").accessibilityValue("\(Int(percent))% prepared")
                    } else if issue == nil && ["loading", "queued", "probing", "preparing"].contains(state) {
                        ProgressView().accessibilityLabel(label)
                    }
                    if let issue { Text(issue); Button("Refresh status") { attempt += 1 } }
                    Button("Back to Library") { dismiss(); returnToLibrary() }.buttonStyle(CinemaSecondaryButtonStyle()).keyboardShortcut(.cancelAction)
                }.padding()
            }.background(CinemaTheme.background).navigationTitle("Preparation").navigationBarTitleDisplayMode(.inline)
        }
        .accessibilityAddTraits(.isModal)
        .onChange(of: state) { _, next in
            if ["ready", "failed", "evicted", "invalidated", "unavailable"].contains(next) { AccessibilityNotification.Announcement(label).post() }
        }
        .onReceive(pollTimer) { _ in
            // A foreground scene may briefly become inactive while a sheet or system control is presented.
            // Keep the visible job moving; leaving the foreground cancels its pending request.
            guard foreground, UIApplication.shared.applicationState != .background,
                  requestID == nil, issue == nil, ["loading", "queued", "preparing", "probing"].contains(state) else { return }
            attempt += 1
        }
        .task(id: [job.id, String(attempt), String(foreground)]) {
            guard foreground, UIApplication.shared.applicationState != .background else { return }
            let token = UUID()
            requestID = token
            defer { if requestID == token { requestID = nil } }
            issue = nil
            do {
                let updated = try JSONDecoder().decode(CinemaJobState.self, from: await cinema.data("/api/preparations/" + CinemaURL.id(job.id)))
                try Task.checkCancellation()
                guard ["queued", "preparing", "probing", "ready", "failed", "invalidated", "evicted"].contains(updated.state)
                else { throw CinemaFailure.invalidReply }
                status = updated
            } catch CinemaFailure.http(404, _, _) {
                if !Task.isCancelled { status = CinemaJobState(state: "unavailable", progressPercent: nil, reasonCode: nil) }
            } catch { if !Task.isCancelled { issue = cinemaMessage(error) } }
        }
    }
    private var label: String {
        switch state {
        case "ready": String(localized: "Ready to play")
        case "probing": String(localized: "Checking the source")
        case "preparing": String(localized: "Preparing this edition")
        case "queued": String(localized: "Waiting for the server")
        case "loading": issue == nil ? String(localized: "Checking preparation status") : String(localized: "Status unavailable")
        case "unavailable": String(localized: "The server no longer has this preparation. Reopen the film to start again.")
        case "failed": failureReason
        case "invalidated": String(localized: "The source changed. Reopen its screening card.")
        case "evicted": String(localized: "This edition needs to be prepared again.")
        default: String(localized: "Unknown preparation state")
        }
    }
    private var failureReason: String {
        switch status?.reasonCode {
        case "media_storage": String(localized: "The server ran out of space. Ask the owner to free space before retrying.")
        case "media_resources": String(localized: "The server needs more resources to prepare this edition.")
        case "media_source": String(localized: "The server could not read the source. Ask the owner to check the file.")
        case "media_timeout": String(localized: "Preparation took too long. Try a lower quality on the screening card.")
        case "media_cancelled": String(localized: "Preparation was cancelled.")
        case "media_unavailable": String(localized: "The server’s media tool is unavailable. Ask the owner to check it.")
        case "source_changed": String(localized: "The source changed. Reopen the screening card to choose the current edition.")
        case "media_unsupported": String(localized: "The server cannot prepare this edition. Choose another edition or file.")
        default: String(localized: "Preparation failed. Retry or ask the owner to check the source.")
        }
    }
}
#endif
