import AppKit
import XCTest

/// The fixture (tests/fixtures/build_fixture.py output) and the Python outputs to compare
/// with come from the CI workflow through TEST_RUNNER_THREADBACK_FIXTURE / _EXPECTED.
enum Fixture {
    static var root: URL? {
        ProcessInfo.processInfo.environment["THREADBACK_FIXTURE"].map { URL(fileURLWithPath: $0, isDirectory: true) }
    }

    static var expected: URL? {
        ProcessInfo.processInfo.environment["THREADBACK_EXPECTED"].map { URL(fileURLWithPath: $0, isDirectory: true) }
    }

    static func require() throws -> URL {
        guard let root else { throw XCTSkip("THREADBACK_FIXTURE is not set (CI sets it)") }
        return root
    }

    static let tacoIdentifier = "chat100000000000000001"
    static let bookClubIdentifier = "chat200000000000000002"

    static func note(_ text: String) {
        print("WRAPPED_NOTE \(text)")
    }
}

final class EngineTests: XCTestCase {
    func testEngineLoadsInJavaScriptCore() throws {
        let engine = try ThreadbackEngine()
        let hasDecoder = engine.context.evaluateScript("typeof TextDecoder")?.toString() ?? "?"
        let polyfilled = engine.context.evaluateScript("TextDecoder.name")?.toString() ?? "?"
        let intl = engine.context.evaluateScript("new Intl.DateTimeFormat('en-US', {timeZone: 'Asia/Tokyo', hour: 'numeric', hourCycle: 'h23'}).format(new Date(0))")?.toString() ?? "?"
        Fixture.note("JavaScriptCore: TextDecoder is \(hasDecoder) (\(polyfilled)); Intl in Asia/Tokyo at epoch: \(intl); engine \(engine.context.evaluateScript("WrappedEngine.GENERATOR")?.toString() ?? "?")")
        XCTAssertTrue(intl == "9" || intl == "09", "Intl with a time zone works in JavaScriptCore")
    }

    func testListsTheFixtureGroupChats() throws {
        let root = try Fixture.require()
        let engine = try ThreadbackEngine()
        let token = engine.open(try SQLiteDB(path: root.appendingPathComponent("mac/chat.db").path))
        let contacts = engine.contacts(fromAddressBook: root.appendingPathComponent("mac/AddressBook").path)
        let chats = try engine.listChats(token: token, me: "Amara", contacts: contacts)
        Fixture.note("listChats: " + chats.map { "\($0.name) (\($0.messages))" }.joined(separator: " | "))
        XCTAssertEqual(chats.count, 4)
        XCTAssertEqual(chats.first?.chatIdentifier, Fixture.tacoIdentifier)
        XCTAssertGreaterThan(contacts.count, 0)
    }

    /// Proof 2: byte-identical with `python3 -m wrapped stats … --compact` for every case
    /// the workflow prepared (cases.json + one file per case).
    func testStatsAreByteIdenticalToPython() throws {
        let root = try Fixture.require()
        guard let expected = Fixture.expected else { throw XCTSkip("THREADBACK_EXPECTED is not set") }
        let cases = try JSONSerialization.jsonObject(with: Data(contentsOf: expected.appendingPathComponent("cases.json"))) as? [[String: Any]] ?? []
        XCTAssertGreaterThanOrEqual(cases.count, 3)
        let engine = try ThreadbackEngine()
        let token = engine.open(try SQLiteDB(path: root.appendingPathComponent("mac/chat.db").path))
        let contacts = engine.contacts(fromAddressBook: root.appendingPathComponent("mac/AddressBook").path)
        var identical = 0
        for item in cases {
            let id = item["id"] as? String ?? "?"
            let json = try engine.statsJSON(token: token, chat: item["chat"] as? String ?? "", me: item["me"] as? String ?? "Me",
                                            tz: item["tz"] as? String, period: item["period"] as? String,
                                            contacts: (item["contacts"] as? Bool ?? false) ? contacts : [],
                                            shortNames: item["short"] as? Bool ?? true)
            var python = try String(contentsOf: expected.appendingPathComponent("\(id).json"), encoding: .utf8)
            if python.hasSuffix("\n") { python.removeLast() }
            if json == python { identical += 1 }
            XCTAssertEqual(json, python, "case \(id)")
            Fixture.note("parity \(id): \(json == python ? "IDENTICAL" : "DIFFERENT") (\(json.utf8.count) bytes vs \(python.utf8.count))")
        }
        Fixture.note("parity: \(identical)/\(cases.count) cases byte-identical to Python")
    }

    /// Proof 3 (text): the recap text equals the Python helper's for the same chat.
    func testRecapTextMatchesPythonHelper() throws {
        let root = try Fixture.require()
        guard let expected = Fixture.expected else { throw XCTSkip("THREADBACK_EXPECTED is not set") }
        let file = expected.appendingPathComponent("recap-taco-2026.txt")
        var python = try String(contentsOf: file, encoding: .utf8)
        if python.hasSuffix("\n") { python.removeLast() }
        let engine = try ThreadbackEngine()
        let token = engine.open(try SQLiteDB(path: root.appendingPathComponent("mac/chat.db").path))
        let contacts = engine.contacts(fromAddressBook: root.appendingPathComponent("mac/AddressBook").path)
        let full = try engine.statsJSON(token: token, chat: "1", me: "Amara", tz: "America/Los_Angeles", period: "2026",
                                        contacts: contacts, shortNames: false)
        let short = try engine.shortNames(statsJSON: full, me: "Amara")
        let text = try engine.recapText(statsJSON: short, withLink: false).message
        XCTAssertEqual(text, python, "no-link wording, as the Python helper with --no-link")
        var pythonLink = try String(contentsOf: expected.appendingPathComponent("recap-taco-2026-link.txt"), encoding: .utf8)
        if pythonLink.hasSuffix("\n") { pythonLink.removeLast() }
        let withLink = try engine.recapText(statsJSON: short, withLink: true).message
        XCTAssertEqual(withLink, pythonLink)
        Fixture.note("recap text identical to the Python helper: no link \(text == python), with link \(withLink == pythonLink)")
    }

    func testLinkRoundTripsThroughSharedSwiftDecoder() throws {
        let root = try Fixture.require()
        let engine = try ThreadbackEngine()
        let token = engine.open(try SQLiteDB(path: root.appendingPathComponent("mac/chat.db").path))
        let stats = try engine.statsJSON(token: token, chat: "1", me: "Amara", tz: "America/Los_Angeles", period: "2026",
                                         contacts: [], shortNames: true)
        let link = try engine.buildLink(statsJSON: stats, quotes: false)
        XCTAssertLessThanOrEqual(link.count, 4800)
        let recap = try XCTUnwrap(RecapLink.recap(from: try XCTUnwrap(URL(string: link))))
        XCTAssertEqual(recap.summary.chatName, "Taco Tuesday Crew \u{1F32E}")
        let decoded = try engine.statsFromURL(link)
        XCTAssertTrue(decoded.contains("\"Taco Tuesday Crew \u{1F32E}\""))
        Fixture.note("link: \(link.count) characters; RecapLink decodes \(recap.summary.caption), \(recap.summary.messagesLine)")
    }

    func testTriggers() throws {
        let engine = try ThreadbackEngine()
        XCTAssertEqual(engine.parseTrigger("/wrapped", currentYear: 2026), Trigger(command: "wrapped", period: nil))
        XCTAssertEqual(engine.parseTrigger(" /Recap 2025 ", currentYear: 2026), Trigger(command: "recap", period: "2025"))
        XCTAssertEqual(engine.parseTrigger("/wrapped all", currentYear: 2026), Trigger(command: "wrapped", period: "all"))
        XCTAssertNil(engine.parseTrigger("/wrapped 2030", currentYear: 2026))
        XCTAssertNil(engine.parseTrigger("hey /wrapped", currentYear: 2026))
        XCTAssertNil(engine.parseTrigger("/wrapped please", currentYear: 2026))
    }

    func testCardRenders() throws {
        let summary = RecapSummary(chatName: "Taco Tuesday Crew \u{1F32E}", periodLabel: "2026", totalMessages: 2869)
        let png = try XCTUnwrap(MacCardRenderer.pngData(for: summary))
        let rep = try XCTUnwrap(NSBitmapImageRep(data: png))
        XCTAssertEqual(rep.pixelsWide, 1080)
        XCTAssertEqual(rep.pixelsHigh, 810)
    }
}

/// The agent's rules on a copy of the fixture, with a recording sender (no real send).
final class AgentTests: XCTestCase {
    private var folder: URL!
    private var dbPath: String!

    override func setUpWithError() throws {
        let root = try Fixture.require()
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("threadback-agent-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        for name in ["chat.db", "chat.db-wal", "chat.db-shm"] {
            let source = root.appendingPathComponent("mac/\(name)")
            if FileManager.default.fileExists(atPath: source.path) {
                try FileManager.default.copyItem(at: source, to: folder.appendingPathComponent(name))
            }
        }
        dbPath = folder.appendingPathComponent("chat.db").path
    }

    override func tearDownWithError() throws {
        if let folder { try? FileManager.default.removeItem(at: folder) }
    }

    @discardableResult
    private func insert(_ text: String, chat identifier: String, secondsAgo: Double = 1) throws -> Int {
        let db = try SQLiteDB(path: dbPath, readOnly: false)
        let chat = try XCTUnwrap(try db.query("SELECT ROWID FROM chat WHERE chat_identifier = ? ORDER BY ROWID LIMIT 1", [identifier]).rows.first?.first?.int)
        let handle = try db.query("SELECT MIN(ROWID) FROM handle").rows.first?.first?.int ?? 0
        let date = Int64((Date().timeIntervalSince1970 - secondsAgo - MessagesDB.appleEpoch) * 1e9)
        let rowid = try db.execute("INSERT INTO message (guid, text, handle_id, date, is_from_me) VALUES (?, ?, ?, ?, 0)",
                                   ["TEST-\(UUID().uuidString)", text, handle, date])
        _ = try db.execute("INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)", [chat, Int(rowid)])
        return Int(rowid)
    }

    private func makeAgent(_ sender: RecordingSender, statePath: URL? = nil) throws -> (Agent, [String]) {
        let engine = try ThreadbackEngine()
        let token = engine.open(try SQLiteDB(path: dbPath))
        let chats = try engine.listChats(token: token, me: "Amara", contacts: [])
        engine.close(token)
        var config = AgentConfig()
        config.me = "Amara"
        config.tz = "America/Los_Angeles"
        config.joinAttempts = 2
        config.joinDelay = 0.05
        let path = dbPath!
        let agent = Agent(engine: engine, sender: sender, config: config, openDatabase: { try SQLiteDB(path: path) }, statePath: statePath)
        agent.approve(chats.filter { $0.chatIdentifier == Fixture.tacoIdentifier }.map(Agent.chatRef))
        var lines: [String] = []
        agent.log = { lines.append($0) }
        return (agent, lines)
    }

    func testAnswersOnceInTheApprovedChatAndFollowsTheRules() throws {
        let sender = RecordingSender()
        let (agent, _) = try makeAgent(sender)
        agent.config.link = true  // as when the story site is live
        var log: [String] = []
        agent.log = { log.append($0) }

        XCTAssertEqual(try agent.runOnce(), 0, "first pass only sets the cursor")
        try insert("/wrapped 2026", chat: Fixture.tacoIdentifier)
        XCTAssertEqual(try agent.runOnce(), 1)
        XCTAssertEqual(sender.sent.map(\.kind), ["file", "text", "text"], "card, text, then the link alone")
        XCTAssertTrue(sender.sent[1].payload.hasPrefix("\u{1F9F5} Taco Tuesday Crew"))
        XCTAssertTrue(sender.sent[2].payload.hasPrefix("https://averyhsu.github.io/imessage-wrap/#w1="))

        XCTAssertEqual(try agent.runOnce(), 0, "a command is answered once")
        try insert("/wrapped", chat: Fixture.tacoIdentifier)
        XCTAssertEqual(try agent.runOnce(), 0, "cooldown")
        XCTAssertTrue(log.contains { $0.contains("cooling down") })

        try insert("/wrapped", chat: Fixture.bookClubIdentifier)
        XCTAssertEqual(try agent.runOnce(), 0, "a chat that was not approved")
        XCTAssertTrue(log.contains { $0.contains("not in the approved list") })

        agent.config.cooldown = 0
        try insert("/wrapped", chat: Fixture.tacoIdentifier, secondsAgo: 1200)
        XCTAssertEqual(try agent.runOnce(), 0, "stale")
        try insert("/wrapped", chat: Fixture.tacoIdentifier, secondsAgo: -3600)
        XCTAssertEqual(try agent.runOnce(), 0, "from the future")
        try insert("tell me about /wrapped", chat: Fixture.tacoIdentifier)
        XCTAssertEqual(try agent.runOnce(), 0, "not a whole-message command")
        XCTAssertEqual(sender.sent.count, 3, "nothing else was sent")
        Fixture.note("agent log: " + log.joined(separator: " || "))
    }

    /// A reply follows the story-site switch: with the site live it is the card, the text and
    /// the link on its own (a link that starts with the site, within 4,800 characters, that
    /// this app decodes); without it, the card and the text with no line about a link.
    func testDefaultReplyFollowsTheStorySiteSwitch() throws {
        let sender = RecordingSender()
        let (agent, _) = try makeAgent(sender)
        XCTAssertEqual(agent.config.link, MacConfig.storySiteIsLive)
        XCTAssertEqual(try agent.runOnce(), 0)
        try insert("/wrapped 2026", chat: Fixture.tacoIdentifier)
        XCTAssertEqual(try agent.runOnce(), 1)
        if MacConfig.storySiteIsLive {
            XCTAssertEqual(sender.sent.map(\.kind), ["file", "text", "text"])
            XCTAssertTrue(sender.sent[1].payload.contains("link below"))
            let link = sender.sent[2].payload
            XCTAssertTrue(link.hasPrefix("https://averyhsu.github.io/imessage-wrap/#w1="))
            XCTAssertLessThanOrEqual(link.count, 4800)
            XCTAssertNil(Agent.linkProblem(link))
        } else {
            XCTAssertEqual(sender.sent.map(\.kind), ["file", "text"])
            XCTAssertFalse(sender.sent[1].payload.contains("https://"))
            XCTAssertFalse(sender.sent[1].payload.contains("link below"))
        }
    }

    func testLinkGuard() {
        XCTAssertNotNil(Agent.linkProblem("https://example.com/#w1=abc"), "another site")
        XCTAssertNotNil(Agent.linkProblem("https://averyhsu.github.io/imessage-wrap/#w1=" + String(repeating: "A", count: 5000)), "too long")
        XCTAssertNotNil(Agent.linkProblem("https://averyhsu.github.io/imessage-wrap/#w1=not-a-payload"), "undecodable")
    }

    /// "Copy test report" carries statuses, counts and error numbers, and nothing that
    /// identifies a person or a chat.
    func testTestReportHasNoNamesNumbersOrChats() throws {
        let root = try Fixture.require()
        let sender = RecordingSender()
        let (agent, _) = try makeAgent(sender)
        var outcomes: [ReplyOutcome] = []
        agent.onReply = { outcomes.append($0) }
        XCTAssertEqual(try agent.runOnce(), 0)
        try insert("/wrapped 2026", chat: Fixture.tacoIdentifier)
        XCTAssertEqual(try agent.runOnce(), 1)
        var records = outcomes.map { ReplyRecord($0, time: Date()) }
        // and a reply as the real sender reports it: the id form and an AppleScript error
        let chat = ChatRef(guid: "iMessage;+;\(Fixture.tacoIdentifier)", identifier: Fixture.tacoIdentifier,
                           name: "Taco Tuesday Crew \u{1F32E}", rowid: 1, members: 7)
        var failed = SendResult(status: .failed, reason: "not allowed to control Messages for Taco Tuesday Crew")
        failed.errorNumber = -1743
        failed.idForm = AppleScriptSender.idForm(chat.guid)
        var outcome = ReplyOutcome(chat: chat, trigger: Trigger(command: "wrapped", period: nil))
        outcome.results = [("card", failed)]
        outcome.text = "secret message text"
        records.append(ReplyRecord(outcome, time: Date()))

        var facts = ReportFacts()
        facts.groupChats = 4
        facts.totalMessages = 4833
        facts.replies = records
        facts.directReadBeforeGrant = TestReport.shortRead("open failed: errno 1 (Operation not permitted)")
        let report = TestReport.text(facts)
        Fixture.note("test report sample: \(report)")
        XCTAssertTrue(report.contains("iMessage;+;"))
        XCTAssertTrue(report.contains("error -1743"))
        XCTAssertTrue(report.contains("errno 1 (Operation not permitted)"))
        XCTAssertTrue(report.contains("4 group chats, 4833 messages"))

        // Nothing from the fixture: chat names, chat ids, contact names and handles, the owner.
        let engine = try ThreadbackEngine()
        let token = engine.open(try SQLiteDB(path: dbPath))
        let contacts = engine.contacts(fromAddressBook: root.appendingPathComponent("mac/AddressBook").path)
        let chats = try engine.listChats(token: token, me: "Amara", contacts: contacts)
        var forbidden = ["Amara", "Taco", "Tuesday", "Book Club", "secret", "chat100000000000000001", "555", "@example.com"]
        forbidden += chats.map(\.name) + chats.map(\.guid) + chats.map(\.chatIdentifier)
        for pair in contacts { forbidden += pair.filter { $0.count >= 4 } }
        for word in forbidden where !word.isEmpty {
            XCTAssertFalse(report.contains(word), "the report contains \(word)")
        }
        XCTAssertGreaterThan(forbidden.count, 12)
    }

    /// One command never gets two replies, even when a relaunch starts reading from an
    /// earlier row (the last answered message of each chat is stored before sending).
    func testNeverTwoRepliesForOneCommandAcrossRelaunches() throws {
        let statePath = folder.appendingPathComponent("state.json")
        let first = RecordingSender()
        let (agent1, _) = try makeAgent(first, statePath: statePath)
        XCTAssertEqual(try agent1.runOnce(), 0)
        try insert("/wrapped", chat: Fixture.tacoIdentifier)
        XCTAssertEqual(try agent1.runOnce(), 1)
        XCTAssertEqual(first.sent.count, MacConfig.storySiteIsLive ? 3 : 2)
        // A relaunch whose cursor is behind the command (as after a crash before the save).
        var state = AgentState.load(statePath)
        XCTAssertNotNil(state.answered[Fixture.tacoIdentifier])
        state.cursor = (state.cursor ?? 1) - 1
        state.cooldowns = [:]
        state.save(statePath)
        let second = RecordingSender()
        let (agent2, _) = try makeAgent(second, statePath: statePath)
        var log: [String] = []
        agent2.log = { log.append($0) }
        XCTAssertEqual(try agent2.runOnce(), 0, "the same command is not answered twice")
        XCTAssertTrue(second.sent.isEmpty)
        XCTAssertTrue(log.contains { $0.contains("already answered") }, log.joined(separator: " | "))
    }

    /// A state file written by an earlier version (no "answered") still loads.
    func testOldStateFileStillLoads() throws {
        let path = folder.appendingPathComponent("old-state.json")
        try Data(#"{"cursor": 42, "cooldowns": {}, "ownRowids": [1]}"#.utf8).write(to: path)
        let state = AgentState.load(path)
        XCTAssertEqual(state.cursor, 42)
        XCTAssertEqual(state.answered, [:])
    }

    func testIdFormIsACategory() {
        XCTAssertEqual(AppleScriptSender.idForm("any;+;chat123456"), "any;+;")
        XCTAssertEqual(AppleScriptSender.idForm("iMessage;-;+15550100001"), "iMessage;-;")
        XCTAssertEqual(AppleScriptSender.idForm("SMS;+;chat1"), "SMS;+;")
        XCTAssertEqual(AppleScriptSender.idForm("weird"), "other")
        XCTAssertEqual(AppleScriptSender.idForm("x;+;chat1"), "other")
    }

    func testAppLocation() {
        let home = "/Users/someone"
        XCTAssertEqual(AppLocation.classify(bundlePath: "/Applications/Threadback.app", home: home), .applications)
        XCTAssertEqual(AppLocation.classify(bundlePath: "/Users/someone/Applications/Threadback.app", home: home), .userApplications)
        XCTAssertEqual(AppLocation.classify(bundlePath: "/Users/someone/Downloads/Threadback.app", home: home), .downloads)
        XCTAssertEqual(AppLocation.classify(bundlePath: "/Users/someone/Downloads/Threadback-for-Mac/Threadback.app", home: home), .downloads)
        XCTAssertEqual(AppLocation.classify(bundlePath: "/private/var/folders/x/T/AppTranslocation/ABC/d/Threadback.app", home: home), .translocated)
        XCTAssertEqual(AppLocation.classify(bundlePath: "/Users/someone/Desktop/Threadback.app", home: home), .other)
        XCTAssertTrue(AppLocation.translocated.needsMove)
        XCTAssertFalse(AppLocation.translocated.canMoveItself)
        XCTAssertTrue(AppLocation.downloads.canMoveItself)
        XCTAssertFalse(AppLocation.applications.needsMove)
        XCTAssertEqual(TestReport.scrub("/Users/someone/Library and someone", home: "/Users/someone", user: "someone", fullName: "Some One"),
                       "~/Library and <user>")
    }

    func testRenamedApprovedChatStaysApprovedAndNewNameAddsNothing() throws {
        let sender = RecordingSender()
        let (agent, _) = try makeAgent(sender)
        XCTAssertEqual(try agent.runOnce(), 0)
        let db = try SQLiteDB(path: dbPath, readOnly: false)
        _ = try db.execute("UPDATE chat SET display_name = 'Taco Tuesday Crew 2' WHERE chat_identifier = ?", [Fixture.bookClubIdentifier])
        _ = try db.execute("UPDATE chat SET display_name = 'Renamed Tacos' WHERE chat_identifier = ? AND display_name != ''", [Fixture.tacoIdentifier])
        try insert("/wrapped", chat: Fixture.bookClubIdentifier)
        XCTAssertEqual(try agent.runOnce(), 0, "a chat renamed to look like the approved one is not added")
        try insert("/recap", chat: Fixture.tacoIdentifier)
        XCTAssertEqual(try agent.runOnce(), 1, "the approved chat, renamed, is still approved")
        XCTAssertTrue(sender.sent[1].payload.contains("Renamed Tacos"))
    }

    /// Proof 3 (files): a dry run writes the card, the text and the link to a folder.
    func testDryRunWritesCardTextAndLink() throws {
        let sender = RecordingSender()
        let (agent, _) = try makeAgent(sender)
        agent.config.dryRun = true
        agent.config.outFolder = folder.appendingPathComponent("dry-run")
        let chat = ChatRef(guid: "iMessage;+;\(Fixture.tacoIdentifier)", identifier: Fixture.tacoIdentifier, name: "Taco Tuesday Crew \u{1F32E}", rowid: 1, members: 7)
        let outcome = agent.preview(chat, period: "2026")
        XCTAssertEqual(outcome.error, "")
        let out = try XCTUnwrap(outcome.folder)
        let files = try FileManager.default.contentsOfDirectory(atPath: out.path).sorted()
        Fixture.note("dry run wrote: \(files.joined(separator: ", "))")
        XCTAssertTrue(files.contains("recap.txt"))
        XCTAssertTrue(files.contains("link.txt"))
        XCTAssertTrue(files.contains { $0.hasPrefix("threadback-taco-tuesday-crew-2026") && $0.hasSuffix(".png") })
    }

    // MARK: Review batch 1: pause, turn off, one copy, staged cards, consent

    /// The owner's switches, as the app passes them to its agent.
    private func controlled(_ agent: Agent, live: Bool = true) -> AgentControl {
        let control = AgentControl()
        control.liveKeys = live ? [Fixture.tacoIdentifier] : []
        agent.control = control
        return control
    }

    /// Test 1: while paused, a file event or the safety poll sends nothing; on Resume reading
    /// starts from the newest message, so nothing typed during the pause is ever answered.
    func testPausedSendsNothingAndResumeStartsFromNow() throws {
        let sender = RecordingSender()
        let (agent, _) = try makeAgent(sender)
        let control = controlled(agent)
        XCTAssertEqual(try agent.runOnce(), 0)
        control.paused = true
        try insert("/wrapped", chat: Fixture.tacoIdentifier)
        XCTAssertEqual(try agent.runOnce(), 0, "a watcher event while paused")
        XCTAssertEqual(try agent.runOnce(), 0, "the safety poll while paused")
        XCTAssertTrue(sender.sent.isEmpty, "nothing is sent while paused")
        control.paused = false
        try agent.skipToNow()
        XCTAssertEqual(try agent.runOnce(), 0)
        XCTAssertTrue(sender.sent.isEmpty, "a command typed during the pause is not answered after Resume")
        try insert("/wrapped", chat: Fixture.tacoIdentifier)
        XCTAssertEqual(try agent.runOnce(), 1, "a command typed after Resume is answered")
    }

    /// Test 3: Turn off (or Pause) clicked while a reply is going out: nothing more is sent,
    /// and turning the chat on again does not bring a second reply inside the cooldown.
    func testTurnOffDuringAReplyStopsItAndNoSecondReplyInsideTheCooldown() throws {
        let sender = RecordingSender()
        let (agent, _) = try makeAgent(sender)
        agent.config.link = true
        let control = controlled(agent)
        XCTAssertEqual(try agent.runOnce(), 0)
        sender.afterSend = { _ in control.liveKeys = [] }      // Turn off, while the card goes out
        try insert("/wrapped", chat: Fixture.tacoIdentifier)
        _ = try agent.runOnce()
        XCTAssertEqual(sender.sent.map(\.kind), ["file"], "nothing is sent after Turn off")
        XCTAssertEqual(agent.lastOutcome?.error, Agent.stopped)
        sender.afterSend = nil
        control.liveKeys = [Fixture.tacoIdentifier]            // on again, at once
        try insert("/wrapped", chat: Fixture.tacoIdentifier)
        XCTAssertEqual(try agent.runOnce(), 0, "no second reply inside the cooldown")
        XCTAssertEqual(sender.sent.count, 1)

        // The same for Pause, in another agent on a fresh cooldown.
        let second = RecordingSender()
        let (other, _) = try makeAgent(second)
        other.config.link = true
        let switches = controlled(other)
        XCTAssertEqual(try other.runOnce(), 0)
        second.afterSend = { item in if item.kind == "text" { switches.paused = true } }
        try insert("/wrapped", chat: Fixture.tacoIdentifier)
        _ = try other.runOnce()
        XCTAssertEqual(second.sent.map(\.kind), ["file", "text"], "the link is not sent after Pause")
    }

    /// Test 2 (the lock): only one copy holds it; a copy that hands over lets the next one in.
    func testOnlyOneCopyHoldsTheInstanceLock() throws {
        let path = folder.appendingPathComponent("instance.lock")
        let first = InstanceLock(path: path)
        let second = InstanceLock(path: path)
        XCTAssertTrue(first.acquire())
        XCTAssertFalse(second.acquire(retryFor: 0.3), "a second copy does not get the lock")
        // Move to Applications: the old copy lets go a moment after the new one started.
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.5) { first.release() }
        XCTAssertTrue(second.acquire(retryFor: 3), "the new copy gets it once the old one lets go")
        XCTAssertFalse(first.acquire(), "and the old one cannot take it back")
        second.release()
    }

    /// Test 5a: every send stages its own card under a new name, so two chats whose names make
    /// the same slug never get each other's picture; at most 30 staged cards are kept.
    func testCollidingSlugsNeverShareACard() throws {
        let db = try SQLiteDB(path: dbPath, readOnly: false)
        _ = try db.execute("UPDATE chat SET display_name = 'Taco Tuesday Crew!' WHERE chat_identifier = ?", [Fixture.bookClubIdentifier])
        _ = try db.execute("UPDATE chat SET display_name = 'Taco Tuesday Crew?' WHERE chat_identifier = ?", [Fixture.tacoIdentifier])
        XCTAssertEqual(Agent.slugify("Taco Tuesday Crew!"), Agent.slugify("Taco Tuesday Crew?"))
        let sender = RecordingSender()
        let (agent, _) = try makeAgent(sender)
        let engine = try ThreadbackEngine()
        let token = engine.open(try SQLiteDB(path: dbPath))
        let both = try engine.listChats(token: token, me: "Amara", contacts: [])
            .filter { [Fixture.tacoIdentifier, Fixture.bookClubIdentifier].contains($0.chatIdentifier) }
        engine.close(token)
        XCTAssertEqual(both.count, 2)
        agent.approve(both.map(Agent.chatRef))
        var cards: [String: (String, Data)] = [:]
        sender.afterSend = { item in
            if item.kind == "file", let data = FileManager.default.contents(atPath: item.payload) { cards[item.chatKey] = (item.payload, data) }
        }
        XCTAssertEqual(try agent.runOnce(), 0)
        try insert("/wrapped", chat: Fixture.tacoIdentifier)
        try insert("/wrapped", chat: Fixture.bookClubIdentifier)
        XCTAssertEqual(try agent.runOnce(), 2)
        let taco = try XCTUnwrap(cards[Fixture.tacoIdentifier])
        let club = try XCTUnwrap(cards[Fixture.bookClubIdentifier])
        XCTAssertNotEqual(taco.0, club.0, "each reply has its own card file")
        XCTAssertNotEqual(taco.1, club.1, "each chat gets its own picture")

        let staging = folder.appendingPathComponent("staging", isDirectory: true)
        let a = AppleScriptSender.stagedURL(in: staging, extension: "png")
        let b = AppleScriptSender.stagedURL(in: staging, extension: "png")
        XCTAssertNotEqual(a, b)
        XCTAssertTrue(a.lastPathComponent.hasPrefix("threadback-card-"))
        XCTAssertFalse(a.lastPathComponent.contains("taco"), "the staged name carries no chat name")
        try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
        var made: [URL] = []
        for i in 0..<35 {
            let url = AppleScriptSender.stagedURL(in: staging, extension: "png")
            try Data([UInt8(i)]).write(to: url)
            try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSinceNow: Double(i - 100))], ofItemAtPath: url.path)
            made.append(url)
        }
        let mine = staging.appendingPathComponent("someone-elses-photo.png")
        try Data([1]).write(to: mine)
        AppleScriptSender.prune(staging, keep: AppleScriptSender.keepStaged)
        let left = try FileManager.default.contentsOfDirectory(atPath: staging.path)
        XCTAssertEqual(left.filter { $0.hasPrefix("threadback-card-") }.count, 30)
        XCTAssertTrue(left.contains("someone-elses-photo.png"), "only Threadback's own cards are pruned")
        XCTAssertFalse(FileManager.default.fileExists(atPath: made[0].path), "the oldest go first")
        XCTAssertTrue(FileManager.default.fileExists(atPath: made[34].path))
    }

    /// Test 5b: what turning a chat on means is said in full, and a change in what a reply
    /// carries asks again before anything is sent in that chat.
    func testConsentAndAChangeInWhatARepliesCarriesAsksAgain() throws {
        XCTAssertNotEqual(Consent.signature(link: true), Consent.signature(link: false))
        XCTAssertTrue(Consent.needsConfirmation(stored: nil), "a chat turned on before signatures existed")
        XCTAssertTrue(Consent.needsConfirmation(stored: Consent.signature(link: false), current: Consent.signature(link: true)))
        XCTAssertFalse(Consent.needsConfirmation(stored: Consent.signature()))
        let statement = Consent.statement(link: true)
        for words in ["/wrapped", "Apple ID", "three messages", "a picture, a short text and a link", "Anyone in the chat",
                      "once every 2 minutes", "first names", "no message text", "forwarded"] {
            XCTAssertTrue(statement.contains(words), "the statement says \(words)")
        }
        XCTAssertTrue(Consent.changedStatement.contains("Nothing is sent in this chat until you choose"))
        Fixture.note("consent: \(Consent.title(chat: "Taco Tuesday Crew")) | \(statement) | \(Consent.changedTitle(chat: "Taco Tuesday Crew")) | \(Consent.changedStatement)")

        // Approved under the old signature: not live until the owner clicks Keep on.
        let sender = RecordingSender()
        let (agent, _) = try makeAgent(sender)
        let control = controlled(agent, live: false)
        XCTAssertEqual(try agent.runOnce(), 0)
        try insert("/wrapped", chat: Fixture.tacoIdentifier)
        XCTAssertEqual(try agent.runOnce(), 0)
        XCTAssertTrue(sender.sent.isEmpty, "nothing is sent before the click")
        control.liveKeys = [Fixture.tacoIdentifier]            // Keep on
        try agent.skipToNow()
        XCTAssertEqual(try agent.runOnce(), 0)
        XCTAssertTrue(sender.sent.isEmpty, "the command typed before the click is not answered later")
    }

    /// L4: a chat is looked up by its id only; an id that is gone is an error, never a name match.
    func testStatsByIdNeverFallsBackToAName() throws {
        let engine = try ThreadbackEngine()
        let token = engine.open(try SQLiteDB(path: dbPath))
        defer { engine.close(token) }
        let taco = try XCTUnwrap(try engine.listChats(token: token, me: "Amara", contacts: []).first { $0.chatIdentifier == Fixture.tacoIdentifier })
        let byId = try engine.statsJSON(token: token, chatID: taco.id, me: "Amara", tz: "America/Los_Angeles", period: "2026", contacts: [], shortNames: true)
        let before = try engine.statsJSON(token: token, chat: String(taco.id), me: "Amara", tz: "America/Los_Angeles", period: "2026", contacts: [], shortNames: true)
        XCTAssertEqual(byId, before)
        XCTAssertThrowsError(try engine.statsJSON(token: token, chatID: 987_654, me: "Amara", tz: nil, period: nil, contacts: [], shortNames: true))
    }
}
