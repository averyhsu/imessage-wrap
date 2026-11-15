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

/// The app's state: onboarding, the chats that are on, the agent.
///
/// Published properties change on the main thread only. Everything that reads the Messages
/// database or runs the engine happens on `work`, one serial queue, so the window and the
/// menu never wait for it.
final class AppModel: ObservableObject {
    enum Step: Int { case welcome = 1, connect = 2, chats = 3 }

    /// What the "Connect your messages" screen shows.
    enum ConnectState: Equatable {
        case idle
        case working
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
    @Published var previewing = false
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
    @Published var turnOffNote = ""
    @Published var storyNote = ""
    /// The chat just turned on (the "You're on" screen shows it).
    @Published var lastTurnedOn: ChatRef?
    /// The last reply in each chat that is on, by chat key (kept on this Mac only; the test
    /// report never names a chat).
    @Published var lastByChat: [String: ReplyRecord] = [:]
    /// The owner's name in the recap (prefilled from the Mac account, editable, stored).
    @Published var ownerName: String = "" {
        didSet { defaults.set(ownerName, forKey: Key.ownerName) }
    }

    weak var window: NSWindow?
    private(set) var engine: ThreadbackEngine?
    private var agent: Agent?
    private var watcher: FolderWatcher?
    private var activity: NSObjectProtocol?
    private var wakeObserver: NSObjectProtocol?
    private var folderURL: URL?
    private var bookmarkThisLaunch = "not used"
    private var readNow = "not tried"
    private var groupChats: Int?
    private var totalMessages: Int?
    private var tickQueued = false

    /// Every database read and engine call runs here, one at a time.
    let work = DispatchQueue(label: "io.github.averyhsu.threadback.work", qos: .userInitiated)

    private let defaults = UserDefaults.standard
    private enum Key {
        static let onboarded = "onboarded"
        static let bookmark = "folderBookmark"
        static let bookmarkScoped = "folderBookmarkScoped"
        static let approved = "approvedChats"
        static let method = "accessMethod"
        static let ownerName = "ownerName"
        static let directBefore = "report.directReadBeforeGrant"
        static let afterGrant = "report.readAfterGrant"
        static let walReadable = "report.walReadable"
        static let automation = "report.automation"
        static let replies = "report.replies"
        static let lastByChat = "lastReplyByChat"
        static let all = [onboarded, bookmark, bookmarkScoped, approved, method, ownerName, directBefore, afterGrant,
                          walReadable, automation, replies, lastByChat, "toldAboutMenuBar"]
    }

    var isFixture: Bool { DebugOptions.fixtureDatabase != nil }
    /// The Messages folder was connected on an earlier launch (bookmark or Full Disk Access).
    var hasConnection: Bool { defaults.data(forKey: Key.bookmark) != nil || defaults.string(forKey: Key.method) == "Full Disk Access" }
    var onboarded: Bool { defaults.bool(forKey: Key.onboarded) }
    /// A chat is turned on: only then does Threadback stay running without a window.
    var chatIsOn: Bool { onboarded && !approved.isEmpty }
    /// Launched from a download that macOS checked (quarantine attribute present): the person
    /// just went through the Gatekeeper detour.
    let cameThroughGatekeeper: Bool = getxattr(Bundle.main.bundlePath, "com.apple.quarantine", nil, 0, 0, 0) > 0
    let location = AppLocation.current
    var watcherOn: Bool { watcher?.isWatching ?? false }

    init() {
        if DebugOptions.flag("TBResetOnboarding") {
            for key in Key.all { defaults.removeObject(forKey: key) }
        }
        ownerName = defaults.string(forKey: Key.ownerName) ?? ""
        if let data = defaults.data(forKey: Key.approved), let chats = try? JSONDecoder().decode([ChatRef].self, from: data) {
            approved = chats
        }
        if let data = defaults.data(forKey: Key.replies), let saved = try? JSONDecoder().decode([ReplyRecord].self, from: data) {
            replies = saved
        }
        if let data = defaults.data(forKey: Key.lastByChat), let saved = try? JSONDecoder().decode([String: ReplyRecord].self, from: data) {
            lastByChat = saved
        }
        loginItemOn = Permissions.loginItemStatus() == "enabled"
        do {
            engine = try ThreadbackEngine()
        } catch {
            status = "Threadback could not start its counting engine: \(error)"
        }
        if ownerName.isEmpty { ownerName = DebugOptions.string("TBMe") ?? defaultOwnerName() }
    }

    /// The first name of this Mac's account, as the Python helper picks it (fmt.account_first_name):
    /// cleaned, first word, never a number or an address; else "Me".
    func defaultOwnerName() -> String {
        guard let engine else { return "Me" }
        let value = engine.context.objectForKeyedSubscript("ThreadbackText")?
            .invokeMethod("firstName", withArguments: [NSFullUserName()])?.toString() ?? ""
        if value.isEmpty || value == "?" || value.hasPrefix("\u{2026}") { return "Me" }
        return value
    }

    // MARK: Database

    var databasePath: String {
        if let fixture = DebugOptions.fixtureDatabase { return fixture }
        return (folderURL ?? Permissions.defaultMessagesFolder).appendingPathComponent("chat.db").path
    }

    var messagesFolder: URL {
        if let fixture = DebugOptions.fixtureDatabase { return URL(fileURLWithPath: fixture).deletingLastPathComponent() }
        return folderURL ?? Permissions.defaultMessagesFolder
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
        if let name = DebugOptions.string("TBMe"), ownerName.isEmpty { return name }
        let trimmed = ownerName.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "Me" : trimmed
    }

    /// Restores the folder from its bookmark (a later launch). A stale bookmark that still
    /// resolves is renewed. Returns a note.
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
        if let url {
            let stale = note.contains("stale=true")
            bookmarkThisLaunch = "resolved, stale \(stale ? "yes" : "no")"
            if stale, let fresh = Permissions.bookmark(for: url) {
                defaults.set(fresh.data, forKey: Key.bookmark)
                defaults.set(fresh.securityScoped, forKey: Key.bookmarkScoped)
                bookmarkThisLaunch += ", renewed"
            }
        } else {
            bookmarkThisLaunch = "could not be resolved"
        }
        return note
    }

    /// Reads the database once (off the main thread) and updates the counts, the status
    /// line and the report. `done` runs on the main thread with the result.
    func checkAccess(_ done: ((Bool) -> Void)? = nil) {
        guard let engine else { done?(false); return }
        let me = self.me
        work.async { [weak self] in
            guard let self else { return }
            var result: Result<[ChatInfo], Error>
            do {
                let db = try self.openDatabase()
                let token = engine.open(db)
                defer { engine.close(token) }
                result = .success(try engine.listChats(token: token, me: me, contacts: []))
            } catch {
                result = .failure(error)
            }
            DispatchQueue.main.async {
                switch result {
                case .success(let all):
                    self.groupChats = all.count
                    self.totalMessages = all.reduce(0) { $0 + $1.messages }
                    self.readNow = "ok"
                    self.access = "Messages: Connected \u{00B7} \(all.count) group chat\(all.count == 1 ? "" : "s")"
                    self.accessLost = false
                    done?(true)
                case .failure(let error):
                    self.readNow = TestReport.shortError(error)
                    self.access = "Messages: Lost access \u{00B7} Reconnect"
                    self.accessLost = true
                    done?(false)
                }
            }
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
            connectState = .fullDiskAccess("Still blocked. Switch Threadback on in the list, then click Check again. If it stays blocked, quit Threadback and open it again.")
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
        connectState = .working
        let me = self.me
        work.async { [weak self] in
            guard let self else { return }
            var result: Result<[ChatInfo], Error>
            do {
                let db = try self.openDatabase()
                let token = engine.open(db)
                defer { engine.close(token) }
                result = .success(try engine.listChats(token: token, me: me, contacts: self.contacts()))
            } catch {
                result = .failure(error)
            }
            DispatchQueue.main.async {
                switch result {
                case .success(let all):
                    self.chats = all
                    self.groupChats = all.count
                    self.totalMessages = all.reduce(0) { $0 + $1.messages }
                    self.readNow = "ok"
                    self.defaults.set(method, forKey: Key.method)
                    self.access = "Messages: Connected \u{00B7} \(all.count) group chat\(all.count == 1 ? "" : "s")"
                    self.accessLost = false
                    self.connectState = .connected("Connected: \(all.count) group chat\(all.count == 1 ? "" : "s"), \(RecapSummary.formatCount(self.totalMessages ?? 0)) messages.")
                case .failure(let error):
                    self.chats = []
                    self.readNow = TestReport.shortError(error)
                    self.connectState = .failed("It did not work: macOS did not let Threadback read your messages. Click Try again and then Grant Access, or use Full Disk Access instead.")
                }
            }
        }
    }

    func askForContacts() {
        Permissions.requestContacts { [weak self] granted, _ in
            guard let self else { return }
            self.contactsNote = granted ? "Names will show as first names." : "No contacts: people show as \u{2026}1234."
            self.loadChats(method: self.defaults.string(forKey: Key.method) ?? "folder grant")
        }
    }

    func continueToChats() { step = .chats }

    /// Your name must be there before a chat is turned on: the recap shows it to everyone.
    var nameIsReady: Bool { !ownerName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    /// Turns a chat on (more chats can be on; each is approved by its id, on the screen that
    /// says what happens), then asks macOS, on purpose, whether Threadback may use Messages.
    func turnOn(_ chat: ChatInfo) {
        guard nameIsReady else { return }
        let ref = Agent.chatRef(chat)
        if !approved.contains(where: { $0.key == ref.key }) { approved.append(ref) }
        saveApproved()
        defaults.set(true, forKey: Key.onboarded)
        lastTurnedOn = ref
        cardImage = nil
        recapPreview = ""
        makePreview(ref)
        if isFixture || DebugOptions.flag("TBNoAutomation") {
            automationNote = "Sending: skipped in this test run."
            startAgent()
            return
        }
        automationNote = "macOS may ask whether Threadback may use Messages: click Allow."
        Permissions.requestAutomation { [weak self] result in
            guard let self else { return }
            self.defaults.set(Permissions.AutomationResult.describe(result.after), forKey: Key.automation)
            switch result.after {
            case 0: self.automationNote = "Threadback can reply in \(ref.name)."
            case -1743: self.automationNote = "Threadback may not use Messages yet. Open System Settings, then Privacy & Security, find Threadback in the list of apps that control other apps, and switch on Messages."
            default: self.automationNote = "Messages did not answer yet. Open Messages once, then try again."
            }
            self.startAgent()
        }
    }

    private func saveApproved() {
        if let data = try? JSONEncoder().encode(approved) { defaults.set(data, forKey: Key.approved) }
    }

    /// Whether a chat in the chooser is already on.
    func isOn(_ chat: ChatInfo) -> Bool {
        approved.contains { $0.key == Agent.chatRef(chat).key }
    }

    /// "Add a chat": back to the chooser, with the list read again.
    func addChat() {
        lastTurnedOn = nil
        cardImage = nil
        recapPreview = ""
        automationNote = ""
        step = .chats
        if chats.isEmpty { loadChats(method: defaults.string(forKey: Key.method) ?? "folder grant") }
        NotificationCenter.default.post(name: .showOnboarding, object: nil)
    }

    /// Turns one chat off; the others keep answering.
    func turnOff(_ chat: ChatRef) {
        approved.removeAll { $0.key == chat.key }
        lastByChat[chat.key] = nil
        saveLastByChat()
        if approved.isEmpty {
            turnOff()
            return
        }
        saveApproved()
        turnOffNote = "\(chat.name) is off. The other chats keep answering."
        startAgent()
    }

    /// Exactly what a reply would contain: the card and the text (and the link only when the
    /// story site is live), built off the main thread.
    func makePreview(_ chat: ChatRef) {
        guard let engine else { return }
        previewing = true
        let config: AgentConfig = {
            var c = agentConfig()
            c.dryRun = true
            c.outFolder = FileManager.default.temporaryDirectory.appendingPathComponent("threadback-onboarding-preview")
            return c
        }()
        work.async { [weak self] in
            guard let self else { return }
            let sender = RecordingSender()
            let agent = Agent(engine: engine, sender: sender, config: config, openDatabase: { [unowned self] in try self.openDatabase() }, statePath: nil)
            agent.renderCard = { try WebCard.shared.png(statsJSON: $0) }
            let outcome = agent.preview(chat, period: nil)
            let texts = sender.sent.filter { $0.kind == "text" }.map(\.payload)
            let image = sender.sent.first(where: { $0.kind == "file" }).flatMap { NSImage(contentsOfFile: $0.payload) }
            DispatchQueue.main.async {
                self.previewing = false
                self.recapPreview = texts.joined(separator: "\n\n")
                self.cardImage = image
                if image == nil && !outcome.error.isEmpty {
                    self.recapPreview = "Could not build the preview: \(outcome.error)"
                }
            }
        }
    }

    /// Plays the interactive story for a chat in a window on this Mac (nothing is shared).
    func playStory(_ chat: ChatRef) {
        guard let engine else { return }
        storyNote = "Opening the story\u{2026}"
        let me = self.me
        let tz = DebugOptions.string("TBTimeZone") ?? TimeZone.current.identifier
        work.async { [weak self] in
            guard let self else { return }
            var payload: String?
            var problem = ""
            do {
                let db = try self.openDatabase()
                let token = engine.open(db)
                defer { engine.close(token) }
                let full = try engine.statsJSON(token: token, chat: String(chat.rowid), me: me, tz: tz, period: nil,
                                                contacts: self.contacts(), shortNames: false)
                let short = try engine.shortNames(statsJSON: full, me: me)
                // The same payload a shared link would carry: short names, no message text.
                let link = try engine.buildLink(statsJSON: short, quotes: false)
                payload = URL(string: link).flatMap { RecapLink.payload(from: $0) }
            } catch {
                problem = "\(error)"
            }
            DispatchQueue.main.async {
                if let payload, StoryWindow.play(payload: payload, chatName: chat.name) != nil {
                    self.storyNote = ""
                } else {
                    self.storyNote = "The story could not be opened. \(problem)"
                }
            }
        }
    }

    func setLoginItem(_ on: Bool) {
        if on && !chatIsOn {
            loginItemNote = "Turn on a chat first."
            loginItemOn = false
            return
        }
        if on && location == .translocated {
            loginItemNote = "Move Threadback to Applications first, then switch this on."
            loginItemOn = false
            return
        }
        loginItemNote = Permissions.setLoginItem(on)
        loginItemOn = Permissions.loginItemStatus() == "enabled"
    }

    /// Done: the same as closing the window (which says, the first time, that Threadback keeps
    /// answering from the menu bar).
    func finishOnboarding() {
        window?.performClose(nil)
    }

    /// Turn off: forget the chat, stop answering, and do not open at login any more.
    func turnOff() {
        stopAgent()
        approved = []
        lastTurnedOn = nil
        defaults.removeObject(forKey: Key.approved)
        defaults.set(false, forKey: Key.onboarded)
        cardImage = nil
        recapPreview = ""
        automationNote = ""
        status = "Off"
        if Permissions.loginItemStatus() == "enabled" {
            loginItemNote = Permissions.setLoginItem(false)
            turnOffNote = "Turned off. Threadback will not open at login any more."
        } else {
            turnOffNote = "Turned off. Threadback answers nothing now."
        }
        loginItemOn = Permissions.loginItemStatus() == "enabled"
    }

    /// Quit from the window: also stop opening at login, if the person wants.
    func quitFromWindow() {
        if Permissions.loginItemStatus() == "enabled" {
            let alert = NSAlert()
            alert.messageText = "Quit Threadback?"
            alert.informativeText = "It opens again when you log in and keeps answering /wrapped. Stop that too?"
            alert.addButton(withTitle: "Quit, and do not open at login")
            alert.addButton(withTitle: "Just quit")
            if alert.runModal() == .alertFirstButtonReturn { _ = Permissions.setLoginItem(false) }
        }
        NSApp.terminate(nil)
    }

    func setUpAgain() {
        step = .welcome
        connectState = .idle
        NotificationCenter.default.post(name: .showOnboarding, object: nil)
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
            moveNote = "Could not move it. Drag Threadback onto Applications in the Finder instead."
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

    /// Starts answering: a file watch on the Messages folder (with a slow safety poll), a
    /// check after the Mac wakes up, and every read on the work queue.
    func startAgent() {
        guard let engine, !approved.isEmpty else { return }
        stopAgent()
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
        agent.renderCard = { try WebCard.shared.png(statsJSON: $0) }
        agent.onReply = { [weak self] outcome in
            DispatchQueue.main.async { self?.record(outcome) }
        }
        self.agent = agent
        let watcher = FolderWatcher(folder: messagesFolder, queue: work) { [weak self] in self?.runAgent() }
        watcher.start()
        self.watcher = watcher
        wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
        ) { [weak self] _ in
            // After sleep: commands typed while it slept are answered only if younger than
            // ten minutes (the agent's own limit); older ones are skipped.
            self?.tick()
        }
        if activity == nil {
            activity = ProcessInfo.processInfo.beginActivity(options: .userInitiatedAllowingIdleSystemSleep,
                                                             reason: "Answering /wrapped in the chats you turned on")
        }
        status = onStatus
        tick()
    }

    func stopAgent() {
        watcher?.stop()
        watcher = nil
        agent = nil
        if let wakeObserver { NSWorkspace.shared.notificationCenter.removeObserver(wakeObserver) }
        wakeObserver = nil
        if let activity { ProcessInfo.processInfo.endActivity(activity) }
        activity = nil
    }

    private var onStatus: String {
        "On for \(approved.map(\.name).joined(separator: ", "))"
    }

    private func saveLastByChat() {
        if let data = try? JSONEncoder().encode(lastByChat) { defaults.set(data, forKey: Key.lastByChat) }
    }

    private func record(_ outcome: ReplyOutcome) {
        let reply = ReplyRecord(outcome, time: Date())
        lastByChat[outcome.chat.key] = reply
        saveLastByChat()
        replies.append(reply)
        if replies.count > 10 { replies.removeFirst(replies.count - 10) }
        if let data = try? JSONEncoder().encode(replies) { defaults.set(data, forKey: Key.replies) }
        if outcome.results.contains(where: { $0.1.status == .unverified || $0.1.status == .failed }) {
            lastUnconfirmed = outcome
        }
    }

    /// Asks for one pass of the agent (from the main thread).
    func tick() {
        guard !paused else { return }
        work.async { [weak self] in self?.runAgent() }
    }

    /// One pass of the agent, on the work queue. Bursts of file events are already coalesced
    /// by the watcher; a pass that is asked for while one runs is folded into the next one.
    private func runAgent() {
        guard let agent else { return }
        if tickQueued { return }
        tickQueued = true
        defer { tickQueued = false }
        var failure: Error?
        do {
            try agent.runOnce()
        } catch {
            failure = error
        }
        let watching = watcherOn
        DispatchQueue.main.async {
            if let failure {
                self.readNow = TestReport.shortError(failure)
                self.access = "Messages: Lost access \u{00B7} Reconnect"
                self.accessLost = true
            } else {
                self.status = self.paused ? "Paused" : self.onStatus
                self.readNow = "ok"
                self.accessLost = false
                self.access = "Messages: Connected" + (self.groupChats.map { " \u{00B7} \($0) group chat\($0 == 1 ? "" : "s")" } ?? "")
                    + (watching ? "" : " (checking every minute)")
            }
        }
    }

    func togglePause() {
        paused.toggle()
        status = paused ? "Paused" : onStatus
        if !paused { tick() }
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

    /// When a reply was not confirmed, open a Messages compose sheet pre-filled with the
    /// text (and the link), for the owner to press Send.
    func sendByHand() {
        guard let outcome = lastUnconfirmed else { return }
        var items: [Any] = [outcome.text]
        if let url = URL(string: outcome.link), !outcome.link.isEmpty { items.append(url) }
        NSSharingService(named: .composeMessage)?.perform(withItems: items)
    }

    /// Preview a reply for the first chat that is on, into ~/Pictures/Threadback/preview.
    func previewInFinder() {
        guard let engine, let chat = approved.first else { return }
        var config = agentConfig()
        config.dryRun = true
        config.outFolder = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Pictures/Threadback/preview")
        work.async { [weak self] in
            guard let self else { return }
            let agent = Agent(engine: engine, sender: RecordingSender(), config: config,
                              openDatabase: { [unowned self] in try self.openDatabase() }, statePath: nil)
            agent.renderCard = { try WebCard.shared.png(statsJSON: $0) }
            if let folder = agent.preview(chat, period: nil).folder {
                DispatchQueue.main.async { NSWorkspace.shared.activateFileViewerSelecting([folder]) }
            }
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
        facts.watcher = agent == nil ? "not running" : (watcherOn ? "on (file events, safety check every minute)" : "off (safety check every minute only)")
        facts.card = WebCard.pageURL == nil ? "missing" : "site card (\(WebCard.shared.lastMilliseconds) ms last time)"
        facts.replies = replies
        return facts
    }

    /// "Threadback 0.1.0 (1), commit abc1234"
    var aboutLine: String { "Threadback \(MacConfig.version), commit \(MacConfig.commit)" }

    /// Opens the download page in the browser. The app itself never goes online.
    func checkForUpdates() {
        NSWorkspace.shared.open(MacConfig.downloadPage)
    }

    func copyTestReport() {
        let write = { [self] in
            let text = TestReport.text(self.reportFacts())
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
            self.copiedNote = "Copied. Paste it into your message (it has no names, chats or messages in it)."
        }
        if readNow == "not tried" && hasConnection {
            checkAccess { _ in write() }
        } else {
            write()
        }
    }
}

extension Notification.Name {
    static let showOnboarding = Notification.Name("ThreadbackShowOnboarding")
    static let showStatus = Notification.Name("ThreadbackShowStatus")
}
