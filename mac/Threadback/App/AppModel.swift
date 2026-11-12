import AppKit
import Combine
import Foundation

/// Launch options used by CI and tests. Honoured only in Debug builds.
enum DebugOptions {
    static func string(_ key: String) -> String? {
        #if DEBUG
        return UserDefaults.standard.string(forKey: key)
        #else
        return nil
        #endif
    }

    static func flag(_ key: String) -> Bool {
        #if DEBUG
        return UserDefaults.standard.bool(forKey: key)
        #else
        return false
        #endif
    }

    /// A fixture database instead of ~/Library/Messages/chat.db (the onboarding screenshots).
    static var fixtureDatabase: String? { string("TBDatabase") }
    static var fixtureContacts: String? { string("TBContacts") }
    static var reportFolder: URL {
        URL(fileURLWithPath: string("TBReportDir") ?? NSTemporaryDirectory() + "threadback-probe", isDirectory: true)
    }
}

/// The app's state: onboarding, the approved chat, the agent. Used on the main thread only.
final class AppModel: ObservableObject {
    enum Step: Int { case welcome = 1, connect = 2, chats = 3 }

    @Published var step: Step = .welcome
    @Published var chats: [ChatInfo] = []
    @Published var connectedSummary = ""
    @Published var connectError = ""
    @Published var contactsNote = ""
    @Published var approved: [ChatRef] = []
    @Published var turningOn: Int?
    @Published var automationNote = ""
    @Published var cardImage: NSImage?
    @Published var recapPreview = ""
    @Published var loginItemOn = false
    @Published var loginItemNote = ""
    @Published var status = "Not set up"
    @Published var paused = false
    @Published var lastUnconfirmed: ReplyOutcome?
    @Published var experimentNote = ""

    weak var window: NSWindow?
    private(set) var engine: ThreadbackEngine?
    private var agent: Agent?
    private var timer: Timer?
    private var activity: NSObjectProtocol?
    private var folderURL: URL?

    private let defaults = UserDefaults.standard
    private enum Key {
        static let onboarded = "onboarded"
        static let bookmark = "folderBookmark"
        static let bookmarkScoped = "folderBookmarkScoped"
        static let approved = "approvedChats"
    }

    var isFixture: Bool { DebugOptions.fixtureDatabase != nil }
    var onboarded: Bool { defaults.bool(forKey: Key.onboarded) }

    init() {
        if DebugOptions.flag("TBResetOnboarding") {
            for key in [Key.onboarded, Key.bookmark, Key.bookmarkScoped, Key.approved] { defaults.removeObject(forKey: key) }
        }
        if let data = defaults.data(forKey: Key.approved), let chats = try? JSONDecoder().decode([ChatRef].self, from: data) {
            approved = chats
        }
        loginItemOn = Permissions.loginItemStatus() == "enabled"
        do {
            engine = try ThreadbackEngine()
        } catch {
            status = "Engine failed to load: \(error)"
        }
    }

    // MARK: Database

    var databasePath: String {
        if let fixture = DebugOptions.fixtureDatabase { return fixture }
        return (folderURL ?? Permissions.defaultMessagesFolder).appendingPathComponent("chat.db").path
    }

    func openDatabase() throws -> SQLiteDB {
        return try SQLiteDB(path: databasePath)
    }

    func contacts() -> [[String]] {
        guard let engine else { return [] }
        if let fixture = DebugOptions.fixtureContacts { return engine.contacts(fromAddressBook: fixture) }
        return Permissions.contactPairs(engine: engine)
    }

    var me: String {
        if let name = DebugOptions.string("TBMe") { return name }
        let first = NSFullUserName().split(separator: " ").first.map(String.init) ?? ""
        return first.isEmpty ? "Me" : first
    }

    /// Restores the folder from its bookmark (a later launch).
    func restoreFolder() -> String {
        guard let data = defaults.data(forKey: Key.bookmark) else { return "no bookmark stored" }
        let (url, note) = Permissions.resolve(data, securityScoped: defaults.bool(forKey: Key.bookmarkScoped))
        folderURL = url
        return note
    }

    // MARK: Onboarding

    func continueFromWelcome() { step = .connect }

    /// Step 2: the Open panel, already inside ~/Library/Messages.
    func connect() {
        connectError = ""
        if isFixture {
            loadChats(note: "fixture")
            return
        }
        let panel = Permissions.messagesPanel()
        let finish: (NSApplication.ModalResponse) -> Void = { [weak self] response in
            guard let self else { return }
            guard response == .OK, let url = panel.url else {
                self.connectError = "No folder was chosen. Click Connect Messages and then Grant Access."
                return
            }
            self.folderChosen(url)
        }
        if let window {
            panel.beginSheetModal(for: window, completionHandler: finish)
        } else {
            finish(panel.runModal())
        }
    }

    func folderChosen(_ url: URL) {
        folderURL = url
        var report = AccessProbe.run(folder: url, label: "after the Open panel (folder chosen by the user)")
        if let bookmark = Permissions.bookmark(for: url) {
            defaults.set(bookmark.data, forKey: Key.bookmark)
            defaults.set(bookmark.securityScoped, forKey: Key.bookmarkScoped)
            report["bookmark"] = bookmark.note
        } else {
            report["bookmark"] = "could not create any bookmark"
        }
        #if DEBUG
        AccessProbe.write(report, to: DebugOptions.reportFolder, name: "probe-panel.json")
        #endif
        loadChats(note: report["sqlite.inplace"] ?? "")
    }

    private func loadChats(note: String) {
        guard let engine else { return }
        do {
            let db = try openDatabase()
            let token = engine.open(db)
            defer { engine.close(token) }
            let all = try engine.listChats(token: token, me: me, contacts: contacts())
            chats = all
            let total = all.reduce(0) { $0 + $1.messages }
            connectedSummary = "Connected: \(RecapSummary.formatCount(total)) messages in \(all.count) group chat\(all.count == 1 ? "" : "s")."
            connectError = ""
        } catch {
            chats = []
            connectedSummary = ""
            connectError = "macOS did not let Threadback read the Messages folder (\(error)). Click Connect Messages again and choose the Messages folder, or allow Full Disk Access."
        }
    }

    func askForContacts() {
        Permissions.requestContacts { [weak self] granted, error in
            guard let self else { return }
            self.contactsNote = granted ? "Names will show as first names." : "No contacts: people show as …1234. \(error)"
            self.loadChats(note: "contacts")
        }
    }

    func continueToChats() { step = .chats }

    /// Step 3: turn on one chat, then (on purpose) the "control Messages" prompt.
    func turnOn(_ chat: ChatInfo) {
        let ref = Agent.chatRef(chat)
        approved = [ref]
        if let data = try? JSONEncoder().encode(approved) { defaults.set(data, forKey: Key.approved) }
        defaults.set(true, forKey: Key.onboarded)
        makePreview(ref)
        if isFixture || DebugOptions.flag("TBNoAutomation") {
            automationNote = "Messages control: skipped in this test run."
            startAgent()
            return
        }
        automationNote = "macOS is asking to let Threadback control Messages: click Allow."
        Permissions.requestAutomation { [weak self] result in
            guard let self else { return }
            switch result.after {
            case 0: self.automationNote = "Threadback can send into \(ref.name)."
            case -1743: self.automationNote = "Not allowed to control Messages. Turn it on in System Settings › Privacy & Security › Automation."
            default: self.automationNote = "Messages control: \(Permissions.AutomationResult.describe(result.after))"
            }
            self.startAgent()
        }
    }

    func makePreview(_ chat: ChatRef) {
        guard let engine else { return }
        let sender = RecordingSender()
        var config = agentConfig()
        config.dryRun = true
        config.outFolder = FileManager.default.temporaryDirectory.appendingPathComponent("threadback-onboarding-preview")
        let agent = Agent(engine: engine, sender: sender, config: config, openDatabase: { [unowned self] in try self.openDatabase() }, statePath: nil)
        let outcome = agent.preview(chat, period: nil)
        recapPreview = outcome.text
        if let card = sender.sent.first(where: { $0.kind == "file" }) {
            cardImage = NSImage(contentsOfFile: card.payload)
        }
    }

    func setLoginItem(_ on: Bool) {
        loginItemNote = Permissions.setLoginItem(on)
        loginItemOn = Permissions.loginItemStatus() == "enabled"
    }

    func finishOnboarding() {
        window?.close()
    }

    // MARK: Agent

    func agentConfig() -> AgentConfig {
        var config = AgentConfig()
        config.me = me
        config.tz = DebugOptions.string("TBTimeZone") ?? TimeZone.current.identifier
        config.contacts = contacts()
        config.dryRun = isFixture
        return config
    }

    var statePath: URL {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return support.appendingPathComponent("Threadback/state.json")
    }

    func startAgent() {
        guard let engine, !approved.isEmpty else { return }
        let sender: MessageSender = isFixture ? RecordingSender()
            : AppleScriptSender(openDatabase: { [unowned self] in try self.openDatabase() },
                                decode: { engine.decodeText(text: $0, attributedBody: $1) })
        let agent = Agent(engine: engine, sender: sender, config: agentConfig(),
                          openDatabase: { [unowned self] in try self.openDatabase() }, statePath: isFixture ? nil : statePath)
        agent.approve(approved)
        agent.log = { line in NSLog("Threadback: %@", line) }
        self.agent = agent
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            self?.tick()
        }
        if activity == nil {
            activity = ProcessInfo.processInfo.beginActivity(options: .userInitiatedAllowingIdleSystemSleep,
                                                             reason: "Answering /wrapped in the chat you turned on")
        }
        status = "On for \(approved.map(\.name).joined(separator: ", "))"
        tick()
    }

    private func tick() {
        guard let agent, !paused else { return }
        do {
            try agent.runOnce()
            status = "On for \(approved.map(\.name).joined(separator: ", "))"
            if let outcome = agent.lastOutcome, outcome.results.contains(where: { $0.1.status == .unverified || $0.1.status == .failed }) {
                lastUnconfirmed = outcome
            }
        } catch {
            status = "Can't read Messages: Reconnect"
        }
    }

    func togglePause() {
        paused.toggle()
        status = paused ? "Paused" : "On for \(approved.map(\.name).joined(separator: ", "))"
    }

    /// One click when reading fails: the same Open panel again.
    func reconnect() {
        step = .connect
        NotificationCenter.default.post(name: .showOnboarding, object: nil)
    }

    /// Design C stub: when a reply was not confirmed in chat.db, open a Messages compose
    /// sheet pre-filled with the text and the link, for the owner to press Send.
    func sendByHand() {
        guard let outcome = lastUnconfirmed else { return }
        var items: [Any] = [outcome.text]
        if let url = URL(string: outcome.link), !outcome.link.isEmpty { items.append(url) }
        NSSharingService(named: .composeMessage)?.perform(withItems: items)
    }

    /// Preview a reply for the approved chat into ~/Pictures/Threadback/preview and show it.
    func previewInFinder() {
        guard let engine, let chat = approved.first else { return }
        var config = agentConfig()
        config.dryRun = true
        config.outFolder = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Pictures/Threadback/preview")
        let agent = Agent(engine: engine, sender: RecordingSender(), config: config,
                          openDatabase: { [unowned self] in try self.openDatabase() }, statePath: nil)
        if let folder = agent.preview(chat, period: nil).folder {
            NSWorkspace.shared.activateFileViewerSelecting([folder])
        }
    }
}

extension Notification.Name {
    static let showOnboarding = Notification.Name("ThreadbackShowOnboarding")
}
