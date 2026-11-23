import SwiftUI

struct YourCinemaView: View {
    let openFile: () -> Void
    @Environment(LocalLibrary.self) private var library
    @Environment(\.horizontalSizeClass) private var horizontalSize
    @State private var confirmHistory = false
    @State private var guide: CinemaGuide?

    var body: some View {
        @Bindable var languages = CinemaLanguages.shared
        ScrollView {
            VStack(alignment: .leading, spacing: horizontalSize == .compact ? 15 : 26) {
                Text("Your Cinema")
                    .font(CinemaTheme.filmFont(44, relativeTo: .largeTitle))
                    .accessibilityAddTraits(.isHeader)

                VStack(alignment: .leading, spacing: 12) {
                    CinemaSectionTitle(text: "On this device")
                    Button(action: openFile) { Label("Open a Film in Files", systemImage: "folder") }
                        .buttonStyle(CinemaSecondaryButtonStyle())
                        .accessibilityIdentifier("cinema.files")
                }

                #if PAIRED
                ServerSettingsView()
                #endif

                VStack(alignment: .leading, spacing: 12) {
                    CinemaSectionTitle(text: "Playback languages")
                    VStack(spacing: 0) {
                        LanguageChoice(title: "Audio", selection: $languages.audio)
                        Divider()
                        LanguageChoice(title: "Subtitles", selection: $languages.subtitles)
                    }
                    .padding(.horizontal, 14)
                    .background(CinemaTheme.panel, in: RoundedRectangle(cornerRadius: 10))
                    Text("Applies on this device when the film includes your chosen language.")
                        .font(.footnote).foregroundStyle(CinemaTheme.muted)
                }

                VStack(alignment: .leading, spacing: 0) {
                    CinemaSectionTitle(text: "History and privacy").padding(.bottom, 8)
                    if library.films.contains(where: { $0.lastPlayed != nil }) {
                        Button { confirmHistory = true } label: {
                            settingsRow("Clear viewing history", systemImage: "clock.arrow.circlepath", disclosure: false)
                        }
                        .accessibilityIdentifier("cinema.clearHistory")
                    } else {
                        Text("No viewing history on this device")
                            .font(.subheadline).foregroundStyle(CinemaTheme.muted).padding(.vertical, 12)
                    }
                    Divider()
                    Button { guide = .privacy } label: { settingsRow("Privacy policy", systemImage: "hand.raised") }
                    Divider()
                    Button { guide = .help } label: { settingsRow("Playback help", systemImage: "questionmark.circle") }
                }
                .buttonStyle(.plain)
            }
            .frame(maxWidth: 580, alignment: .leading)
            .padding(20).frame(maxWidth: .infinity)
        }
        .background(CinemaTheme.background)
        .sheet(item: $guide) { topic in
            NavigationStack {
                CinemaGuidePage(topic: topic)
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) {
                            Button { guide = nil } label: {
                                Image(systemName: "checkmark").frame(minWidth: 44, minHeight: 44)
                            }
                            .accessibilityLabel("Done").keyboardShortcut(.cancelAction)
                        }
                    }
            }
        }
        .confirmationDialog("Clear viewing history?", isPresented: $confirmHistory, titleVisibility: .visible) {
            Button("Clear history", role: .destructive) { library.clearHistory() }
            Button("Cancel", role: .cancel) {}
        } message: { Text("This clears saved positions for films in Files and the sample on this device. Your Watchlist is kept.") }
    }

    private struct LanguageChoice: View {
        let title: LocalizedStringKey
        @Binding var selection: String

        private var value: LocalizedStringKey {
            switch selection {
            case "en": "English"
            case "fa": "Persian"
            default: "System default"
            }
        }

        var body: some View {
            CinemaChoiceRow(title: title, value: Text(value)) {
                Button("System default") { selection = "" }
                Button("English") { selection = "en" }
                Button("Persian") { selection = "fa" }
            }
        }
    }

    private func settingsRow(_ title: LocalizedStringKey, systemImage: String, disclosure: Bool = true) -> some View {
        HStack(spacing: 12) {
            Image(systemName: systemImage).foregroundStyle(CinemaTheme.accent).frame(width: 23)
                .accessibilityHidden(true)
            Text(title).font(.body).foregroundStyle(CinemaTheme.ink)
                .multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 4)
            if disclosure {
                Image(systemName: "chevron.forward").font(.caption).foregroundStyle(CinemaTheme.muted)
                    .accessibilityHidden(true)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading).contentShape(.rect)
    }
}

struct CinemaChoiceRow<Choices: View>: View {
    let title: LocalizedStringKey
    let value: Text
    private let choices: () -> Choices
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var choosing = false

    init(title: LocalizedStringKey, value: Text, @ViewBuilder choices: @escaping () -> Choices) {
        self.title = title
        self.value = value
        self.choices = choices
    }

    var body: some View {
        let layout = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
            : AnyLayout(HStackLayout(spacing: 8))
        Button { choosing = true } label: {
            layout {
                Text(title).font(.body).fixedSize(horizontal: false, vertical: true)
                if !typeSize.isAccessibilitySize { Spacer(minLength: 4) }
                HStack(spacing: 6) {
                    value.font(.body).fixedSize(horizontal: false, vertical: true)
                    Image(systemName: "chevron.up.chevron.down")
                        .font(.footnote).accessibilityHidden(true)
                }
            }
            .foregroundStyle(CinemaTheme.ink)
            .padding(.vertical, 7)
            .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(title))
        .accessibilityValue(value)
        .confirmationDialog(title, isPresented: $choosing, titleVisibility: .visible) {
            choices()
            Button("Cancel", role: .cancel) {}
        }
    }
}

private enum CinemaGuide: String, Identifiable {
    case privacy, help
    var id: Self { self }
}

private struct CinemaGuidePage: View {
    let topic: CinemaGuide
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                if topic == .privacy {
                    section("Films in Files", "RAVĀN stores a reference to each file you choose, its title, your watchlist choice and your viewing position on this device. Your Files provider may download the film when you open it.")
                    section("Your controls", "Clear viewing history in Your Cinema to reset local viewing positions. Choose Forget this film on its screening card to remove the file reference and its activity.")
                    #if PAIRED
                    section("Connected cinemas", "A connected server receives the device name you enter, catalogue and playback requests, and viewing progress. Saving a server film updates that server’s watchlist. Its operator controls retention and access. RAVĀN keeps its device credential in the system Keychain. Disconnect in Your Cinema to remove this device’s saved access.")
                    section("Reading Room", "The paired reader stores your reading position on the cinema server. Its temporary session is held in memory. The owner can remove this device in Your cinema on the website.")
                    #endif
                } else {
                    section("Open a film", "Choose Open a Film in Files, then select a video. An H.264 MP4 with AAC audio is a good choice. To watch offline, download the film to your device in Files first.")
                    section("Find a film again", "Choose Locate file on its screening card if access changes. Select the original file to keep its saved position and watchlist choice.")
                    section("Audio and captions", "During playback, tap the picture to show controls. Open the system language menu to choose among the tracks included with the film.")
                    #if PAIRED
                    section("Pair a device", "Choose Connect to RAVĀN to get a code for the website. Copy the code, open the website and approve the device in Your cinema. Select Reading Room to read books on this device.")
                    #endif
                }
            }
            .frame(maxWidth: 640, alignment: .leading)
            .padding(24).frame(maxWidth: .infinity)
        }
        .navigationTitle(topic == .help ? "Playback help" : "Privacy policy")
        .navigationBarTitleDisplayMode(.inline)
        .background(CinemaTheme.background)
    }

    private func section(_ title: LocalizedStringKey, _ body: LocalizedStringKey) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            CinemaSectionTitle(text: title)
            Text(body).foregroundStyle(CinemaTheme.muted)
        }
    }
}

struct CinemaInfoPanel: View {
    var body: some View {
        CinemaGuidePage(topic: .help)
    }
}
