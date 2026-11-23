import AVFoundation
import AVKit
import SwiftUI
import OSLog

/// All windows and both players share a process-wide audio session. The serialized
/// transition chain prevents a slow old deactivation from muting a newer screening.
@MainActor final class CinemaAudioSession {
    static let shared = CinemaAudioSession()
    private let log = Logger(subsystem: "au.ravan.cinema", category: "audio")
    private var owner: UUID?
    private var active = false
    private var transition: Task<Void, Never>?
    private var idleRelease: Task<Void, Never>?
    private var observations = [NSObjectProtocol]()

    private init() {
        let center = NotificationCenter.default
        let inactive: Notification.Name
        if #available(iOS 27, *) { inactive = AVAudioSession.didBecomeInactiveNotification }
        else { inactive = AVAudioSession.interruptionNotification }
        observations.append(center.addObserver(forName: inactive, object: nil, queue: .main) { [weak self] note in
            if #unavailable(iOS 27),
               note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt != AVAudioSession.InterruptionType.began.rawValue { return }
            MainActor.assumeIsolated { self?.active = false }
        })
        observations.append(center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification,
                                               object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.active = false }
        })
    }

    func acquire(_ token: UUID) async throws {
        try Task.checkCancellation()
        owner = token
        idleRelease?.cancel(); idleRelease = nil
        let prior = transition
        let activation = Task { @MainActor in
            await prior?.value
            guard owner == token else { throw CancellationError() }
            if !active {
                try await activateForPlayback(token)
                active = true
            }
        }
        transition = Task { _ = await activation.result }
        do {
            try await activation.value
            try Task.checkCancellation()
            guard owner == token else { throw CancellationError() }
        } catch {
            release(token)
            if error is CancellationError { throw CancellationError() }
            if error is FilmError { throw error }
            let system = error as NSError
            log.error("Audio activation failed, domain=\(system.domain, privacy: .public) code=\(system.code, privacy: .public)")
            if system.domain == NSOSStatusErrorDomain {
                switch system.code {
                case AVAudioSession.ErrorCode.insufficientPriority.rawValue,
                     AVAudioSession.ErrorCode.cannotInterruptOthers.rawValue,
                     AVAudioSession.ErrorCode.siriIsRecording.rawValue:
                    throw FilmError.audioInterrupted
                default: break
                }
            }
            throw FilmError.audioOutput
        }
    }

    func release(_ token: UUID) {
        guard owner == token else { return }
        owner = nil
        idleRelease?.cancel()
        // The next screen can claim the existing category and output during a quick handoff.
        idleRelease = Task {
            do { try await Task.sleep(for: .milliseconds(300)) } catch { return }
            guard owner == nil else { return }
            let prior = transition
            transition = Task {
                await prior?.value
                guard owner == nil, active else { return }
                active = false
                do { try await Self.deactivateHardware() }
                catch {
                    let system = error as NSError
                    log.error("Audio deactivation failed, domain=\(system.domain, privacy: .public) code=\(system.code, privacy: .public)")
                }
            }
        }
    }

    private func activateForPlayback(_ token: UUID) async throws {
        // A rapid player handoff can reach an active window before iOS restores its audio route.
        // Retry only that transient denial, while the same foreground player still owns the request.
        for delay in [Duration.milliseconds(200), .milliseconds(500)] {
            do {
                try await Self.activateHardware()
                return
            } catch {
                let system = error as NSError
                guard UIApplication.shared.applicationState == .active,
                      system.domain == NSOSStatusErrorDomain,
                      system.code == AVAudioSession.ErrorCode.cannotStartPlaying.rawValue else { throw error }
                try await Task.sleep(for: delay)
                guard owner == token, !Task.isCancelled else { throw CancellationError() }
                guard UIApplication.shared.applicationState == .active else { throw error }
            }
        }
        try await Self.activateHardware()
    }

    @concurrent private static func activateHardware() async throws {
        let session = AVAudioSession.sharedInstance()
        if session.category != .playback || session.mode != .moviePlayback {
            try session.setCategory(.playback, mode: .moviePlayback)
        }
        if #available(iOS 27, *) {
            guard try await session.activate(options: []) else { throw FilmError.audioOutput }
        } else {
            try session.setActive(true)
        }
    }

    @concurrent private static func deactivateHardware() async throws {
        let session = AVAudioSession.sharedInstance()
        if #available(iOS 27, *) {
            guard try await session.deactivate(options: .notifyOthersOnDeactivation) else { throw FilmError.audioOutput }
        } else {
            try session.setActive(false, options: .notifyOthersOnDeactivation)
        }
    }
}

@MainActor @Observable final class PlaybackCoordinator {
    static let localIntent = Notification.Name("Ravan.localPlayerIntent")
    private(set) var player: AVPlayer?
    var isPresented = false
    var failure: String?
    private var film: LocalFilm?
    private weak var library: LocalLibrary?
    private var scopedURL: URL?
    private var tick: Any?
    private var observation: NSKeyValueObservation?
    private var generation = UUID()
    private var finished = false

    func play(_ film: LocalFilm, library: LocalLibrary, fromBeginning: Bool = false) async throws {
        stop()
        let request = generation
        let url = try library.resolve(film)
        let scoped = !film.isSample && url.startAccessingSecurityScopedResource()
        var transferredScope = false
        defer { if scoped && !transferredScope { url.stopAccessingSecurityScopedResource() } }

        let asset = AVURLAsset(url: url)
        do { film.duration = try await LocalLibrary.validate(asset) }
        catch {
            if !film.isSample, let reason = error as? FilmError, [.unavailable, .denied].contains(reason) {
                film.needsRelink = true
                library.persist()
            }
            throw error
        }
        let item = AVPlayerItem(asset: asset)
        let prepared = AVPlayer(playerItem: item)
        prepared.allowsExternalPlayback = false
        for (language, characteristic): (String, AVMediaCharacteristic) in [
            (CinemaLanguages.shared.audio, .audible), (CinemaLanguages.shared.subtitles, .legible)
        ] {
            if ["en", "fa"].contains(language) {
                let criteria = AVPlayerMediaSelectionCriteria(preferredLanguages: [language], preferredMediaCharacteristics: nil)
                prepared.setMediaSelectionCriteria(criteria, forMediaCharacteristic: characteristic)
            }
        }
        let position = fromBeginning || film.ended ? 0 : film.position
        if position > 0 {
            let sought = await prepared.seek(to: CMTime(seconds: position, preferredTimescale: 1000),
                                            toleranceBefore: .zero, toleranceAfter: .zero)
            try Task.checkCancellation()
            guard generation == request else { throw CancellationError() }
            guard sought else { throw FilmError.resumeUnavailable }
        }
        try Task.checkCancellation()
        guard generation == request else { throw CancellationError() }
        NotificationCenter.default.post(name: Self.localIntent, object: self)
        #if PAIRED
        NotificationCenter.default.post(name: .ravanLocalPlaybackStarting, object: nil)
        #endif
        try await CinemaAudioSession.shared.acquire(request)
        guard generation == request, !Task.isCancelled else {
            CinemaAudioSession.shared.release(request)
            throw CancellationError()
        }
        self.film = film
        self.library = library
        if scoped { scopedURL = url; transferredScope = true }
        player = prepared
        observation = item.observe(\.status, options: [.initial, .new]) { [weak self] item, _ in
            guard item.status == .failed else { return }
            let temporary = FilmError.temporaryMediaFailure(item.error)
            Task { @MainActor in
                guard let self, self.generation == request else { return }
                self.stop()
                self.failure = temporary?.localizedDescription ?? String(localized: "Playback was interrupted. Reopen the film, or choose another copy in Files.")
            }
        }
        tick = prepared.addPeriodicTimeObserver(forInterval: CMTime(seconds: 1, preferredTimescale: 1000),
                                                 queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.generation == request else { return }
                self.save()
            }
        }
        isPresented = true
        prepared.play()
    }

    func end(_ item: AVPlayerItem?) {
        guard let item, item === player?.currentItem, let film else { return }
        library?.record(0, for: film, ended: true)
        finished = true
    }

    func save() {
        guard let player, let film else { return }
        if finished {
            // The native Replay control may start the same item again after its end.
            guard player.rate > 0 else { return }
            finished = false
        }
        let seconds = player.currentTime().seconds
        if film.lastPlayed == nil || abs(film.position - seconds) > 0.01 {
            library?.record(seconds, for: film)
        }
    }

    func stop() {
        let previous = generation
        generation = UUID()
        player?.pause()
        save()
        if let tick { player?.removeTimeObserver(tick) }
        tick = nil
        observation?.invalidate()
        observation = nil
        player?.replaceCurrentItem(with: nil)
        player = nil
        CinemaAudioSession.shared.release(previous)
        scopedURL?.stopAccessingSecurityScopedResource()
        scopedURL = nil
        film = nil
        library = nil
        finished = false
        isPresented = false
    }
}

private struct SystemFilmPlayer: UIViewControllerRepresentable {
    let player: AVPlayer
    func makeUIViewController(context: Context) -> AVPlayerViewController {
        let controller = AVPlayerViewController()
        controller.player = player
        controller.allowsPictureInPicturePlayback = false
        return controller
    }
    func updateUIViewController(_ controller: AVPlayerViewController, context: Context) {}
}

struct LocalPlayerHost: ViewModifier {
    @Environment(PlaybackCoordinator.self) private var playback
    @Environment(LocalLibrary.self) private var library
    @Environment(\.scenePhase) private var phase
    func body(content: Content) -> some View {
        @Bindable var playback = playback
        content
            .fullScreenCover(isPresented: $playback.isPresented, onDismiss: { if !playback.isPresented { playback.stop() } }) {
                if let player = playback.player {
                    SystemFilmPlayer(player: player)
                        .ignoresSafeArea()
                        .overlay(alignment: .topLeading) {
                            Button { playback.stop() } label: {
                                Image(systemName: "chevron.down").frame(width: 44, height: 44)
                            }
                            .foregroundStyle(.white).background(.black.opacity(0.75), in: Circle())
                            .padding(.horizontal).accessibilityLabel("Close player")
                            .accessibilityIdentifier("player.close").keyboardShortcut(.cancelAction)
                        }
                        .background(Color.black)
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: .AVPlayerItemDidPlayToEndTime)) {
                playback.end($0.object as? AVPlayerItem)
            }
            .onReceive(NotificationCenter.default.publisher(for: PlaybackCoordinator.localIntent)) {
                if ($0.object as? PlaybackCoordinator) !== playback { playback.stop() }
            }
            #if PAIRED
            .onReceive(NotificationCenter.default.publisher(for: .ravanServerPlaybackStarting)) { _ in playback.stop() }
            #endif
            .onReceive(NotificationCenter.default.publisher(for: AVAudioSession.interruptionNotification)) { note in
                if note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt == AVAudioSession.InterruptionType.began.rawValue {
                    playback.player?.pause()
                    playback.save()
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: AVAudioSession.routeChangeNotification)) { note in
                if note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue {
                    playback.player?.pause()
                    playback.save()
                }
            }
            .onChange(of: phase) { _, value in
                if value == .background { playback.player?.pause(); playback.save() }
            }
            .onDisappear { playback.stop() }
            .alert("Your cinema", isPresented: Binding(get: { playback.failure != nil || library.storageError != nil },
                                                      set: { if !$0 { playback.failure = nil; library.storageError = nil } })) {
                Button("OK") { playback.failure = nil; library.storageError = nil }
            } message: { Text(playback.failure ?? library.storageError ?? "") }
    }
}
