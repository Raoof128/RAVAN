#if PAIRED
import AVFoundation
import Foundation
import UniformTypeIdentifiers

/// Each native resource request uses only its ticket. The loader also mediates requests
/// after the first seek, so a later redirect cannot escape the deployment's allowlist.
struct CinemaMediaEndpoint: Sendable {
    let url: URL
    let origins: Set<URL>
    init(ticketPath: String, server: URL, discovery: CinemaDiscovery) throws {
        guard ticketPath.range(of: #"^/media/s/[A-Za-z0-9_-]{43}/(raw|video\.mp4)$"#,
                               options: .regularExpression) != nil,
              let url = URL(string: ticketPath, relativeTo: server)?.absoluteURL else {
            throw CinemaFailure.invalidMedia
        }
        self.url = url
        origins = try Set(discovery.mediaOrigins.map(CinemaURL.origin)).union([server])
    }
    func permits(_ next: URL) -> Bool {
        guard var parts = URLComponents(url: next, resolvingAgainstBaseURL: false),
              parts.percentEncodedPath == url.path, parts.query == nil, parts.fragment == nil else { return false }
        parts.path = ""
        guard let raw = parts.string, let origin = try? CinemaURL.origin(raw) else { return false }
        return origins.contains(origin)
    }
}

private final class RangeTransfer: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    // All mutable fields below are touched on the serial delegate queue after start().
    private let endpoint: CinemaMediaEndpoint
    private let range: Range<Int64>
    private var data = Data()
    private var redirects = 0
    private var total: Int64?
    // Cancellation may arrive before the continuation is registered.
    private let launchLock = NSLock()
    private var started = false
    private var cancelled = false
    private var callback: CheckedContinuation<(Data, Int64), Error>?
    init(_ endpoint: CinemaMediaEndpoint, _ range: Range<Int64>) { self.endpoint = endpoint; self.range = range }

    func fetch(configuration config: URLSessionConfiguration) async throws -> (Data, Int64) {
        config.allowsCellularAccess = false
        let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        var request = URLRequest(url: endpoint.url)
        request.setValue("bytes=\(range.lowerBound)-\(range.upperBound - 1)", forHTTPHeaderField: "Range")
        request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        let task = session.dataTask(with: request)
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                launchLock.withLock {
                    callback = continuation
                    started = true
                    task.resume()
                    if cancelled { task.cancel() }
                }
            }
        } onCancel: {
            self.launchLock.withLock {
                self.cancelled = true
                if self.started { task.cancel() }
            }
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        guard response.statusCode == 307, redirects < 2, let url = request.url, endpoint.permits(url) else {
            completionHandler(nil); return
        }
        redirects += 1
        var redirected = URLRequest(url: url)
        redirected.allowsCellularAccess = false
        redirected.setValue("bytes=\(range.lowerBound)-\(range.upperBound - 1)", forHTTPHeaderField: "Range")
        redirected.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        completionHandler(redirected)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let http = response as? HTTPURLResponse, http.statusCode == 206,
              let raw = http.value(forHTTPHeaderField: "Content-Range"), raw.hasPrefix("bytes "),
              let length = Int64(raw.split(separator: "/").last ?? ""), length > range.lowerBound,
              raw == "bytes \(range.lowerBound)-\(min(length, range.upperBound) - 1)/\(length)",
              http.expectedContentLength == min(length, range.upperBound) - range.lowerBound
        else { completionHandler(.cancel); return }
        total = length
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard data.count <= range.count - self.data.count else { dataTask.cancel(); return }
        self.data.append(data)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        defer { callback = nil }
        if let error { callback?.resume(throwing: error) }
        else if let total, data.count == min(range.upperBound, total) - range.lowerBound {
            callback?.resume(returning: (data, total))
        } else { callback?.resume(throwing: CinemaFailure.invalidMedia) }
    }
}

@MainActor
final class CinemaMediaLoader: NSObject, @preconcurrency AVAssetResourceLoaderDelegate {
    private var endpoint: CinemaMediaEndpoint
    private var requests = [ObjectIdentifier: Task<Void, Never>]()
    private let makeConfiguration: @Sendable () -> URLSessionConfiguration
    private let assetURL = URL(string: "ravan-film://screening/film.mp4")!
    init(_ endpoint: CinemaMediaEndpoint, makeConfiguration: @escaping @Sendable () -> URLSessionConfiguration = cinemaConfiguration) {
        self.endpoint = endpoint
        self.makeConfiguration = makeConfiguration
    }

    func item() -> AVPlayerItem {
        let asset = AVURLAsset(url: assetURL, options: [AVURLAssetAllowsCellularAccessKey: false])
        asset.resourceLoader.setDelegate(self, queue: .main)
        return AVPlayerItem(asset: asset)
    }
    // The resource and edition are unchanged on renewal. Replacing only the
    // ticket keeps the current AVPlayerItem, position, pause and track choice.
    func renew(_ next: CinemaMediaEndpoint) { endpoint = next }

    func resourceLoader(_ resourceLoader: AVAssetResourceLoader,
                        shouldWaitForLoadingOfRequestedResource request: AVAssetResourceLoadingRequest) -> Bool {
        guard request.request.url == assetURL else { return false }
        let key = ObjectIdentifier(request)
        requests[key] = Task { [weak self] in
            guard let self else { return }
            defer { requests.removeValue(forKey: key) }
            do {
                let dataRequest = request.dataRequest
                var offset = max(dataRequest?.requestedOffset ?? 0, dataRequest?.currentOffset ?? 0)
                var limit: Int64
                if let dataRequest {
                    let (end, overflow) = dataRequest.requestedOffset.addingReportingOverflow(Int64(dataRequest.requestedLength))
                    guard offset >= 0, dataRequest.requestedLength >= 0 else { throw CinemaFailure.invalidMedia }
                    limit = dataRequest.requestsAllDataToEndOfResource || overflow ? Int64.max : end
                } else { limit = 1 }
                repeat {
                    try Task.checkCancellation()
                    let count = min(limit - offset, 1_048_576)
                    guard count > 0 else { break }
                    let (chunk, length) = try await RangeTransfer(endpoint, offset..<(offset + count)).fetch(configuration: makeConfiguration())
                    try Task.checkCancellation()
                    if let info = request.contentInformationRequest {
                        let type = UTType.mpeg4Movie.identifier
                        guard info.allowedContentTypes?.contains(type) != false else { throw CinemaFailure.invalidMedia }
                        info.contentType = type
                        info.contentLength = length
                        info.isByteRangeAccessSupported = true
                    }
                    dataRequest?.respond(with: chunk)
                    offset += Int64(chunk.count)
                    limit = min(limit, length)
                } while offset < limit
                if !request.isCancelled { request.finishLoading() }
            } catch {
                if !request.isCancelled { request.finishLoading(with: CinemaFailure.invalidMedia) }
            }
        }
        return true
    }
    func resourceLoader(_ resourceLoader: AVAssetResourceLoader, didCancel request: AVAssetResourceLoadingRequest) {
        requests.removeValue(forKey: ObjectIdentifier(request))?.cancel()
    }
    func stop() { requests.values.forEach { $0.cancel() }; requests.removeAll() }
}
#endif
