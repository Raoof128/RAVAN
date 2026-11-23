#if PAIRED
import SwiftUI
import Accessibility

struct ServerConnectionView: View {
    @Environment(PairedCinema.self) private var cinema
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var phase
    @State private var address = ""
    @State private var name = UIDevice.current.userInterfaceIdiom == .pad ? "My iPad" : "My iPhone"
    @State private var client: CinemaAPI?
    @State private var discovery: CinemaDiscovery?
    @State private var challenge: CinemaChallenge?
    @State private var issue: String?
    @State private var busy = false
    @State private var operation: Task<Void, Never>?
    @State private var confirmDisconnect = false
    @FocusState private var nameFocused: Bool
    @State private var addressFocusRequest = 0
    @ScaledMetric(relativeTo: .body) private var inputHeight: CGFloat = 26

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if cinema.hasRememberedServer {
                        section("Personal server") {
                            Text(cinema.account?.origin ?? "")
                            if let notice = cinema.notice { Text(notice) }
                            Button("Reconnect") { run { await cinema.restore(explicit: true) } }.disabled(busy || cinema.restoring)
                            Button("Disconnect", role: .destructive) { confirmDisconnect = true }
                        }
                    } else if let challenge, let client {
                        section("Approve this device") {
                            Text("Enter this code in Your Cinema on your server.")
                            let grouped = String(challenge.code.prefix(4)) + " " + String(challenge.code.suffix(4))
                            Text(verbatim: grouped).font(.largeTitle.monospaced()).textSelection(.enabled)
                                .minimumScaleFactor(0.55).lineLimit(1).privacySensitive()
                                .accessibilityLabel(challenge.code.map(String.init).joined(separator: " "))
                                .accessibilityIdentifier("pairing.code")
                            Button("Copy code", systemImage: "doc.on.doc") {
                                UIPasteboard.general.setItems([["public.utf8-plain-text": challenge.code]],
                                    options: [.localOnly: true, .expirationDate: challenge.expiry ?? Date()])
                            }
                            if let expiry = challenge.expiry { Text("Expires at \(expiry.formatted(date: .omitted, time: .shortened))") }
                            if let approve = URL(string: client.origin.absoluteString + "/#/settings") {
                                Link("Approve in Browser", destination: approve)
                            }
                            Button("Get a new code") {
                                do { try cinema.clearChallenge(); self.challenge = nil; issue = nil; startPairing() }
                                catch { issue = cinemaMessage(error) }
                            }.disabled(busy)
                            Button("Change server") {
                                do { try cinema.clearChallenge(); self.challenge = nil; self.client = nil; discovery = nil; issue = nil }
                                catch { issue = cinemaMessage(error) }
                            }
                        }
                    } else {
                        section("Server address") {
                            CinemaTextInput(text: $address, focusRequest: addressFocusRequest,
                                            label: String(localized: "Server address"), identifier: "server.address",
                                            keyboard: .URL, returnKey: .go, submit: checkServer)
                                .frame(height: max(48, inputHeight + 12))
                                .padding(.horizontal, 12)
                                .background(CinemaTheme.panel, in: RoundedRectangle(cornerRadius: 10))
                                .overlay { RoundedRectangle(cornerRadius: 10).strokeBorder(CinemaTheme.hairline) }
                                .onChange(of: address) { _, _ in operation?.cancel(); client = nil; discovery = nil; issue = nil }
                            Text("Use the HTTPS address from your cinema’s owner.")
                                .font(.subheadline).foregroundStyle(CinemaTheme.ink)
                                .fixedSize(horizontal: false, vertical: true)
                            if let host = (try? CinemaURL.origin(address))?.host() { LabeledContent("Host", value: host) }
                            Text("Connecting to a server on your Wi-Fi may ask for local network access.")
                                .font(.footnote).foregroundStyle(CinemaTheme.muted)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        if client == nil {
                            Button(action: checkServer) {
                                Text("Check server").font(.headline).fixedSize(horizontal: false, vertical: true)
                            }
                                .buttonStyle(CinemaPrimaryButtonStyle())
                                .disabled(busy)
                                .accessibilityIdentifier("server.check")
                        } else {
                            section("This device") {
                                TextField("Device name", text: $name)
                                    .textFieldStyle(.roundedBorder).frame(minHeight: 48)
                                    .focused($nameFocused).submitLabel(.go).onSubmit { startPairing() }
                                    .accessibilityIdentifier("server.name")
                                Button("Get pairing code") { startPairing() }
                                    .buttonStyle(CinemaPrimaryButtonStyle()).disabled(busy || !validName)
                            }
                        }
                    }
                    if busy || cinema.restoring { ProgressView("Contacting your server") }
                    if let issue { Text(issue).foregroundStyle(CinemaTheme.ink) }
                }
                .padding(20)
                .frame(maxWidth: 620, alignment: .leading)
                .frame(maxWidth: .infinity)
            }
            .background(CinemaTheme.background)
            .navigationTitle("Connect a Server").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button {
                        try? cinema.clearChallenge()
                        dismiss()
                    } label: {
                        Image(systemName: "xmark").frame(minWidth: 44, minHeight: 44)
                    }
                    .accessibilityLabel("Close").accessibilityIdentifier("server.close")
                    .keyboardShortcut(.cancelAction)
                }
            }
        }
        .confirmationDialog("Disconnect this device?", isPresented: $confirmDisconnect) {
            Button("Disconnect", role: .destructive) { run { await cinema.disconnect() } }
        }
        .onChange(of: issue) { _, text in if let text { AccessibilityNotification.Announcement(text).post() } }
        .task {
            guard !cinema.hasRememberedServer else { return }
            do {
                guard let pending = try cinema.recoverChallenge() else { return }
                address = pending.origin
                let candidate = CinemaAPI(origin: try CinemaURL.origin(pending.origin))
                let caps = try await candidate.discover()
                try Task.checkCancellation()
                guard address == pending.origin, challenge == nil else { return }
                guard pending.instance == caps.instanceId else {
                    try cinema.clearChallenge(); throw CinemaFailure.identity
                }
                client = candidate; discovery = caps; challenge = pending.challenge
            } catch { if !Task.isCancelled { issue = cinemaMessage(error) } }
        }
        .task(id: [phase == .active ? "active" : "", challenge?.id ?? ""]) {
            guard phase == .active, let challenge, let client, let discovery else { return }
            await poll(challenge, client, discovery)
        }
        .onChange(of: cinema.isConnected) { _, online in if online { dismiss() } }
        .onDisappear { operation?.cancel() }
    }
    private func section<Content: View>(_ title: LocalizedStringKey, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            CinemaSectionTitle(text: title)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var deviceName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var validName: Bool { !deviceName.isEmpty && deviceName.utf16.count <= 80 }

    private func run(_ work: @escaping @MainActor () async throws -> Void) {
        guard !busy else { return }
        issue = nil; busy = true
        operation = Task {
            defer { busy = false }
            do { try await work() }
            catch { if !Task.isCancelled { issue = cinemaMessage(error) } }
        }
    }
    private func checkServer() {
        guard !address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            issue = CinemaFailure.address.localizedDescription
            addressFocusRequest += 1
            return
        }
        run {
            let candidate = CinemaAPI(origin: try CinemaURL.origin(address))
            let caps = try await candidate.discover()
            try Task.checkCancellation()
            client = candidate; discovery = caps; nameFocused = true
        }
    }

    private func startPairing() {
        guard validName, let client, let discovery else { return }
        run {
            let bytes = try await client.request("/api/pairing", method: "POST",
                body: JSONEncoder().encode(["name": deviceName]), accepting: [200, 201])
            let next = try JSONDecoder().decode(CinemaChallenge.self, from: bytes)
            guard next.code.range(of: #"^[A-Z2-9]{8}$"#, options: .regularExpression) != nil,
                  let expiry = next.expiry, expiry > .now, expiry.timeIntervalSinceNow < 3600,
                  (1...600_000).contains(next.pollIntervalMs) else { throw CinemaFailure.invalidReply }
            try Task.checkCancellation()
            try cinema.saveChallenge(next, origin: client.origin, instance: discovery.instanceId)
            challenge = next
        }
    }
    private func poll(_ waiting: CinemaChallenge, _ client: CinemaAPI, _ caps: CinemaDiscovery) async {
        let interval = Double(max(waiting.pollIntervalMs, 1000)) / 1000
        var delay = interval
        while !Task.isCancelled && waiting.id == challenge?.id {
            do {
                guard let expiry = waiting.expiry, expiry > .now else {
                    issue = String(localized: "This code has expired. Get a new code."); return
                }
                try await Task.sleep(for: .seconds(min(delay, max(0, expiry.timeIntervalSinceNow))))
                guard expiry > .now else { issue = String(localized: "This code has expired. Get a new code."); return }
                let bytes = try await client.request("/api/pairing/poll", method: "POST", body:
                    JSONEncoder().encode(["id": waiting.id, "pollSecret": waiting.pollSecret]))
                let answer = try JSONDecoder().decode(CinemaApproval.self, from: bytes)
                try Task.checkCancellation()
                if answer.state == "approved" {
                    try await cinema.finishPairing(client: client, caps: caps, challenge: waiting, approval: answer)
                    return
                }
                guard answer.state == "pending" else { throw CinemaFailure.invalidReply }
                delay = interval; issue = nil
            } catch CinemaFailure.http(429, _, let retry) {
                delay = min(900, max(interval, retry ?? (delay * 2)))
            } catch {
                if Task.isCancelled { return }
                issue = cinemaMessage(error)
                if error is URLError { delay = min(60, max(interval, delay * 2)); continue }
                return
            }
        }
    }
}

struct ServerSettingsView: View {
    @Environment(PairedCinema.self) private var cinema
    @Environment(\.cinemaWindowID) private var window
    @State private var connect = false
    @State private var confirm = false
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            CinemaSectionTitle(text: "Personal server")
            if cinema.hasRememberedServer {
                Label(cinema.isConnected ? "Connected" : "Offline", systemImage: cinema.isConnected ? "link" : "network.slash")
                Text(cinema.account?.origin ?? "").font(.subheadline).foregroundStyle(CinemaTheme.muted)
                if !cinema.isConnected {
                    if cinema.restoring { ProgressView("Reconnecting") }
                    else { Button("Reconnect") { Task { await cinema.restore(explicit: true) } }.buttonStyle(CinemaSecondaryButtonStyle()) }
                }
                if let url = cinema.portal { Link("Open owner portal", destination: url) }
                LabeledContent("Streaming", value: "Wi-Fi only")
                Button("Disconnect", role: .destructive) { confirm = true }.controlSize(.large)
                if !cinema.jobs.isEmpty {
                    CinemaSectionTitle(text: "Preparations")
                    ForEach(cinema.jobs) { job in
                        Button(job.title, systemImage: "clock") { cinema.playback.show(job, in: window) }
                    }
                }
            } else {
                Text("No server paired").foregroundStyle(CinemaTheme.muted)
                Button("Connect a Server", systemImage: "link") { connect = true }
                    .buttonStyle(CinemaSecondaryButtonStyle())
            }
            if let notice = cinema.notice { Text(notice).font(.footnote) }
        }
        .sheet(isPresented: $connect) { ServerConnectionView() }
        .confirmationDialog("Disconnect this device?", isPresented: $confirm) {
            Button("Disconnect", role: .destructive) { Task { await cinema.disconnect() } }
        } message: { Text("This removes the device credential and the server’s saved preparations from this device.") }
    }
}
#endif
