import AVFoundation
import SwiftData
import UIKit
import XCTest
@testable import Ravan
#if RAVAN_UPGRADE_FIXTURE
import CryptoKit
#endif

extension XCTestCase {
    @MainActor func requireForegroundPlaybackHost() async throws {
        let app = UIApplication.shared
        let deadline = ContinuousClock.now + .seconds(12)
        // The host may begin executing tests before iOS grants its scene foreground playback.
        while app.applicationState != .active || !app.connectedScenes.contains(where: { $0.activationState == .foregroundActive }) {
            guard ContinuousClock.now < deadline else {
                let state: String
                switch app.applicationState {
                case .active: state = "active"
                case .inactive: state = "inactive"
                case .background: state = "background"
                @unknown default: state = "unknown"
                }
                let foreground = app.connectedScenes.filter { $0.activationState == .foregroundActive }.count
                throw NSError(domain: "Ravan.PlaybackHost", code: 1, userInfo: [
                    NSLocalizedDescriptionKey: "Playback host did not reach the foreground within 12 seconds. Application state: \(state). Foreground-active scenes: \(foreground)."
                ])
            }
            try await Task.sleep(for: .milliseconds(100))
        }
    }
}

extension AVMediaSelectionOption {
    var fixtureLanguageCode: String {
        let tag = extendedLanguageTag ?? locale?.identifier ?? ""
        return String(tag.lowercased().prefix { $0 != "-" && $0 != "_" })
    }
}

@MainActor final class LocalCinemaTests: XCTestCase {
    private func cleanFixtureAfterTest(_ library: LocalLibrary, store: URL) throws {
        let container = try XCTUnwrap(library.sample.modelContext?.container)
        let configuredURLs = container.configurations.map { $0.url.standardizedFileURL }
        guard configuredURLs == [store.standardizedFileURL] else {
            XCTFail("Cleanup requires the fixture's own store.")
            return
        }
        // SwiftData closes its SQLite storage before XCTest removes the directory.
        try container.erase()
        let directory = store.deletingLastPathComponent()
        addTeardownBlock { try FileManager.default.removeItem(at: directory) }
    }

    #if RAVAN_PERFORMANCE_FIXTURE
    func testRepeatedLocalPlaybackDeliversFramesAndCloses() async throws {
        let library = try LocalLibrary(inMemory: true, defaults: nil)
        let cinema = PlaybackCoordinator()
        var milliseconds = [Double]()
        try await requireForegroundPlaybackHost()
        for _ in 0..<20 {
            let start = ProcessInfo.processInfo.systemUptime
            try await cinema.play(library.sample, library: library, fromBeginning: true)
            let player = try XCTUnwrap(cinema.player)
            player.isMuted = true
            let item = try XCTUnwrap(player.currentItem)
            let output = AVPlayerItemVideoOutput(pixelBufferAttributes: nil)
            item.add(output)
            defer {
                item.remove(output)
                cinema.stop()
            }
            var delivered = false
            while ProcessInfo.processInfo.systemUptime - start < 6 {
                if output.hasNewPixelBuffer(forItemTime: player.currentTime()) {
                    delivered = true
                    break
                }
                try await Task.sleep(for: .milliseconds(12))
            }
            guard delivered else { XCTFail("The sample did not deliver its first decoded video frame."); return }
            milliseconds.append((ProcessInfo.processInfo.systemUptime - start) * 1000)
        }
        XCTAssertNil(cinema.player)
        XCTAssertFalse(cinema.isPresented)
        let sorted = milliseconds.sorted()
        let median = (sorted[9] + sorted[10]) / 2
        let result = XCTAttachment(string: String(format: "Local play requests: %d; median: %.0f ms; p95: %.0f ms; first: %.0f ms",
                                                   sorted.count, median, sorted[18], milliseconds[0]))
        result.name = "Bundled film decoded first frame"
        result.lifetime = .keepAlways
        add(result)
    }
    #endif

    func testTemporaryDecoderAndMediaServiceErrorsPreserveFileAccess() {
        for code in [AVError.mediaServicesWereReset, AVError.decoderTemporarilyUnavailable] {
            let error = NSError(domain: AVFoundationErrorDomain, code: code.rawValue)
            XCTAssertEqual(FilmError.temporaryMediaFailure(error), .mediaBusy)
        }
        let missing = NSError(domain: NSCocoaErrorDomain, code: NSFileReadNoSuchFileError)
        XCTAssertNil(FilmError.temporaryMediaFailure(missing))
    }

    func testCollectionColumnsAdaptToWindowAndReadableTextWidth() {
        XCTAssertEqual(CinemaColumnLayout(width: 430, regular: false, typeScale: 1), .stacked)
        XCTAssertEqual(CinemaColumnLayout(width: 844, regular: false, typeScale: 1), .stacked)
        XCTAssertEqual(CinemaColumnLayout(width: 700, regular: true, typeScale: 1), .stacked)
        XCTAssertEqual(CinemaColumnLayout(width: 820, regular: true, typeScale: 1), .twoColumns)
        XCTAssertEqual(CinemaColumnLayout(width: 1194, regular: true, typeScale: 1), .threeColumns)
        XCTAssertEqual(CinemaColumnLayout(width: 1194, regular: true, typeScale: 1.5), .twoColumns)
        XCTAssertEqual(CinemaColumnLayout(width: 1194, regular: true, typeScale: 2.5), .stacked)
    }

    #if RAVAN_UPGRADE_FIXTURE
    private struct UpgradeWitness: Codable {
        let importedID: UUID
        let sampleID: UUID
        let bookmarkDigest: Data
    }

    private func requireUpgrade(_ condition: Bool, _ message: String) throws {
        guard condition else {
            throw NSError(domain: "Ravan.UpgradeFixture", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: message])
        }
    }

    func testFilesToPairedPersistentUpgrade() async throws {
        try requireUpgrade(CinemaLaunch.testSession != nil, "Use the isolated test host for both upgrade phases.")
        let files = FileManager.default
        let support = try files.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                    appropriateFor: nil, create: true)
        // The same isolated host bundle owns this exact directory across an in-place update.
        let folder = support.appendingPathComponent("Ravan-XCTest-Upgrade-C8EA2D6D-8C40-4B4D-95D7-F71AA2F4276B",
                                                   isDirectory: true)
        let store = folder.appendingPathComponent("fixture.store")
        let filmURL = folder.appendingPathComponent("Owned upgrade fixture.mp4")
        let witnessURL = folder.appendingPathComponent("witness.json")
        let position = 27.25
        #if !PAIRED
        if !files.fileExists(atPath: folder.path) {
            try files.createDirectory(at: folder, withIntermediateDirectories: false)
            let library = try LocalLibrary(defaults: nil, storeURL: store)
            try files.copyItem(at: library.resolve(library.sample), to: filmURL)
            let film = try await library.importFilm(filmURL)
            library.toggleFavourite(film)
            library.record(position, for: film)
            let bookmark = try XCTUnwrap(film.bookmark)
            try requireUpgrade(!bookmark.isEmpty && library.storageError == nil, "Cannot persist the upgrade seed.")
            let witness = UpgradeWitness(importedID: film.id, sampleID: library.sample.id,
                                         bookmarkDigest: Data(SHA256.hash(data: bookmark)))
            try JSONEncoder().encode(witness).write(to: witnessURL, options: .atomic)
        }
        #endif
        // On a retry validate the original witness. Recreating a missing store or bookmark
        // after an update would turn an accidental clean install into a false pass.
        let folderType = try folder.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        try requireUpgrade(folderType.isDirectory == true && folderType.isSymbolicLink != true,
                           "The isolated upgrade directory is unavailable.")
        for item in [witnessURL, store, filmURL] {
            let type = try item.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
            try requireUpgrade(type.isRegularFile == true && type.isSymbolicLink != true,
                               "The isolated upgrade witness, media or store is missing.")
        }
        let witness = try JSONDecoder().decode(UpgradeWitness.self, from: Data(contentsOf: witnessURL))
        do {
            let library = try LocalLibrary(defaults: nil, storeURL: store)
            let film = try XCTUnwrap(library.films.first { $0.id == witness.importedID })
            try requireUpgrade(library.films.count == 2 && library.sample.id == witness.sampleID && !film.isSample,
                               "The original sample or imported film identity did not survive.")
            try requireUpgrade(film.isFavourite && film.position == position && !film.needsRelink && !film.ended,
                               "The watchlist, resume position or link state changed.")
            let bookmark = try XCTUnwrap(film.bookmark)
            try requireUpgrade(!bookmark.isEmpty && Data(SHA256.hash(data: bookmark)) == witness.bookmarkDigest,
                               "The saved bookmark changed.")
            #if PAIRED
            let resolved = try library.resolve(film)
            let scoped = resolved.startAccessingSecurityScopedResource()
            defer { if scoped { resolved.stopAccessingSecurityScopedResource() } }
            try requireUpgrade(resolved.resolvingSymlinksInPath().standardizedFileURL ==
                               filmURL.resolvingSymlinksInPath().standardizedFileURL,
                               "The upgraded bookmark did not resolve to the owned copy.")
            let audioOwner = UUID()
            try await requireForegroundPlaybackHost()
            try await CinemaAudioSession.shared.acquire(audioOwner)
            let item = AVPlayerItem(url: resolved)
            let player = AVPlayer(playerItem: item)
            player.isMuted = true
            defer {
                player.pause()
                player.replaceCurrentItem(with: nil)
                CinemaAudioSession.shared.release(audioOwner)
            }
            let sought = await player.seek(to: CMTime(seconds: film.position, preferredTimescale: 600),
                                           toleranceBefore: .zero, toleranceAfter: .zero)
            try requireUpgrade(sought && abs(player.currentTime().seconds - position) < 1,
                               "The imported film could not resume from its saved position.")
            player.play()
            let deadline = ContinuousClock.now + .seconds(20)
            while player.currentTime().seconds < position + 0.3 && item.status != .failed && ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(50))
            }
            try requireUpgrade(item.status == .readyToPlay && player.currentTime().seconds >= position + 0.3,
                               "The upgraded bookmark could not play the owned film.")
            try cleanFixtureAfterTest(library, store: store)
            #endif
        }
    }
    #endif

    func testBookmarksFavouritesAndProgressSurviveRelaunch() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let db = folder.appendingPathComponent("test.store")
        let firstURL = folder.appendingPathComponent("one/film.mp4")
        let secondURL = folder.appendingPathComponent("two/film.mp4")
        var originalID: UUID?
        do {
            let library = try LocalLibrary(defaults: nil, storeURL: db)
            for url in [firstURL, secondURL] {
                try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
                try FileManager.default.copyItem(at: library.resolve(library.sample), to: url)
            }
            let first = try await library.importFilm(firstURL)
            let second = try await library.importFilm(secondURL)
            XCTAssertNotEqual(first.id, second.id)
            library.toggleFavourite(first)
            library.record(30.75, for: first)
            originalID = first.id
        }
        let library = try LocalLibrary(defaults: nil, storeURL: db)
        let film = try XCTUnwrap(library.films.first { $0.id == originalID })
        XCTAssertTrue(film.isFavourite)
        XCTAssertEqual(film.position, 30.75)
        let reopened = try await library.importFilm(firstURL)
        XCTAssertEqual(reopened.id, film.id)
        XCTAssertTrue(reopened.isFavourite)
        XCTAssertEqual(reopened.position, 30.75)
        XCTAssertEqual(library.films.filter { !$0.isSample }.count, 2)
        XCTAssertEqual(try library.resolve(film).lastPathComponent, "film.mp4")
        library.clearHistory()
        XCTAssertNil(film.lastPlayed)
        XCTAssertEqual(film.position, 0)
        library.forget(film)
        XCTAssertEqual(library.films.filter { !$0.isSample }.count, 1)
        XCTAssertTrue(FileManager.default.fileExists(atPath: firstURL.path))
        try cleanFixtureAfterTest(library, store: db)
    }

    func testSampleTracksSeekResumeAndCompletion() async throws {
        let library = try LocalLibrary(inMemory: true)
        let film = library.sample
        let asset = AVURLAsset(url: try library.resolve(film))
        let group = try await asset.loadMediaSelectionGroup(for: .legible)
        let options = try XCTUnwrap(group).options
        let subtitleTracks = try await asset.loadTracks(withMediaType: .subtitle)
        var embeddedLanguages = Set<String>()
        for track in subtitleTracks {
            if let code = try await track.load(.languageCode) { embeddedLanguages.insert(code) }
        }
        let english = Set(["en", "eng"])
        let persian = Set(["fa", "fas", "per"])
        XCTAssertFalse(embeddedLanguages.isDisjoint(with: english))
        XCTAssertFalse(embeddedLanguages.isDisjoint(with: persian))
        let selectable = Set(options.filter(\.isPlayable).map(\.fixtureLanguageCode))
        XCTAssertFalse(selectable.isDisjoint(with: english))
        XCTAssertFalse(selectable.isDisjoint(with: persian))
        // Keep device-specific AVFoundation choices visible alongside the two encoded subtitle tracks.
        let catalog = options.map { option in
            [option.fixtureLanguageCode, option.mediaType.rawValue, option.displayName,
             option.hasMediaCharacteristic(.containsOnlyForcedSubtitles) ? "forced" : "full"].joined(separator: " / ")
        }
        let detail = XCTAttachment(string: catalog.joined(separator: "\n"))
        detail.name = "Bundled sample subtitle options"
        detail.lifetime = .keepAlways
        add(detail)
        let labels = try await library.trackLabels(for: film)
        XCTAssertEqual(labels.captions, options.map(\.displayName))
        let player = PlaybackCoordinator()
        try await requireForegroundPlaybackHost()
        try await player.play(film, library: library)
        let first = try XCTUnwrap(player.player)
        first.pause()
        let success = await first.seek(to: CMTime(seconds: 34, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
        XCTAssertTrue(success)
        player.stop()
        XCTAssertEqual(film.position, 34, accuracy: 2)
        try await player.play(film, library: library)
        XCTAssertEqual(try XCTUnwrap(player.player).currentTime().seconds, 34, accuracy: 2)
        player.player?.pause()
        player.end(player.player?.currentItem)
        player.stop()
        XCTAssertTrue(film.ended)
        XCTAssertEqual(film.position, 0)
    }
}
