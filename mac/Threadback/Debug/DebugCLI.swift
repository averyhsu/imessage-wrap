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
