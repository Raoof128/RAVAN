#if PAIRED
import SwiftUI
import Accessibility

struct ServerConnectionView: View {
    @Environment(PairedCinema.self) private var cinema
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var phase
    @State private var address = ""
    @State private var name = UIDevice.current.userInterfaceIdiom == .pad ? "My iPad" : "My iPhone"
    @State private var client: CinemaAPI?
    @State private var discovery: CinemaDiscovery?
    @State private var challenge: CinemaChallenge?
    @State private var challengeInstance: String?
    @State private var nextPoll = Date.distantPast
    @State private var issue: String?
    @State private var busy = false
    @State private var operation: Task<Void, Never>?
    @State private var operationID = 0
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
                            Text("Paste this code under Pair a screen in Your cinema. After you approve the device, return to the app.")
                            let grouped = String(challenge.code.prefix(4)) + " " + String(challenge.code.suffix(4))
                            Text(verbatim: grouped).font(.largeTitle.monospaced()).textSelection(.enabled)
                                .minimumScaleFactor(0.55).lineLimit(1).privacySensitive()
                                .accessibilityLabel(challenge.code.map(String.init).joined(separator: " "))
                                .accessibilityIdentifier("pairing.code")
                            if let expiry = challenge.expiry { Text("Expires at \(expiry.formatted(date: .omitted, time: .shortened))") }
                            Button {
                                copy(challenge)
                                openURL(RavanWebsite.settings(at: client.origin)) { opened in
                                    if !opened { issue = String(localized: "Open the website in your browser and choose Your cinema to approve this code.") }
                                }
                            } label: {
                                Label("Copy code and open website", systemImage: "safari")
                            }
                            .buttonStyle(CinemaPrimaryButtonStyle())
                            .accessibilityIdentifier("pairing.approve")
                            Button("Copy code", systemImage: "doc.on.doc") { copy(challenge) }
                            Button("Get a new code") {
                                run {
                                    let caps = try await client.discover()
                                    try Task.checkCancellation()
                                    try await requestCode(name: deviceName, using: client, discovery: caps)
                                }
                            }.disabled(busy || cinema.restoring)
                            Button("Change server") {
                                cancelOperation()
                                do { try cinema.clearChallenge(); self.challenge = nil; self.client = nil; discovery = nil; issue = nil }
                                catch { issue = cinemaMessage(error) }
                            }
                        }
                    } else {
                        if client == nil {
                            section("RAVĀN website") {
                                let host = RavanWebsite.origin.host() ?? RavanWebsite.origin.absoluteString
                                let spokenHost = host.components(separatedBy: ".").joined(separator: " " + String(localized: "dot") + " ")
                                Text(verbatim: host)
                                    .font(.subheadline).foregroundStyle(CinemaTheme.muted)
                                    .accessibilityLabel(Text("Website address, \(spokenHost)"))
                                Button(action: connectWebsite) {
                                    Label("Get website pairing code", systemImage: "link")
                                }
                                .buttonStyle(CinemaPrimaryButtonStyle()).disabled(busy)
                                .accessibilityIdentifier("server.website")
                            }
                        }
                        section("Custom server") {
                            CinemaTextInput(text: Binding(get: { address }, set: editAddress), focusRequest: addressFocusRequest,
                                            label: String(localized: "Server address"), identifier: "server.address",
                                            keyboard: .URL, returnKey: .go, submit: checkServer)
                                .frame(height: max(48, inputHeight + 12))
                                .padding(.horizontal, 12)
                                .background(CinemaTheme.panel, in: RoundedRectangle(cornerRadius: 10))
                                .overlay { RoundedRectangle(cornerRadius: 10).strokeBorder(CinemaTheme.hairline) }
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
                                .buttonStyle(CinemaSecondaryButtonStyle())
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
            .navigationTitle("Connect to RAVĀN").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button {
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
        .onAppear {
            guard !cinema.hasRememberedServer, challenge == nil, !busy else { return }
            do {
                guard let pending = try cinema.recoverChallenge() else { return }
                address = pending.origin
                client = cinema.newClient(try CinemaURL.origin(pending.origin))
                challengeInstance = pending.instance
                challenge = pending.challenge
            } catch { issue = cinemaMessage(error) }
        }
        .task(id: [phase == .active ? "active" : "", challenge?.id ?? ""]) {
            guard phase == .active, let challenge, let client, !cinema.hasRememberedServer else { return }
            await poll(challenge, client)
        }
        .onChange(of: cinema.isConnected) { _, online in if online { dismiss() } }
        .onDisappear { cancelOperation() }
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

    private func copy(_ challenge: CinemaChallenge) {
        UIPasteboard.general.setItems([["public.utf8-plain-text": challenge.code]],
            options: [.localOnly: true, .expirationDate: challenge.expiry ?? .now])
    }

    private func editAddress(_ value: String) {
        guard value != address else { return }
        cancelOperation()
        address = value
        client = nil; discovery = nil; issue = nil
    }

    private func cancelOperation() {
        operationID += 1
        operation?.cancel()
        operation = nil
        busy = false
    }

    private func run(_ work: @escaping @MainActor () async throws -> Void) {
        guard !busy else { return }
        issue = nil; busy = true
        operationID += 1
        let id = operationID
        operation = Task {
            defer { if operationID == id { busy = false; operation = nil } }
            do { try await work() }
            catch { if !Task.isCancelled { issue = cinemaMessage(error) } }
        }
    }
    private func connectWebsite() {
        let candidate = cinema.newClient(RavanWebsite.origin)
        let name = UIDevice.current.userInterfaceIdiom == .pad ? "My iPad" : "My iPhone"
        run {
            let caps = try await candidate.discover()
            try Task.checkCancellation()
            try await requestCode(name: name, using: candidate, discovery: caps)
        }
    }
    private func checkServer() {
        guard !address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            issue = CinemaFailure.address.localizedDescription
            addressFocusRequest += 1
            return
        }
        run {
            let candidate = cinema.newClient(try CinemaURL.origin(address))
            let caps = try await candidate.discover()
            try Task.checkCancellation()
            client = candidate; discovery = caps; nameFocused = true
        }
    }

    private func startPairing() {
        guard validName, let client, let discovery else { return }
        let name = deviceName
        run {
            try await requestCode(name: name, using: client, discovery: discovery)
        }
    }

    private func requestCode(name: String, using client: CinemaAPI, discovery: CinemaDiscovery) async throws {
        let bytes = try await client.request("/api/pairing", method: "POST",
            body: JSONEncoder().encode(["name": name]), accepting: [200, 201])
        let next = try JSONDecoder().decode(CinemaChallenge.self, from: bytes)
        guard next.code.range(of: #"^[A-HJ-NP-Z2-9]{8}$"#, options: .regularExpression) != nil,
              let expiry = next.expiry, expiry > .now, expiry.timeIntervalSinceNow < 3600,
              (1...600_000).contains(next.pollIntervalMs) else { throw CinemaFailure.invalidReply }
        try Task.checkCancellation()
        try cinema.saveChallenge(next, origin: client.origin, instance: discovery.instanceId)
        self.client = client; self.discovery = discovery
        challengeInstance = discovery.instanceId
        nextPoll = .distantPast
        challenge = next
    }
    private func poll(_ waiting: CinemaChallenge, _ client: CinemaAPI) async {
        let interval = Double(max(waiting.pollIntervalMs, 1000)) / 1000
        var delay = interval
        while !Task.isCancelled && waiting.id == challenge?.id {
            do {
                guard let expiry = waiting.expiry, expiry > .now else {
                    issue = String(localized: "This code has expired. Get a new code."); return
                }
                let remaining = min(nextPoll, expiry).timeIntervalSinceNow
                if remaining > 0 { try await Task.sleep(for: .seconds(remaining)) }
                guard expiry > .now else { issue = String(localized: "This code has expired. Get a new code."); return }
                let caps: CinemaDiscovery
                if let discovery { caps = discovery }
                else {
                    caps = try await client.discover()
                    try Task.checkCancellation()
                    guard caps.instanceId == challengeInstance else {
                        try cinema.clearChallenge()
                        challenge = nil; self.client = nil
                        throw CinemaFailure.identity
                    }
                    discovery = caps
                }
                // Keep the server's polling interval when the user switches back from Safari.
                nextPoll = Date.now.addingTimeInterval(interval)
                let bytes = try await client.request("/api/pairing/poll", method: "POST", body:
                    JSONEncoder().encode(["id": waiting.id, "pollSecret": waiting.pollSecret]))
                let answer = try JSONDecoder().decode(CinemaApproval.self, from: bytes)
                try Task.checkCancellation()
                guard waiting.id == challenge?.id else { return }
                if answer.state == "approved" {
                    cancelOperation()
                    try await cinema.finishPairing(client: client, caps: caps, challenge: waiting, approval: answer)
                    return
                }
                guard answer.state == "pending" else { throw CinemaFailure.invalidReply }
                delay = interval; issue = nil
            } catch CinemaFailure.http(429, _, let retry) {
                guard !Task.isCancelled, waiting.id == challenge?.id else { return }
                delay = min(900, max(interval, retry ?? (delay * 2)))
                nextPoll = Date.now.addingTimeInterval(delay)
            } catch {
                if Task.isCancelled { return }
                issue = cinemaMessage(error)
                guard !cinema.hasRememberedServer, waiting.id == challenge?.id else { return }
                switch error {
                case CinemaFailure.http(400, "pairing_unavailable", _):
                    do { try cinema.clearChallenge(); challenge = nil }
                    catch { issue = cinemaMessage(error) }
                    return
                case is URLError, CinemaFailure.http(408, _, _), CinemaFailure.http(500...599, _, _):
                    delay = min(60, max(interval, delay * 2))
                    nextPoll = Date.now.addingTimeInterval(delay)
                default: return
                }
            }
        }
    }
}

struct ServerSettingsView: View {
    let connect: () -> Void
    @Environment(PairedCinema.self) private var cinema
    @Environment(\.cinemaWindowID) private var window
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
                Button("Connect a Server", systemImage: "link", action: connect)
                    .buttonStyle(CinemaSecondaryButtonStyle())
            }
            if let notice = cinema.notice { Text(notice).font(.footnote) }
        }
        .confirmationDialog("Disconnect this device?", isPresented: $confirm) {
            Button("Disconnect", role: .destructive) { Task { await cinema.disconnect() } }
        } message: { Text("This removes the device credential and the server’s saved preparations from this device.") }
    }
}
#endif
