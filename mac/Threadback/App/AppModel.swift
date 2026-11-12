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

    /// What the "Connect your messages" screen shows.
    enum ConnectState: Equatable {
        case idle
        case connected(String)
        case failed(String)
        case fullDiskAccess(String)
    }

    @Published var step: Step = .welcome
    @Published var connectState: ConnectState = .idle
    @Published var chats: [ChatInfo] = []
    @Published var contactsNote = ""
    @Published var approved: [ChatRef] = []
    @Published var automationNote = ""
    @Published var cardImage: NSImage?
    @Published var recapPreview = ""
    @Published var loginItemOn = false
    @Published var loginItemNote = ""
    @Published var status = "Not set up"
    @Published var access = "Messages: not connected"
    @Published var accessLost = false
    @Published var paused = false
    @Published var lastUnconfirmed: ReplyOutcome?
    @Published var replies: [ReplyRecord] = []
    @Published var copiedNote = ""
    @Published var experimentNote = ""
    @Published var moveNote = ""

    weak var window: NSWindow?
    private(set) var engine: ThreadbackEngine?
    private var agent: Agent?
    private var timer: Timer?
    private var activity: NSObjectProtocol?
    private var folderURL: URL?
    private var bookmarkThisLaunch = "not used"
    private var readNow = "not tried"
    private var groupChats: Int?
    private var totalMessages: Int?

    private let defaults = UserDefaults.standard
    private enum Key {
        static let onboarded = "onboarded"
        static let bookmark = "folderBookmark"
        static let bookmarkScoped = "folderBookmarkScoped"
        static let approved = "approvedChats"
        static let method = "accessMethod"
        static let directBefore = "report.directReadBeforeGrant"
        static let afterGrant = "report.readAfterGrant"
        static let walReadable = "report.walReadable"
        static let automation = "report.automation"
        static let replies = "report.replies"
        static let all = [onboarded, bookmark, bookmarkScoped, approved, method, directBefore, afterGrant, walReadable, automation, replies]
    }

    var isFixture: Bool { DebugOptions.fixtureDatabase != nil }
    /// The Messages folder was connected on an earlier launch (bookmark or Full Disk Access).
    var hasConnection: Bool { defaults.data(forKey: Key.bookmark) != nil || defaults.string(forKey: Key.method) == "Full Disk Access" }
    var onboarded: Bool { defaults.bool(forKey: Key.onboarded) }
    let location = AppLocation.current

    init() {
        if DebugOptions.flag("TBResetOnboarding") {
            for key in Key.all { defaults.removeObject(forKey: key) }
        }
        if let data = defaults.data(forKey: Key.approved), let chats = try? JSONDecoder().decode([ChatRef].self, from: data) {
            approved = chats
        }
        if let data = defaults.data(forKey: Key.replies), let saved = try? JSONDecoder().decode([ReplyRecord].self, from: data) {
            replies = saved
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

    /// Restores the folder from its bookmark (a later launch). Returns a note.
    @discardableResult
    func restoreFolder() -> String {
        if defaults.string(forKey: Key.method) == "Full Disk Access" {
            folderURL = Permissions.defaultMessagesFolder
            bookmarkThisLaunch = "not needed (Full Disk Access)"
            return bookmarkThisLaunch
        }
        guard let data = defaults.data(forKey: Key.bookmark) else {
            bookmarkThisLaunch = "none stored"
            return "no bookmark stored"
        }
        let (url, note) = Permissions.resolve(data, securityScoped: defaults.bool(forKey: Key.bookmarkScoped))
        folderURL = url
        if url == nil {
            bookmarkThisLaunch = "could not be resolved"
        } else {
            bookmarkThisLaunch = "resolved, stale \(note.contains("stale=true") ? "yes" : "no")"
        }
        return note
    }

    /// Reads the database once and updates the counts, the menu line and the report.
    @discardableResult
    func checkAccess() -> Bool {
        guard let engine else { return false }
        do {
            let db = try openDatabase()
            let token = engine.open(db)
            defer { engine.close(token) }
            let all = try engine.listChats(token: token, me: me, contacts: [])
            groupChats = all.count
            totalMessages = all.reduce(0) { $0 + $1.messages }
            readNow = "ok"
            access = "Messages: Connected · \(all.count) group chat\(all.count == 1 ? "" : "s")"
            accessLost = false
            return true
        } catch {
            readNow = TestReport.shortError(error)
            access = "Messages: Lost access · Reconnect"
            accessLost = true
            return false
        }
    }

    // MARK: Onboarding

    func continueFromWelcome() { step = .connect }

    /// Step 2: the Open panel, already inside ~/Library/Messages.
    func connect() {
        connectState = .idle
        if isFixture {
            loadChats(method: "fixture")
            return
        }
        // For the report: can the app read the folder before anything was granted?
        let before = AccessProbe.posixRead(Permissions.defaultMessagesFolder.appendingPathComponent("chat.db").path)
        defaults.set(TestReport.shortRead(before), forKey: Key.directBefore)
        let panel = Permissions.messagesPanel()
        let finish: (NSApplication.ModalResponse) -> Void = { [weak self] response in
            guard let self else { return }
            guard response == .OK, let url = panel.url else {
                self.connectState = .failed("No folder was chosen. Click Try again, then Grant Access.")
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
        let chatDB = AccessProbe.posixRead(url.appendingPathComponent("chat.db").path)
        let wal = AccessProbe.posixRead(url.appendingPathComponent("chat.db-wal").path)
        defaults.set(TestReport.shortRead(chatDB), forKey: Key.afterGrant)
        defaults.set(wal.hasPrefix("ok") ? "yes" : "no (\(TestReport.shortRead(wal)))", forKey: Key.walReadable)
        var bookmarkNote = "could not create any bookmark"
        if let bookmark = Permissions.bookmark(for: url) {
            defaults.set(bookmark.data, forKey: Key.bookmark)
            defaults.set(bookmark.securityScoped, forKey: Key.bookmarkScoped)
            bookmarkNote = bookmark.note
        }
        #if DEBUG
        var report = AccessProbe.run(folder: url, label: "after the Open panel (folder chosen by the user)")
        report["bookmark"] = bookmarkNote
        AccessProbe.write(report, to: DebugOptions.reportFolder, name: "probe-panel.json")
        #endif
        let scoped = defaults.bool(forKey: Key.bookmarkScoped)
        loadChats(method: bookmarkNote.hasPrefix("could not") ? "folder grant (no bookmark)"
                  : "folder grant (\(scoped ? "security-scoped" : "plain") bookmark)")
    }

    /// The fallback: Full Disk Access, then "Check again".
    func showFullDiskAccess() {
        connectState = .fullDiskAccess("")
    }

    func checkFullDiskAccess() {
        let path = Permissions.defaultMessagesFolder.appendingPathComponent("chat.db").path
        let read = AccessProbe.posixRead(path)
        guard read.hasPrefix("ok") else {
            connectState = .fullDiskAccess("Still blocked: \(TestReport.shortRead(read)). Switch Threadback on in the list, then click Check again. If it stays blocked, quit Threadback from the menu bar and open it again.")
            return
        }
        folderURL = Permissions.defaultMessagesFolder
        defaults.set("ok", forKey: Key.afterGrant)
        let wal = AccessProbe.posixRead(Permissions.defaultMessagesFolder.appendingPathComponent("chat.db-wal").path)
        defaults.set(wal.hasPrefix("ok") ? "yes" : "no (\(TestReport.shortRead(wal)))", forKey: Key.walReadable)
        loadChats(method: "Full Disk Access")
    }

    private func loadChats(method: String) {
        guard let engine else { return }
        do {
            let db = try openDatabase()
            let token = engine.open(db)
            defer { engine.close(token) }
            let all = try engine.listChats(token: token, me: me, contacts: contacts())
            chats = all
            groupChats = all.count
            totalMessages = all.reduce(0) { $0 + $1.messages }
            readNow = "ok"
            defaults.set(method, forKey: Key.method)
            access = "Messages: Connected · \(all.count) group chat\(all.count == 1 ? "" : "s")"
            accessLost = false
            connectState = .connected("Connected: \(all.count) group chat\(all.count == 1 ? "" : "s"), \(RecapSummary.formatCount(totalMessages ?? 0)) messages.")
        } catch {
            chats = []
            readNow = TestReport.shortError(error)
            connectState = .failed("It did not work: macOS did not let Threadback read the Messages folder (\(TestReport.shortError(error))).")
        }
    }

    func askForContacts() {
        Permissions.requestContacts { [weak self] granted, error in
            guard let self else { return }
            self.contactsNote = granted ? "Names will show as first names." : "No contacts: people show as \u{2026}1234."
            self.loadChats(method: self.defaults.string(forKey: Key.method) ?? "folder grant")
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
            self.defaults.set(Permissions.AutomationResult.describe(result.after), forKey: Key.automation)
            switch result.after {
            case 0: self.automationNote = "Threadback can send into \(ref.name)."
            case -1743: self.automationNote = "Not allowed to control Messages (error -1743). Turn it on in System Settings \u{203A} Privacy & Security \u{203A} Automation."
            default: self.automationNote = "Messages control: \(Permissions.AutomationResult.describe(result.after))"
            }
            self.startAgent()
        }
    }

    /// Exactly what a reply would contain: the image and the text (and the link only when
    /// the story site is live).
    func makePreview(_ chat: ChatRef) {
        guard let engine else { return }
        let sender = RecordingSender()
        var config = agentConfig()
        config.dryRun = true
        config.outFolder = FileManager.default.temporaryDirectory.appendingPathComponent("threadback-onboarding-preview")
        let agent = Agent(engine: engine, sender: sender, config: config, openDatabase: { [unowned self] in try self.openDatabase() }, statePath: nil)
        let outcome = agent.preview(chat, period: nil)
        let texts = sender.sent.filter { $0.kind == "text" }.map(\.payload)
        recapPreview = texts.joined(separator: "\n\n")
        if let card = sender.sent.first(where: { $0.kind == "file" }) {
            cardImage = NSImage(contentsOfFile: card.payload)
        } else if !outcome.error.isEmpty {
            recapPreview = "Could not build the preview: \(outcome.error)"
        }
    }

    func setLoginItem(_ on: Bool) {
        if on && location == .translocated {
            loginItemNote = "Move Threadback to Applications first, then switch this on."
            loginItemOn = false
            return
        }
        loginItemNote = Permissions.setLoginItem(on)
        loginItemOn = Permissions.loginItemStatus() == "enabled"
    }

    func finishOnboarding() {
        window?.close()
    }

    // MARK: Moving to Applications

    /// Moves a copy that sits in Downloads (not translocated) to /Applications and opens it
    /// from there. A translocated copy cannot move itself: the person drags it instead.
    func moveToApplications() {
        guard location.canMoveItself else {
            NSWorkspace.shared.open(FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Downloads"))
            moveNote = "Quit Threadback, drag it from Downloads onto Applications in the Finder window, then open it from Applications."
            return
        }
        let source = URL(fileURLWithPath: Bundle.main.bundlePath)
        let target = URL(fileURLWithPath: "/Applications").appendingPathComponent(source.lastPathComponent)
        if FileManager.default.fileExists(atPath: target.path) {
            moveNote = "There is already a Threadback in Applications. Quit this one and open that one."
            return
        }
        do {
            try FileManager.default.moveItem(at: source, to: target)
        } catch {
            moveNote = "Could not move it (\(TestReport.shortError(error))). Drag Threadback onto Applications in the Finder instead."
            return
        }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.createsNewApplicationInstance = true
        NSWorkspace.shared.openApplication(at: target, configuration: configuration) { _, _ in
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
    }

    // MARK: Agent

    func agentConfig() -> AgentConfig {
        var config = AgentConfig()
        config.me = me
        config.tz = DebugOptions.string("TBTimeZone") ?? TimeZone.current.identifier
        config.contacts = contacts()
        config.dryRun = isFixture
        config.link = MacConfig.storySiteIsLive
        return config
    }

    var statePath: URL {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return support.appendingPathComponent("Threadback/state.json")
    }

    func startAgent() {
        guard let engine, !approved.isEmpty else { return }
        let sender: MessageSender
        if isFixture {
            sender = RecordingSender()
        } else {
            sender = AppleScriptSender(openDatabase: { [unowned self] in try self.openDatabase() },
                                       decode: { engine.decodeText(text: $0, attributedBody: $1) })
        }
        let agent = Agent(engine: engine, sender: sender, config: agentConfig(),
                          openDatabase: { [unowned self] in try self.openDatabase() }, statePath: isFixture ? nil : statePath)
        agent.approve(approved)
        agent.log = { line in NSLog("Threadback: %@", line) }
        agent.onReply = { [weak self] outcome in self?.record(outcome) }
        self.agent = agent
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            self?.tick()
        }
        if activity == nil {
            activity = ProcessInfo.processInfo.beginActivity(options: .userInitiatedAllowingIdleSystemSleep,
                                                             reason: "Answering /wrapped in the chat you turned on")
        }
        status = onStatus
        tick()
    }

    private var onStatus: String {
        "On for \(approved.map(\.name).joined(separator: ", "))"
    }

    private func record(_ outcome: ReplyOutcome) {
        replies.append(ReplyRecord(outcome, time: Date()))
        if replies.count > 10 { replies.removeFirst(replies.count - 10) }
        if let data = try? JSONEncoder().encode(replies) { defaults.set(data, forKey: Key.replies) }
        if outcome.results.contains(where: { $0.1.status == .unverified || $0.1.status == .failed }) {
            lastUnconfirmed = outcome
        }
    }

    private func tick() {
        guard let agent, !paused else { return }
        do {
            try agent.runOnce()
            status = onStatus
            if accessLost || readNow != "ok" {
                readNow = "ok"
                accessLost = false
                access = "Messages: Connected" + (groupChats.map { " · \($0) group chat\($0 == 1 ? "" : "s")" } ?? "")
            }
        } catch {
            readNow = TestReport.shortError(error)
            access = "Messages: Lost access · Reconnect"
            accessLost = true
        }
    }

    func togglePause() {
        paused.toggle()
        status = paused ? "Paused" : onStatus
    }

    /// One click when reading fails: the same Open panel again.
    func reconnect() {
        step = .connect
        connectState = .idle
        NotificationCenter.default.post(name: .showOnboarding, object: nil)
    }

    /// The last reply, for the menu: "Last /wrapped 14:02".
    var lastReplyTitle: String? {
        guard let last = replies.last else { return nil }
        let formatter = DateFormatter()
        formatter.dateStyle = .short
        formatter.timeStyle = .short
        return "Last /wrapped: \(formatter.string(from: last.time))"
    }

    /// Design C stub: when a reply was not confirmed in chat.db, open a Messages compose
    /// sheet pre-filled with the text (and the link), for the owner to press Send.
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

    // MARK: Test report

    func reportFacts() -> ReportFacts {
        var facts = ReportFacts()
        facts.appVersion = MacConfig.version
        facts.commit = MacConfig.commit
        facts.signature = Permissions.signatureKind()
        facts.macOS = ProcessInfo.processInfo.operatingSystemVersionString
        #if arch(arm64)
        facts.architecture = "Apple silicon (arm64)"
        #else
        facts.architecture = "Intel (x86_64)"
        #endif
        facts.location = location.rawValue
        facts.directReadBeforeGrant = defaults.string(forKey: Key.directBefore) ?? "not tried"
        facts.readAfterGrant = defaults.string(forKey: Key.afterGrant) ?? "not tried"
        facts.walReadable = defaults.string(forKey: Key.walReadable) ?? "not tried"
        facts.accessMethod = defaults.string(forKey: Key.method) ?? "not set up"
        facts.bookmarkThisLaunch = bookmarkThisLaunch
        facts.readNow = readNow
        facts.groupChats = groupChats
        facts.totalMessages = totalMessages
        facts.contacts = Permissions.contactsStatusText()
        facts.automation = defaults.string(forKey: Key.automation) ?? "not asked"
        facts.loginItem = Permissions.loginItemStatus()
        facts.linkInReplies = MacConfig.storySiteIsLive ? "on" : "off (the story site is not live yet)"
        facts.chatsTurnedOn = approved.count
        facts.replies = replies
        return facts
    }

    func copyTestReport() {
        if readNow == "not tried" && onboarded { checkAccess() }
        let text = TestReport.text(reportFacts())
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        copiedNote = "Copied. Paste it into your message (it has no names, chats or messages in it)."
    }
}

extension Notification.Name {
    static let showOnboarding = Notification.Name("ThreadbackShowOnboarding")
}
