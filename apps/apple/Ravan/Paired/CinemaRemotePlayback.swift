#if PAIRED
import AVKit
import SwiftUI

private struct ProgressReceipt: Decodable { let status: String }

@MainActor @Observable final class CinemaRemotePlayback {
    private(set) var owner: UUID?
    private(set) var player: AVPlayer?
    private(set) var title = ""
    private(set) var busy = false
    private(set) var job: CinemaJob?
    private(set) var conflict: CinemaPlayRequest?
    var message: String?
    private var lease: CinemaLease?
    private var audioOwner: UUID?
    private var loader: CinemaMediaLoader?
    private var heartbeat: Task<Void, Never>?
    private var itemObservation: NSKeyValueObservation?
    private var pauseObservation: NSKeyValueObservation?
    private var jumpObserver: NSObjectProtocol?
    private var checkpoint: Task<Void, Never>?
    private var sequence = 0
    private var ready = false
    private var seekingToStart = false
    private var revision = UUID()
    private weak var cinema: PairedCinema?
    private var activeSince: Date?

    func play(_ request: CinemaPlayRequest, title: String, window: UUID, on cinema: PairedCinema) async {
        guard !busy else { return }
        guard let account = cinema.account, let caps = cinema.discovery, cinema.isConnected else {
            message = CinemaFailure.offline.localizedDescription; promptWindow = window; return
        }
        let operation = UUID()
        revision = operation
        busy = true
        defer { if revision == operation { busy = false } }
        do {
            let reply = try JSONDecoder().decode(CinemaPlayReply.self, from: await cinema.data("/api/playback", "POST",
                body: JSONEncoder().encode(request), accepting: [200, 202, 409, 422]))
            guard cinema.account == account, revision == operation else {
                if cinema.account == account, let id = reply.session?.id { await release(id, on: cinema) }
                return
            }
            switch reply.kind {
            case "ready":
                guard let session = reply.session else { throw CinemaFailure.invalidReply }
                do {
                    let endpoint = try CinemaMediaEndpoint(ticketPath: session.mediaUrl, server: CinemaURL.origin(account.origin), discovery: caps)
                    _ = try CinemaURL.id(session.id)
                    guard session.startMs >= 0, session.epoch > 0 else { throw CinemaFailure.invalidReply }
                    abandon()
                    revision = operation; busy = true; audioOwner = operation
                    NotificationCenter.default.post(name: .ravanServerPlaybackStarting, object: nil)
                    try await CinemaAudioSession.shared.acquire(operation)
                    guard revision == operation, cinema.account == account, !Task.isCancelled else { throw CancellationError() }
                    self.cinema = cinema
                    let media = CinemaMediaLoader(endpoint)
                    let item = media.item()
                    self.lease = session
                    activeSince = .now
                    self.loader = media
                    let player = AVPlayer(playerItem: item)
                    player.allowsExternalPlayback = false
                    for (lang, characteristic) in [(CinemaLanguages.shared.audio, AVMediaCharacteristic.audible),
                                                   (CinemaLanguages.shared.subtitles, .legible)] {
                        if !lang.isEmpty {
                            player.setMediaSelectionCriteria(AVPlayerMediaSelectionCriteria(preferredLanguages: [lang], preferredMediaCharacteristics: nil),
                                                             forMediaCharacteristic: characteristic)
                        }
                    }
                    self.player = player
                    self.owner = window
                    self.title = title
                    itemObservation = item.observe(\.status, options: [.initial, .new]) { [weak self] _, _ in
                        Task { @MainActor in await self?.statusChanged(session.id) }
                    }
                    pauseObservation = player.observe(\.timeControlStatus, options: [.new]) { [weak self] player, _ in
                        guard player.timeControlStatus == .paused else { return }
                        Task { @MainActor in self?.checkpointPosition(session.id) }
                    }
                    jumpObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemTimeJumped, object: item, queue: .main) { [weak self] _ in
                        MainActor.assumeIsolated { self?.checkpointPosition(session.id) }
                    }
                    heartbeat = Task { [weak self] in await self?.maintain(session.id) }
                } catch {
                    CinemaAudioSession.shared.release(operation)
                    if audioOwner == operation { audioOwner = nil }
                    if cinema.account == account { await release(session.id, on: cinema) }
                    throw error
                }
            case "conflict":
                guard let id = reply.sessionId else { throw CinemaFailure.invalidReply }
                var retry = request
                retry.replaceSessionId = try CinemaURL.id(id)
                conflict = retry
                // Another window can ask before taking over this device's active screen.
                promptWindow = window; promptTitle = title
            case "preparing":
                guard let id = reply.preparationId else { throw CinemaFailure.invalidReply }
                var safe = request
                safe.replaceSessionId = nil
                let pending = CinemaJob(id: try CinemaURL.id(id), title: title, request: safe)
                try cinema.remember(pending)
                job = pending; promptWindow = window
            case "unsupported":
                message = reply.reason ?? String(localized: "The server cannot play this edition.")
                promptWindow = window
            default: throw CinemaFailure.invalidReply
            }
        } catch {
            if revision == operation, cinema.account == account, !Task.isCancelled, !(error is CancellationError) {
                message = cinemaMessage(error); promptWindow = window
            }
        }
    }
    var promptWindow: UUID?
    var promptTitle = ""

    func show(_ job: CinemaJob, in window: UUID) { self.job = job; promptWindow = window }

    func clearPrompt() {
        conflict = nil; job = nil; message = nil; promptWindow = nil
    }

    private func statusChanged(_ id: String) async {
        guard let player, let item = player.currentItem, let lease, lease.id == id else { return }
        switch item.status {
        case .readyToPlay:
            guard !ready, !seekingToStart else { return }
            seekingToStart = true
            defer { if self.lease?.id == id { seekingToStart = false } }
            if lease.startMs > 0 {
                let success = await player.seek(to: CMTime(value: Int64(lease.startMs), timescale: 1000),
                                                toleranceBefore: .zero, toleranceAfter: .zero)
                guard self.lease?.id == id else { return }
                guard success else { await interrupt(String(localized: "The player could not seek to your saved position.")); return }
            }
            ready = true
            player.play()
        case .failed:
            let temporary = FilmError.temporaryMediaFailure(item.error)
            await interrupt(temporary?.localizedDescription ?? String(localized: "The film could not be read over Wi-Fi. Check the connection and open the film again."))
        default: break
        }
    }

    private func progress(ended: Bool) -> CinemaProgress? {
        guard ready, let lease, let time = player?.currentTime().seconds,
              time.isFinite, time >= 0, time < Double(Int.max / 1000) else { return nil }
        sequence += 1
        return CinemaProgress(sessionId: lease.id, epoch: lease.epoch, sequence: sequence, positionMs: Int(time * 1000), ended: ended)
    }

    private func send(_ event: CinemaProgress, on cinema: PairedCinema) async throws -> Bool {
        let data = try await cinema.data("/api/progress", "POST", body: JSONEncoder().encode(event))
        return try JSONDecoder().decode(ProgressReceipt.self, from: data).status == "accepted"
    }

    private func checkpointPosition(_ id: String) {
        guard lease?.id == id, ready else { return }
        checkpoint?.cancel()
        checkpoint = Task { [weak self] in
            // Coalesce successive scrub events while keeping the settled seek
            // and pause independent of the periodic progress timer.
            do {
                try await Task.sleep(for: .milliseconds(180))
                guard let self, lease?.id == id, let cinema, let event = progress(ended: false) else { return }
                _ = try await send(event, on: cinema)
            } catch { /* The next tick or close retries with the latest position. */ }
        }
    }

    private func maintain(_ id: String) async {
        var ticks = 0
        while !Task.isCancelled && lease?.id == id {
            do {
                try await Task.sleep(for: .seconds(5))
                guard lease?.id == id, let cinema else { return }
                if !ready && Date.now.timeIntervalSince(activeSince ?? .now) > 45 {
                    await interrupt(String(localized: "The server took too long to load this film. Open the film again to retry."))
                    return
                }
                ticks += 1
                if let event = progress(ended: false) { _ = try await send(event, on: cinema) }
                if ticks.isMultiple(of: 6) {
                    let bytes = try await cinema.data("/api/playback/" + CinemaURL.id(id) + "/heartbeat", "POST")
                    let renewed = try JSONDecoder().decode(CinemaLease.self, from: bytes)
                    guard lease?.id == id else { return }
                    guard renewed.id == id, renewed.epoch == lease?.epoch,
                          let origin = cinema.account?.origin, let caps = cinema.discovery else { throw CinemaFailure.identity }
                    loader?.renew(try CinemaMediaEndpoint(ticketPath: renewed.mediaUrl, server: CinemaURL.origin(origin), discovery: caps))
                }
            } catch {
                guard !Task.isCancelled, lease?.id == id else { return }
                await cinema?.recheckIdentity()
                if lease?.id == id {
                    await interrupt(String(localized: "Playback stopped. Check your connection, then open the film again."))
                }
                return
            }
        }
    }

    private func interrupt(_ text: String) async {
        await stop(interruption: text)
    }

    private func release(_ id: String, on cinema: PairedCinema) async {
        _ = try? await cinema.data("/api/playback/" + CinemaURL.id(id), "DELETE", accepting: [204])
    }

    func stop(ended: Bool = false, interruption: String? = nil) async {
        guard let lease, let cinema, let account = cinema.account else { abandon(); return }
        player?.pause()
        let event = progress(ended: ended), window = owner
        abandon()
        if let interruption { message = interruption; promptWindow = window }
        // A heartbeat can discover its own failure. Teardown cancels that task;
        // flushing the last position and releasing the lease still have to run.
        await Task { @MainActor in
            guard cinema.account == account else { return }
            if let event {
                do { try cinema.queueFinalProgress(event); await cinema.flushProgress() }
                catch { _ = try? await send(event, on: cinema) }
            }
            if cinema.account == account {
                await release(lease.id, on: cinema)
                cinema.changed += 1
            }
        }.value
    }

    func abandon() {
        revision = UUID(); busy = false
        heartbeat?.cancel(); heartbeat = nil
        checkpoint?.cancel(); checkpoint = nil
        pauseObservation?.invalidate(); pauseObservation = nil
        if let jumpObserver { NotificationCenter.default.removeObserver(jumpObserver) }
        jumpObserver = nil
        itemObservation?.invalidate(); itemObservation = nil
        player?.pause(); player?.replaceCurrentItem(with: nil)
        if let audioOwner { CinemaAudioSession.shared.release(audioOwner) }; audioOwner = nil
        loader?.stop()
        player = nil; loader = nil; lease = nil; owner = nil
        ready = false; seekingToStart = false; sequence = 0; cinema = nil
        clearPrompt()
    }
}

extension EnvironmentValues {
    @Entry var cinemaWindowID = UUID()
}

private struct RemoteSystemPlayer: UIViewControllerRepresentable {
    let player: AVPlayer
    func makeUIViewController(context: Context) -> AVPlayerViewController {
        let controller = AVPlayerViewController()
        controller.player = player
        controller.allowsPictureInPicturePlayback = false
        return controller
    }
    func updateUIViewController(_ controller: AVPlayerViewController, context: Context) {}
}

struct ServerPlaybackHost: ViewModifier {
    let returnToLibrary: () -> Void
    @Environment(PairedCinema.self) private var cinema
    @Environment(\.scenePhase) private var scene
    @State private var window = UUID()
    func body(content: Content) -> some View {
        let playback = cinema.playback
        content.environment(\.cinemaWindowID, window)
            .fullScreenCover(isPresented: Binding(get: { playback.owner == window && playback.player != nil }, set: { visible in
                if !visible && playback.owner == window { Task { await playback.stop() } }
            })) {
                if let player = playback.player {
                    RemoteSystemPlayer(player: player).ignoresSafeArea()
                        .overlay(alignment: .topLeading) {
                            Button { Task { await playback.stop() } } label: {
                                Image(systemName: "chevron.down").frame(width: 44, height: 44)
                            }.foregroundStyle(.white).background(.black.opacity(0.8), in: Circle()).padding()
                            .accessibilityLabel("Close player").keyboardShortcut(.cancelAction)
                            .accessibilityIdentifier("player.close")
                        }
                        .onReceive(NotificationCenter.default.publisher(for: .AVPlayerItemDidPlayToEndTime)) { n in
                            if (n.object as? AVPlayerItem) === player.currentItem { Task { await playback.stop(ended: true) } }
                        }
                }
            }
            .alert("Another film is playing", isPresented: Binding(get: { playback.promptWindow == window && playback.conflict != nil }, set: { _ in })) {
                Button("Keep playing there", role: .cancel) { playback.clearPrompt() }
                Button("Play here instead") {
                    guard let request = playback.conflict else { return }
                    let title = playback.promptTitle
                    playback.clearPrompt()
                    Task { await playback.play(request, title: title, window: window, on: cinema) }
                }.accessibilityIdentifier("player.takeover.confirm")
            } message: { Text("Starting here will end the active session.") }
            .alert("Screening unavailable", isPresented: Binding(get: { playback.promptWindow == window && playback.message != nil }, set: { _ in })) {
                Button("OK") { playback.clearPrompt() }
            } message: { Text(playback.message ?? "") }
            .sheet(item: Binding(get: { playback.promptWindow == window ? playback.job : nil },
                                 set: { if $0 == nil && playback.promptWindow == window && playback.job != nil { playback.clearPrompt() } })) { job in
                ServerPreparationView(job: job, window: window, foreground: scene != .background, returnToLibrary: returnToLibrary)
            }
            .onReceive(NotificationCenter.default.publisher(for: AVAudioSession.interruptionNotification)) { note in
                if playback.owner == window, note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt == AVAudioSession.InterruptionType.began.rawValue {
                    playback.player?.pause()
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: AVAudioSession.routeChangeNotification)) { note in
                if playback.owner == window, note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue {
                    playback.player?.pause()
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: .ravanLocalPlaybackStarting)) { _ in
                if playback.owner == window || playback.busy { Task { await playback.stop() } }
            }
            .onChange(of: scene) { _, phase in
                if phase == .active { Task { await cinema.foreground() } }
                if phase == .background, playback.owner == window { Task { await playback.stop() } }
            }
            .onDisappear { if playback.owner == window { Task { await playback.stop() } } }
    }
}
#endif
