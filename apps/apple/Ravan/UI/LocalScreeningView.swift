import SwiftUI

struct LocalScreeningView: View {
    let film: LocalFilm
    let play: (Bool) -> Void
    let locate: () -> Void
    let forget: () -> Void
    @Environment(LocalLibrary.self) private var library
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.horizontalSizeClass) private var horizontalSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var confirmRemoval = false
    @State private var tracks: (audio: [String], captions: [String]) = ([], [])

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: horizontalSize == .compact ? 10 : 17) {
                if !typeSize.isAccessibilitySize {
                    CinemaPoster(title: film.title, isSample: film.isSample, wide: true,
                                 aspectRatio: horizontalSize == .compact ? 2.6 : nil)
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text(verbatim: film.title).font(CinemaTheme.filmFont(43, relativeTo: .largeTitle))
                        .accessibilityAddTraits(.isHeader)
                    Text(film.isSample ? "Sample film" : "Files")
                        .font(.subheadline).foregroundStyle(CinemaTheme.muted)
                }
                if film.isSample {
                    Text("A study of the shore at first light, told in three tides.")
                        .foregroundStyle(CinemaTheme.muted)
                }
                if film.needsRelink {
                    Label("File access needs to be restored", systemImage: "folder.badge.questionmark")
                    Button("Locate file", action: locate).buttonStyle(CinemaPrimaryButtonStyle())
                } else {
                    Button {
                        play(false)
                    } label: {
                        if film.position > 0 {
                            Label("Resume at \(CinemaTime.stamp(film.position))", systemImage: "play.fill")
                        } else {
                            Label("Play", systemImage: "play.fill")
                        }
                    }
                    .buttonStyle(CinemaPrimaryButtonStyle()).accessibilityIdentifier("screening.play")
                    if film.position > 0 {
                        Button { play(true) } label: {
                            Text("Play from beginning").font(.subheadline.weight(.semibold))
                                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                                .contentShape(.rect)
                        }
                    }
                }
                Divider()
                if let duration = film.duration, duration.isFinite, duration > 0 {
                    metadata("Running time", value: CinemaTime.stamp(duration))
                }
                metadata("Source", value: film.isSample ? String(localized: "Included with RAVĀN") : String(localized: "Files"))
                if !tracks.audio.isEmpty {
                    metadata("Audio", value: film.isSample ? String(localized: "Original surf soundtrack") : tracks.audio.formatted(.list(type: .and)))
                }
                if !tracks.captions.isEmpty {
                    metadata("Captions", value: film.isSample ? String(localized: "English and Persian") : tracks.captions.formatted(.list(type: .and)))
                }
                Divider()
                Button {
                    library.toggleFavourite(film)
                } label: {
                    Label {
                        Text(film.isFavourite ? "Remove from Watchlist" : "Save to Watchlist")
                    } icon: {
                        Image(systemName: film.isFavourite ? "bookmark.fill" : "bookmark")
                            .contentTransition(reduceMotion ? .identity : .symbolEffect(.replace))
                            .animation(reduceMotion ? nil : .easeInOut(duration: 0.18), value: film.isFavourite)
                    }
                }
                .buttonStyle(CinemaSecondaryButtonStyle()).accessibilityIdentifier("screening.save")
                if !film.isSample {
                    Button("Forget this film", role: .destructive) { confirmRemoval = true }
                        .frame(minHeight: 44)
                }
            }
            .frame(maxWidth: 720, alignment: .leading)
            .padding(22).frame(maxWidth: .infinity)
        }
        .background(CinemaTheme.background)
        .navigationBarTitleDisplayMode(.inline)
        .task(id: film.bookmark) {
            tracks = ([], [])
            guard !film.needsRelink else { return }
            do {
                let verified = try await library.trackLabels(for: film)
                try Task.checkCancellation()
                tracks = verified
            } catch {
                // Providers can be offline. The film's actions remain available while optional metadata is absent.
            }
        }
        .confirmationDialog("Forget this film?", isPresented: $confirmRemoval, titleVisibility: .visible) {
            Button("Forget film", role: .destructive, action: forget)
            Button("Cancel", role: .cancel) {}
        } message: { Text("RAVĀN will remove its bookmark, watchlist entry and saved position. Your original file stays in Files.") }
    }

    private func metadata(_ title: LocalizedStringKey, value: String) -> some View {
        let stacked = VStack(alignment: .leading, spacing: 5) {
            Text(title).foregroundStyle(CinemaTheme.muted)
            Text(verbatim: value).fixedSize(horizontal: false, vertical: true)
        }
        return Group {
            if typeSize.isAccessibilitySize {
                stacked
            } else {
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(title).foregroundStyle(CinemaTheme.muted).fixedSize()
                        Spacer(minLength: 14)
                        Text(verbatim: value).fixedSize()
                    }
                    stacked
                }
            }
        }
        .font(.subheadline).foregroundStyle(CinemaTheme.ink).accessibilityElement(children: .combine)
    }
}
