import SwiftUI

enum CinemaLaunch {
    static let testSession: String? = {
        #if DEBUG || RAVAN_UI_TESTING
        if ProcessInfo.processInfo.arguments.contains("--ravan-isolated-test") { return UUID().uuidString }
        #endif
        return nil
    }()

    static func sceneKey(_ key: String) -> String {
        testSession.map { "test." + $0 + "." + key } ?? key
    }

    @MainActor static func library() throws -> LocalLibrary {
        if testSession != nil {
            let library = try LocalLibrary(inMemory: true, defaults: nil)
            library.hasEntered = ProcessInfo.processInfo.arguments.contains("--ravan-test-library")
            return library
        }
        return try LocalLibrary()
    }
}

@Observable @MainActor final class CinemaLanguages {
    static let shared = CinemaLanguages()
    private let store: UserDefaults?
    var audio: String { didSet { store?.set(audio, forKey: "cinema.preferredAudio") } }
    var subtitles: String { didSet { store?.set(subtitles, forKey: "cinema.preferredSubtitles") } }

    private init() {
        let store: UserDefaults? = CinemaLaunch.testSession == nil ? .standard : nil
        self.store = store
        audio = store?.string(forKey: "cinema.preferredAudio") ?? ""
        subtitles = store?.string(forKey: "cinema.preferredSubtitles") ?? ""
    }
}

@main
struct RavanApp: App {
    @State private var library: LocalLibrary?
    #if PAIRED
    @State private var paired: PairedCinema
    #endif
    init() {
        #if PAIRED
        if let session = CinemaLaunch.testSession {
            #if RAVAN_UI_TESTING
            if ProcessInfo.processInfo.arguments.contains("--ravan-paired-fixture") {
                _paired = State(initialValue: FixtureCinema.make(session: session))
            } else {
                _paired = State(initialValue: FixtureCinema.unpaired(session: session))
            }
            #else
            _paired = State(initialValue: PairedCinema(service: "Ravan.isolated-test." + session, restoreAutomatically: false))
            #endif
        } else { _paired = State(initialValue: PairedCinema()) }
        #endif
        do { _library = State(initialValue: try CinemaLaunch.library()) }
        catch { _library = State(initialValue: nil) }
    }

    var body: some Scene {
        WindowGroup {
            if let library {
                CinemaWindow()
                    .environment(library)
                    #if PAIRED
                    .environment(paired)
                    .task { await paired.restore() }
                    #endif
            } else {
                ContentUnavailableView {
                    Label("Library unavailable", systemImage: "externaldrive.badge.exclamationmark")
                } description: {
                    Text("Check your device storage and reopen your cinema.")
                } actions: {
                    Button("Try again") { library = try? CinemaLaunch.library() }
                }
            }
        }
    }
}

private struct CinemaWindow: View {
    @State private var playback = PlaybackCoordinator()
    var body: some View {
        CinemaRootView()
            .environment(playback)
            #if DEBUG || RAVAN_UI_TESTING
            .preferredColorScheme(CinemaLaunch.testSession != nil && ProcessInfo.processInfo.arguments.contains("--ravan-test-light") ? .light : nil)
            #endif
    }
}
