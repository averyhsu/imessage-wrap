#if DEBUG
import AppKit

/// Command-line modes of the app binary, used by CI to compare it with the Python tools
/// (Debug builds only; a Release build has none of this).
///
///   Threadback --tb-stats CHAT --db P [--contacts DIR | --no-contacts] [--me N] [--tz Z]
///              [--year Y | --all-time] [--full-names]       same as `python3 -m wrapped stats … --compact`
///   Threadback --tb-chats --db P [--contacts DIR] [--me N]
///   Threadback --tb-preview --db P --chat NAME --out DIR [--link] [...]   card, recap.txt, link.txt (sends nothing)
///   Threadback --tb-agent-once --db P --chat NAME --state F --out DIR [...]   one dry-run pass of the agent
///   Threadback --tb-decode-link URL                              the stats inside a link, canonical JSON
///   Threadback --tb-print-applescript DIR                        the send script, for osacompile
///   Threadback --tb-probe FOLDER --report FILE                   the access probe, from this process
enum DebugCLI {
    static func run(_ argv: [String]) -> Int32? {
        guard let command = argv.dropFirst().first(where: { $0.hasPrefix("--tb-") }) else { return nil }
        let args = Args(Array(argv.dropFirst()))
        do {
            switch command {
            case "--tb-stats": return try stats(args)
            case "--tb-chats": return try chats(args)
            case "--tb-preview": return try preview(args, agentPass: false)
            case "--tb-agent-once": return try preview(args, agentPass: true)
            case "--tb-decode-link": return try decodeLink(args)
            case "--tb-print-applescript": return try printAppleScript(args)
            case "--tb-probe": return probe(args)
            case "--tb-card-test": return try cardTest(args)
            case "--tb-triggers": return try triggers(args)
            case "--tb-dmg-background":
                let dir = URL(fileURLWithPath: args.value("--tb-dmg-background") ?? ".", isDirectory: true)
                try DMGBackground.write(to: dir)
                out("wrote background.png and background@2x.png to \(dir.path)")
                return 0
            default:
                err("unknown command \(command)")
                return 2
            }
        } catch {
            err("error: \(error)")
            return 1
        }
    }

    struct Args {
        let list: [String]
        init(_ list: [String]) { self.list = list }
        func value(_ name: String) -> String? {
            guard let i = list.firstIndex(of: name), i + 1 < list.count else { return nil }
            return list[i + 1]
        }
        func flag(_ name: String) -> Bool { list.contains(name) }
        var period: String? {
            if flag("--all-time") { return "all" }
            return value("--year")
        }
    }

    static func out(_ text: String) {
        FileHandle.standardOutput.write(Data((text + "\n").utf8))
    }

    static func err(_ text: String) {
        FileHandle.standardError.write(Data((text + "\n").utf8))
    }

    private static func setUp(_ args: Args) throws -> (ThreadbackEngine, Int, [[String]], String) {
        let engine = try ThreadbackEngine(bundle: .main)
        guard let path = args.value("--db") else { throw EngineError(code: "usage", message: "--db PATH is required") }
        let token = engine.open(try SQLiteDB(path: path))
        var contacts: [[String]] = []
        if !args.flag("--no-contacts"), let book = args.value("--contacts") {
            contacts = engine.contacts(fromAddressBook: book)
        }
        let me = args.value("--me") ?? ProcessInfo.processInfo.environment["WRAPPED_ME"] ?? "Me"
        return (engine, token, contacts, me)
    }

    static func stats(_ args: Args) throws -> Int32 {
        guard let chat = args.value("--tb-stats") else { throw EngineError(code: "usage", message: "--tb-stats CHAT") }
        let (engine, token, contacts, me) = try setUp(args)
        let json = try engine.statsJSON(token: token, chat: chat, me: me, tz: args.value("--tz"), period: args.period,
                                        contacts: contacts, shortNames: !args.flag("--full-names"))
        out(json)
        return 0
    }

    static func chats(_ args: Args) throws -> Int32 {
        let (engine, token, contacts, me) = try setUp(args)
        for chat in try engine.listChats(token: token, me: me, contacts: contacts) {
            out(String(format: "%6ld %9ld %8ld  ", chat.id, chat.messages, chat.members) + chat.name)
        }
        return 0
    }

    static func preview(_ args: Args, agentPass: Bool) throws -> Int32 {
        let (engine, token, contacts, me) = try setUp(args)
        defer { engine.close(token) }
        guard let dbPath = args.value("--db"), let pattern = args.value("--chat")?.lowercased(),
              let outDir = args.value("--out") else { throw EngineError(code: "usage", message: "--db, --chat and --out are required") }
        let listed = try engine.listChats(token: token, me: me, contacts: contacts)
        let matches = listed.filter { $0.name.lowercased().contains(pattern) || String($0.id) == pattern }
        guard let first = matches.first else { throw EngineError(code: "no_chat", message: "no group chat matches \(pattern)") }
        var config = AgentConfig()
        config.me = me
        config.tz = args.value("--tz")
        config.contacts = contacts
        config.dryRun = true
        config.outFolder = URL(fileURLWithPath: outDir, isDirectory: true)
        // The link follows MacConfig.storySiteIsLive unless --link / --no-link says otherwise.
        config.link = args.flag("--link") || (MacConfig.storySiteIsLive && !args.flag("--no-link"))
        let sender = RecordingSender()
        let statePath = args.value("--state").map { URL(fileURLWithPath: $0) }
        let agent = Agent(engine: engine, sender: sender, config: config, openDatabase: { try SQLiteDB(path: dbPath) }, statePath: statePath)
        agent.log = { err("log: \($0)") }
        // The card friends receive: the site's own card, drawn by WebKit (--native-card for
        // the old small card).
        if !args.flag("--native-card") {
            _ = NSApplication.shared
            agent.renderCard = { try WebCard.shared.png(statsJSON: $0) }
        }
        if agentPass {
            agent.approve(matches.map(Agent.chatRef))
            err("approved (frozen by id): " + matches.map { "\($0.name) [\($0.key)]" }.joined(separator: ", "))
            let answered = try agent.runOnce()
            for sent in sender.sent { err("would send \(sent.kind) to \(sent.chatKey): \(sent.kind == "file" ? sent.payload : "\(sent.payload.count) characters")") }
            out("Done: \(answered) command(s) answered.")
            if let folder = agent.lastOutcome?.folder { out("Saved in \(folder.path)") }
            return 0
        }
        let outcome = agent.preview(Agent.chatRef(first), period: args.period)
        if !outcome.error.isEmpty { throw EngineError(code: "preview", message: outcome.error) }
        out("Preview for \"\(first.name)\" (nothing was sent): \(outcome.line)")
        if let folder = outcome.folder { out("Saved in \(folder.path)") }
        return 0
    }

    /// Draws the card for every chat of a database (two periods each) and for made-up
    /// hostile names, checks each (1080 x 1350, not blank) and times it. Exit 1 on any failure.
    ///   --tb-card-test OUTDIR --db P [--contacts DIR] [--me N] [--tz Z] [--budget-ms 4000]
    static func cardTest(_ args: Args) throws -> Int32 {
        _ = NSApplication.shared
        guard let outDir = args.value("--tb-card-test") else { throw EngineError(code: "usage", message: "--tb-card-test OUTDIR") }
        let folder = URL(fileURLWithPath: outDir, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let (engine, token, contacts, me) = try setUp(args)
        let budget = Int(args.value("--budget-ms") ?? "") ?? 4000
        var cases: [(String, String)] = []
        for chat in try engine.listChats(token: token, me: me, contacts: contacts) {
            for period in ["2026", "all"] {
                let stats = try engine.statsJSON(token: token, chat: String(chat.id), me: me, tz: args.value("--tz"),
                                                 period: period, contacts: contacts, shortNames: true)
                cases.append(("chat\(chat.id)-\(period)", stats))
            }
        }
        // Hostile and long names, as other people can type them into a group's name.
        if let base = cases.first?.1, var object = try JSONSerialization.jsonObject(with: Data(base.utf8)) as? [String: Any] {
            let long = String(repeating: "Ridiculously Long Group Name \u{1F389}\u{1F32E} ", count: 12)
            let hostile = "\u{202E}evil\u{202C} +1 555 010 9999 \u{0000}\u{001B}[31m x@example.com \u{05E9}\u{05DC}\u{05D5}\u{05DD} \u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}"
            for (name, chatName) in [("long-name", long), ("hostile-name", hostile), ("empty-name", "")] {
                var copy = object
                var chat = (copy["chat"] as? [String: Any]) ?? [:]
                chat["name"] = chatName
                copy["chat"] = chat
                if var senders = copy["senders"] as? [[String: Any]], !senders.isEmpty {
                    senders[0]["name"] = name == "long-name" ? String(repeating: "Bartholomew", count: 8) : hostile
                    copy["senders"] = senders
                }
                let data = try JSONSerialization.data(withJSONObject: copy)
                cases.append((name, String(decoding: data, as: UTF8.self)))
            }
            object["senders"] = []
            object["totals"] = ["messages": 1, "words": 1]
            let data = try JSONSerialization.data(withJSONObject: object)
            cases.append(("one-message-no-senders", String(decoding: data, as: UTF8.self)))
        }
        var failures = 0
        for (index, item) in cases.enumerated() {
            do {
                let png = try WebCard.shared.png(statsJSON: item.1)
                let ms = WebCard.shared.lastMilliseconds
                let problem = WebCard.check(png)
                let limit = index == 0 ? budget * 3 : budget   // the first one also loads the page and the font
                let slow = ms > limit
                if problem != nil || slow { failures += 1 }
                try png.write(to: folder.appendingPathComponent("card-\(item.0).png"))
                out("\(problem == nil && !slow ? "OK  " : "FAIL") card \(item.0): \(png.count) bytes, \(ms) ms\(problem.map { ", \($0)" } ?? "")\(slow ? ", over \(limit) ms" : "")")
            } catch {
                failures += 1
                out("FAIL card \(item.0): \(error)")
            }
        }
        out("cards: \(cases.count - failures)/\(cases.count) passed")
        return failures == 0 ? 0 : 1
    }

    /// The command rule for a list of messages (a JSON array of strings): prints a JSON array
    /// of [command, period] or null, for comparison with wrapped/mac/triggers.py.
    static func triggers(_ args: Args) throws -> Int32 {
        guard let file = args.value("--tb-triggers") else { throw EngineError(code: "usage", message: "--tb-triggers FILE.json") }
        let year = Int(args.value("--year") ?? "") ?? Calendar(identifier: .gregorian).component(.year, from: Date())
        let texts = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: file))) as? [String] ?? []
        let engine = try ThreadbackEngine(bundle: .main)
        let results: [Any] = texts.map { text in
            guard let trigger = engine.parseTrigger(text, currentYear: year) else { return NSNull() }
            return [trigger.command, trigger.period.map { $0 as Any } ?? NSNull()]
        }
        let data = try JSONSerialization.data(withJSONObject: results)
        out(String(decoding: data, as: UTF8.self))
        return 0
    }

    static func decodeLink(_ args: Args) throws -> Int32 {
        guard let link = args.value("--tb-decode-link") else { throw EngineError(code: "usage", message: "--tb-decode-link URL") }
        let engine = try ThreadbackEngine(bundle: .main)
        out(try engine.statsFromURL(link))
        if let url = URL(string: link), let recap = RecapLink.recap(from: url) {
            err("RecapLink (shared Swift code) decodes it: \(recap.summary.caption), \(recap.summary.messagesLine)")
        } else {
            err("RecapLink (shared Swift code) could NOT decode it")
            return 3
        }
        return 0
    }

    static func printAppleScript(_ args: Args) throws -> Int32 {
        let dir = URL(fileURLWithPath: args.value("--tb-print-applescript") ?? ".", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try AppleScriptSender.sendScript.write(to: dir.appendingPathComponent("send.applescript"), atomically: true, encoding: .utf8)
        try AppleScriptSender.countChatsScript.write(to: dir.appendingPathComponent("count-chats.applescript"), atomically: true, encoding: .utf8)
        // Control: the same handler addressed to an app without a "chat" class must NOT compile.
        let control = AppleScriptSender.sendScript.replacingOccurrences(of: "tell application \"Messages\"", with: "tell application \"Finder\"")
        try control.write(to: dir.appendingPathComponent("control-wrong-app.applescript"), atomically: true, encoding: .utf8)
        out("wrote send.applescript, count-chats.applescript, control-wrong-app.applescript to \(dir.path)")
        return 0
    }

    static func probe(_ args: Args) -> Int32 {
        let folder = URL(fileURLWithPath: args.value("--tb-probe") ?? Permissions.defaultMessagesFolder.path, isDirectory: true)
        var report = AccessProbe.run(folder: folder, label: "command line (responsible process: whoever started this binary)")
        report["launched.by"] = "pid \(getppid()) is the parent"
        if let file = args.value("--report") {
            let url = URL(fileURLWithPath: file)
            AccessProbe.write(report, to: url.deletingLastPathComponent(), name: url.lastPathComponent)
        }
        for (key, value) in report.sorted(by: { $0.key < $1.key }) { out("\(key): \(value)") }
        return 0
    }
}
#endif
