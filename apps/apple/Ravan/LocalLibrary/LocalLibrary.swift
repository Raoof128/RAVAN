import AVFoundation
import Foundation
import Observation
import SwiftData

enum LibrarySchemaV1: VersionedSchema {
    static let versionIdentifier = Schema.Version(1, 0, 0)
    static var models: [any PersistentModel.Type] { [Film.self] }

    @Model final class Film {
        @Attribute(.unique) var id: UUID
        var title: String
        var bookmark: Data?
        var isSample: Bool
        var isFavourite = false
        var position: Double = 0
        var duration: Double?
        var lastPlayed: Date?
        var needsRelink = false
        var ended = false

        init(id: UUID = UUID(), title: String, bookmark: Data? = nil, isSample: Bool = false) {
            self.id = id
            self.title = title
            self.bookmark = bookmark
            self.isSample = isSample
        }
    }
}

typealias LocalFilm = LibrarySchemaV1.Film

enum LibraryMigrationPlan: SchemaMigrationPlan {
    static var schemas: [any VersionedSchema.Type] { [LibrarySchemaV1.self] }
    static var stages: [MigrationStage] { [] }
}

enum FilmError: LocalizedError {
    case unavailable, unsupported, noSample, storage, downloading, offline, denied, audioInterrupted, audioOutput, resumeUnavailable, mediaBusy
    static func temporaryMediaFailure(_ error: Error?) -> FilmError? {
        guard let system = error as NSError?, system.domain == AVFoundationErrorDomain else { return nil }
        switch system.code {
        case AVError.mediaServicesWereReset.rawValue, AVError.decoderTemporarilyUnavailable.rawValue:
            return .mediaBusy
        default:
            return nil
        }
    }

    var errorDescription: String? {
        switch self {
        case .unavailable: String(localized: "This film could not be opened. Download it in Files or use Locate file to select it again.")
        case .downloading: String(localized: "Your Files provider is downloading this film. Open it again when the download finishes.")
        case .offline: String(localized: "This film is stored online. Reconnect and download it in Files to watch it offline.")
        case .denied: String(localized: "Access to the file has changed. Use Locate file to grant access again.")
        case .unsupported: String(localized: "The system player cannot play this film. Choose a compatible video such as an H.264 MP4.")
        case .audioInterrupted: String(localized: "Another activity is using audio. When it finishes, tap Play again.")
        case .audioOutput: String(localized: "Audio could not start. Check your audio output, then tap Play again.")
        case .mediaBusy: String(localized: "The system player is temporarily unavailable. Tap Play again in a moment.")
        case .resumeUnavailable: String(localized: "The player could not seek to the saved position. Try Play from beginning.")
        case .noSample: String(localized: "The bundled sample could not be opened.")
        case .storage: String(localized: "Your cinema could not save this change. Check the free space on your device and try again.")
        }
    }
}

@Observable @MainActor final class LocalLibrary {
    private let container: ModelContainer
    private let defaults: UserDefaults?
    private(set) var films: [LocalFilm]
    let sample: LocalFilm
    var storageError: String?
    var hasEntered: Bool { didSet { defaults?.set(hasEntered, forKey: "enteredLibrary") } }

    init(inMemory: Bool = false, defaults: UserDefaults? = .standard, storeURL: URL? = nil) throws {
        self.defaults = defaults
        hasEntered = defaults?.bool(forKey: "enteredLibrary") ?? false
        let schema = Schema(versionedSchema: LibrarySchemaV1.self)
        let config = storeURL.map { ModelConfiguration(schema: schema, url: $0, cloudKitDatabase: .none) }
            ?? ModelConfiguration(schema: schema, isStoredInMemoryOnly: inMemory, cloudKitDatabase: .none)
        container = try ModelContainer(for: schema, migrationPlan: LibraryMigrationPlan.self, configurations: config)
        let context = container.mainContext
        context.autosaveEnabled = false
        var stored = try context.fetch(FetchDescriptor<LocalFilm>(sortBy: [SortDescriptor(\.title)]))
        if let bundled = stored.first(where: \.isSample) {
            sample = bundled
        } else {
            let bundled = LocalFilm(title: "Tide Almanac", isSample: true)
            context.insert(bundled)
            try context.save()
            stored.insert(bundled, at: 0)
            sample = bundled
        }
        films = stored
    }

    func toggleFavourite(_ film: LocalFilm) {
        film.isFavourite.toggle()
        persist()
    }

    func forget(_ film: LocalFilm) {
        guard !film.isSample else { return }
        let id = film.id
        container.mainContext.delete(film)
        if persist() { films.removeAll { $0.id == id } }
    }

    func clearHistory() {
        for film in films {
            film.position = 0
            film.lastPlayed = nil
            film.ended = false
        }
        persist()
    }

    func importFilm(_ url: URL, replacing existing: LocalFilm? = nil) async throws -> LocalFilm {
        guard url.isFileURL, existing?.isSample != true else { throw FilmError.unavailable }
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let asset = AVURLAsset(url: url)
        let duration = try await Self.validate(asset)
        let bookmark: Data
        do { bookmark = try url.bookmarkData(options: .minimalBookmark, includingResourceValuesForKeys: nil, relativeTo: nil) }
        catch { throw FilmError.unavailable }
        try Task.checkCancellation()
        let title = url.deletingPathExtension().lastPathComponent
        // A fresh picker grant can open the same film in another window or on a later launch.
        // Match only a currently valid bookmark for this URL, never a filename.
        let known = existing ?? films.first { film in
            guard !film.needsRelink, let data = film.bookmark else { return false }
            var stale = false
            let resolved = try? URL(resolvingBookmarkData: data, options: [.withoutUI, .withoutMounting],
                                    relativeTo: nil, bookmarkDataIsStale: &stale)
            return !stale && resolved?.standardizedFileURL == url.standardizedFileURL
        }
        let film = known ?? LocalFilm(title: title)
        film.title = title
        film.bookmark = bookmark
        film.needsRelink = false
        film.duration = duration
        if known == nil { container.mainContext.insert(film) }
        guard persist() else { throw FilmError.storage }
        if known == nil { films.append(film) }
        return film
    }

    static func validate(_ asset: AVURLAsset) async throws -> Double? {
        do {
            let resources = try asset.url.resourceValues(forKeys: [.isUbiquitousItemKey, .ubiquitousItemDownloadingStatusKey, .ubiquitousItemDownloadingErrorKey])
            if resources.isUbiquitousItem == true, resources.ubiquitousItemDownloadingStatus == .notDownloaded {
                if resources.ubiquitousItemDownloadingError != nil { throw FilmError.offline }
                try FileManager.default.startDownloadingUbiquitousItem(at: asset.url)
                throw FilmError.downloading
            }
            guard try await asset.load(.isPlayable),
                  !(try await asset.loadTracks(withMediaType: .video)).isEmpty else { throw FilmError.unsupported }
            let seconds = try await asset.load(.duration).seconds
            return seconds.isFinite && seconds > 0 ? seconds : nil
        } catch let error as FilmError { throw error }
        catch {
            try Task.checkCancellation()
            if let temporary = FilmError.temporaryMediaFailure(error) { throw temporary }
            let nsError = error as NSError
            if nsError.domain == NSCocoaErrorDomain && nsError.code == NSFileReadNoPermissionError { throw FilmError.denied }
            if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorNotConnectedToInternet { throw FilmError.offline }
            if (error as NSError).domain == AVFoundationErrorDomain,
               [AVError.fileFormatNotRecognized.rawValue, AVError.decoderNotFound.rawValue].contains((error as NSError).code) {
                throw FilmError.unsupported
            }
            throw FilmError.unavailable
        }
    }

    func resolve(_ film: LocalFilm) throws -> URL {
        if film.isSample {
            guard let url = Bundle.main.url(forResource: "TideAlmanac", withExtension: "mp4") else { throw FilmError.noSample }
            return url
        }
        do {
            guard let bookmark = film.bookmark else { throw FilmError.unavailable }
            var stale = false
            let url = try URL(resolvingBookmarkData: bookmark, options: .withoutUI, relativeTo: nil, bookmarkDataIsStale: &stale)
            guard !stale, url.isFileURL else { throw FilmError.unavailable }
            return url
        } catch {
            film.needsRelink = true
            persist()
            throw FilmError.unavailable
        }
    }

    func trackLabels(for film: LocalFilm) async throws -> (audio: [String], captions: [String]) {
        let url = try resolve(film)
        let scoped = !film.isSample && url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let values = try url.resourceValues(forKeys: [.ubiquitousItemDownloadingStatusKey])
        guard values.ubiquitousItemDownloadingStatus != .notDownloaded else { return ([], []) }
        let asset = AVURLAsset(url: url)
        let audio = try await asset.loadMediaSelectionGroup(for: .audible)?.options.map(\.displayName) ?? []
        try Task.checkCancellation()
        let captions = try await asset.loadMediaSelectionGroup(for: .legible)?.options.map(\.displayName) ?? []
        return (audio, captions)
    }

    func record(_ seconds: Double, for film: LocalFilm, ended: Bool = false) {
        guard seconds.isFinite, seconds >= 0, films.contains(where: { $0.id == film.id }) else { return }
        film.ended = ended
        film.position = ended ? 0 : min(seconds, film.duration ?? seconds)
        film.lastPlayed = Date()
        persist()
    }

    @discardableResult func persist() -> Bool {
        do { try container.mainContext.save(); return true }
        catch {
            container.mainContext.rollback()
            storageError = FilmError.storage.localizedDescription
            return false
        }
    }
}
