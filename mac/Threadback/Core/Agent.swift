import Foundation

/// The loop that answers `/wrapped` (a port of wrapped/mac/agent.py's rules):
///
/// - reply only in chats the owner approved, frozen BY ID at consent: a chat created or
///   renamed later is never added, whatever it is called
/// - never replay commands typed before it started, or more than ten minutes ago, or dated
///   in the future
/// - at most one reply per chat inside the cooldown
/// - never react to its own replies
/// - verify every send in chat.db (the sender does), and log one line per command, with no
///   message text
struct AgentConfig {
    var me = "Me"
    var tz: String?
    var contacts: [[String]] = []
    var cooldown: TimeInterval = 120
    var staleAfter: TimeInterval = 600
    var futureSkew: TimeInterval = 30
    var link = MacConfig.storySiteIsLive  // a link only while the story site is live
    var quotes = false
    var fullNames = false
    var dryRun = false
    var outFolder: URL?
    var joinAttempts = 10
    var joinDelay: TimeInterval = 0.3
    var batch = 500
}

/// What the agent remembers between runs (no message text).
struct AgentState: Codable {
    var cursor: Int?
    var cooldowns: [String: Double] = [:]
    var ownRowids: [Int] = []
    /// The last command answered in each chat (message ROWID), so one command never gets
    /// two replies, even across a crash or a relaunch. Written before anything is sent.
    var answered: [String: Int] = [:]

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        cursor = try c.decodeIfPresent(Int.self, forKey: .cursor)
        cooldowns = try c.decodeIfPresent([String: Double].self, forKey: .cooldowns) ?? [:]
        ownRowids = try c.decodeIfPresent([Int].self, forKey: .ownRowids) ?? []
        answered = try c.decodeIfPresent([String: Int].self, forKey: .answered) ?? [:]
    }

    mutating func rememberOwn(_ rowid: Int?) {
        guard let rowid else { return }
        ownRowids.append(rowid)
        if ownRowids.count > 200 { ownRowids.removeFirst(ownRowids.count - 200) }
    }

    static func load(_ url: URL?) -> AgentState {
        guard let url, let data = try? Data(contentsOf: url),
              let state = try? JSONDecoder().decode(AgentState.self, from: data) else { return AgentState() }
        return state
    }

    func save(_ url: URL?) {
        guard let url, let data = try? JSONEncoder().encode(self) else { return }
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: url, options: .atomic)
    }
}

/// What one command produced (also the log line).
struct ReplyOutcome {
    let chat: ChatRef
    let trigger: Trigger
    var results: [(String, SendResult)] = []
    var error = ""
    var folder: URL?
    var text = ""
    var link = ""

    var sentSomething: Bool { results.contains { $0.1.sentSomething } }

    var line: String {
        let head = "/\(trigger.command) in \"\(chat.name)\" (\(trigger.period ?? "default period"))"
        if !error.isEmpty { return "\(head): error: \(error)" }
        return head + ": " + results.map { "\($0.0)=\($0.1.summary)" }.joined(separator: " ")
    }
}

final class Agent {
    let engine: ThreadbackEngine
    let sender: MessageSender
    var config: AgentConfig
    let openDatabase: () throws -> SQLiteDB
    let statePath: URL?
    var clock: () -> Date = Date.init
    var log: (String) -> Void = { _ in }
    /// Draws the card from the short-name stats JSON. The app uses the site's own card
    /// (WebCard); the default is the small native card, for tests without WebKit.
    var renderCard: (String) throws -> Data = { stats in
        guard let png = MacCardRenderer.pngData(for: try RecapSummary.decode(json: Data(stats.utf8))) else {
            throw EngineError(code: "card", message: "the native card could not be drawn")
        }
        return png
    }
    /// Called once per answered command (the menu and the test report show it).
    var onReply: (ReplyOutcome) -> Void = { _ in }
    private(set) var state: AgentState
    /// The approved chats, by key, frozen at consent.
    private(set) var approved: [String: ChatRef] = [:]
    private var warned = Set<String>()

    init(engine: ThreadbackEngine, sender: MessageSender, config: AgentConfig,
         openDatabase: @escaping () throws -> SQLiteDB, statePath: URL?) {
        self.engine = engine
        self.sender = sender
        self.config = config
        self.openDatabase = openDatabase
        self.statePath = statePath
        self.state = AgentState.load(statePath)
    }

    /// Freezes the scope to exactly these chats, by id. A renamed approved chat stays approved.
    func approve(_ chats: [ChatRef]) {
        approved = Dictionary(chats.map { ($0.key, $0) }, uniquingKeysWith: { first, _ in first })
    }

    static func chatRef(_ info: ChatInfo) -> ChatRef {
        return ChatRef(guid: info.guid, identifier: info.chatIdentifier, name: info.name, rowid: info.id, members: info.members)
    }

    // MARK: Loop

    /// Handles every pending row, then returns the number of commands answered.
    @discardableResult
    func runOnce() throws -> Int {
        let db = try openDatabase()
        var answered = 0
        let top = try MessagesDB.maxMessageRowid(db)
        if state.cursor == nil {
            state.cursor = top
            log("first run: starting after message row \(top); older commands are ignored")
        } else if let cursor = state.cursor, cursor > top {
            log("the Messages database looks replaced (cursor is ahead of it); starting from now")
            state.cursor = top
        }
        while true {
            let rows = try MessagesDB.newRows(db, after: state.cursor ?? top, limit: config.batch)
            if rows.isEmpty { break }
            for row in rows {
                if handle(row, db: db) { answered += 1 }
                state.cursor = row.rowid
            }
        }
        let now = clock().timeIntervalSince1970
        state.cooldowns = state.cooldowns.filter { now - $0.value < max(config.cooldown, 1) * 4 }
        state.save(statePath)
        return answered
    }

    private func handle(_ row: MessagesDB.NewRow, db: SQLiteDB) -> Bool {
        if state.ownRowids.contains(row.rowid) { return false }
        if row.associatedType >= 1000 || row.itemType != 0 { return false }
        let text = engine.decodeText(text: row.text, attributedBody: row.attributedBody)
        let now = clock()
        let year = Calendar(identifier: .gregorian).component(.year, from: now)
        guard let trigger = engine.parseTrigger(text, currentYear: year) else { return false }

        let age = now.timeIntervalSince1970 - row.unixTime
        if age < -config.futureSkew {
            log("ignored a /\(trigger.command) dated \(Int(-age)) s in the future (row \(row.rowid))")
            return false
        }
        if age > config.staleAfter {
            log("ignored a /\(trigger.command) that is \(Int(age / 60)) min old (row \(row.rowid))")
            return false
        }
        guard let chatRow = findGroupChat(db, rowid: row.rowid) else { return false }
        guard let known = approved[chatRow.key] else {
            if !warned.contains(chatRow.key) {
                warned.insert(chatRow.key)
                log("ignored /\(trigger.command) in a group chat that is not in the approved list (id ending \(String(chatRow.key.suffix(4)))); set it up again to add it")
            }
            return false
        }
        let current = engine.safeChatName(chatRow.displayName)
        let chat = ChatRef(guid: chatRow.guid, identifier: chatRow.identifier,
                           name: current.isEmpty ? known.name : current, rowid: chatRow.rowid, members: known.members)
        if let last = state.cooldowns[chat.key] {
            let since = now.timeIntervalSince1970 - last
            if since >= 0 && since < config.cooldown {
                log("ignored /\(trigger.command) in \"\(chat.name)\": cooling down (\(Int(config.cooldown - since) + 1) s left)")
                return false
            }
        }
        if let done = state.answered[chat.key], done >= row.rowid {
            log("ignored a /\(trigger.command) that was already answered (row \(row.rowid))")
            return false
        }
        // At most once: remember the command as answered before anything is sent.
        state.answered[chat.key] = row.rowid
        state.cursor = row.rowid
        state.save(statePath)
        let outcome = answer(chat, trigger: trigger)
        for (_, result) in outcome.results { state.rememberOwn(result.rowid) }
        if outcome.sentSomething { state.cooldowns[chat.key] = clock().timeIntervalSince1970 }
        log(outcome.line)
        state.cursor = row.rowid
        state.save(statePath)
        lastOutcome = outcome
        onReply(outcome)
        return outcome.sentSomething
    }

    private(set) var lastOutcome: ReplyOutcome?

    private func findGroupChat(_ db: SQLiteDB, rowid: Int) -> MessagesDB.ChatRow? {
        for attempt in 0..<max(1, config.joinAttempts) {
            if let rows = try? MessagesDB.chatsForMessage(db, rowid: rowid), !rows.isEmpty {
                if let group = rows.first(where: { $0.isGroup }) { return group }
                log("ignored a command outside a group chat (row \(rowid))")
                return nil
            }
            if attempt + 1 < config.joinAttempts { Thread.sleep(forTimeInterval: config.joinDelay) }
        }
        log("ignored a command whose chat never showed up in chat.db (row \(rowid))")
        return nil
    }

    // MARK: Answering

    /// Exactly what a command in `chat` would produce, through the configured sender.
    func preview(_ chat: ChatRef, period: String?) -> ReplyOutcome {
        return answer(chat, trigger: Trigger(command: "wrapped", period: period))
    }

    func answer(_ chat: ChatRef, trigger: Trigger) -> ReplyOutcome {
        var outcome = ReplyOutcome(chat: chat, trigger: trigger)
        let fullStats: String
        do {
            let db = try openDatabase()
            let token = engine.open(db)
            defer { engine.close(token) }
            fullStats = try engine.statsJSON(token: token, chat: String(chat.rowid), me: config.me, tz: config.tz,
                                             period: trigger.period, contacts: config.contacts, shortNames: false)
        } catch {
            outcome.error = "could not compute stats (\(error))"
            return outcome
        }
        do {
            // Contact names are the owner's private labels: what leaves uses short names.
            let stats = try engine.shortNames(statsJSON: fullStats, me: config.me)
            var link = ""
            if config.link {
                do {
                    link = try engine.buildLink(statsJSON: config.fullNames ? fullStats : stats, quotes: config.quotes)
                    // Never send a link this app cannot read back with the shared Swift decoder,
                    // or one that does not point at the story site, or one over the budget.
                    if let problem = Agent.linkProblem(link) {
                        log("no link this time (\(problem)); sending the card and text only")
                        link = ""
                    }
                } catch {
                    log("no link this time (\(error)); sending the card and text only")
                }
            }
            let recap = try engine.recapText(statsJSON: stats, withLink: !link.isEmpty)
            outcome.text = recap.message
            outcome.link = link
            if case .empty(let line) = recap {
                if config.dryRun, let folder = try? dryRunFolder(chat) {
                    outcome.folder = folder
                    try? (line + "\n").write(to: folder.appendingPathComponent("recap.txt"), atomically: true, encoding: .utf8)
                }
                outcome.results.append(("text", sender.sendText(line, to: chat)))
                return outcome
            }
            let summary = try RecapSummary.decode(json: Data(stats.utf8))
            let png: Data
            do {
                png = try renderCard(stats)
            } catch {
                outcome.error = "could not render the card (\(error))"
                return outcome
            }
            let label = summary.periodLabel
            let filename = "threadback-\(Agent.slugify(chat.name))-\(Agent.slugify(label, fallback: "recap")).png"
            let folder: URL
            if config.dryRun {
                folder = try dryRunFolder(chat)
                outcome.folder = folder
            } else {
                folder = FileManager.default.temporaryDirectory.appendingPathComponent("threadback-\(UUID().uuidString)", isDirectory: true)
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            }
            defer { if !config.dryRun { try? FileManager.default.removeItem(at: folder) } }
            let card = folder.appendingPathComponent(filename)
            try png.write(to: card)
            if config.dryRun {
                try (recap.message + "\n").write(to: folder.appendingPathComponent("recap.txt"), atomically: true, encoding: .utf8)
                try (link + "\n").write(to: folder.appendingPathComponent("link.txt"), atomically: true, encoding: .utf8)
            }
            let cardResult = sender.sendFile(card, to: chat)
            outcome.results.append(("card", cardResult))
            if cardResult.status == .failed || cardResult.orphan { return outcome }
            let textResult = sender.sendText(recap.message, to: chat)
            outcome.results.append(("text", textResult))
            if textResult.status == .failed || textResult.orphan || link.isEmpty { return outcome }
            // The link goes alone: Messages builds a preview only for a bare URL.
            outcome.results.append(("link", sender.sendText(link, to: chat)))
        } catch {
            outcome.error = "\(error)"
        }
        return outcome
    }

    private func dryRunFolder(_ chat: ChatRef) throws -> URL {
        let base = config.outFolder ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Pictures/Threadback/dry-run")
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        let stem = "\(formatter.string(from: clock()))-\(Agent.slugify(chat.name))"
        var folder = base.appendingPathComponent(stem, isDirectory: true)
        var n = 1
        while FileManager.default.fileExists(atPath: folder.path) {
            n += 1
            folder = base.appendingPathComponent("\(stem)-\(n)", isDirectory: true)
        }
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }

    /// Why a link must not be sent, or nil when it is fine: it must start with the story
    /// site's address and "#w1=", stay within 4,800 characters, and decode with the shared
    /// Swift code (RecapLink) into a recap.
    static func linkProblem(_ link: String) -> String? {
        let prefix = MacConfig.storyBaseURL + "#" + WrappedConfig.payloadKey + "="
        guard link.hasPrefix(prefix) else { return "it does not start with \(prefix)" }
        guard link.count <= WrappedConfig.maxLinkLength else { return "it is \(link.count) characters, over \(WrappedConfig.maxLinkLength)" }
        guard let url = URL(string: link), RecapLink.recap(from: url) != nil else { return "this app cannot read it back" }
        return nil
    }

    /// wrapped/mac/agent.py `slugify`: ASCII letters and digits, at most 40 characters.
    static func slugify(_ text: String, fallback: String = "chat") -> String {
        var out = ""
        var dash = false
        for scalar in String(text.prefix(200)).lowercased().unicodeScalars {
            if ("a"..."z").contains(scalar) || ("0"..."9").contains(scalar) {
                if dash && !out.isEmpty { out.append("-") }
                dash = false
                out.unicodeScalars.append(scalar)
            } else {
                dash = true
            }
        }
        var slug = String(out.prefix(40))
        while slug.hasSuffix("-") { slug.removeLast() }
        return slug.isEmpty ? fallback : slug
    }
}
