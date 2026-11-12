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

    private func makeAgent(_ sender: RecordingSender) throws -> (Agent, [String]) {
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
        let agent = Agent(engine: engine, sender: sender, config: config, openDatabase: { try SQLiteDB(path: path) }, statePath: nil)
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

    /// While the story site is not live, a reply is the image and the text, with no link
    /// and no line pointing at one.
    func testDefaultReplyHasNoLinkWhileTheSiteIsNotLive() throws {
        XCTAssertFalse(MacConfig.storySiteIsLive)
        let sender = RecordingSender()
        let (agent, _) = try makeAgent(sender)
        XCTAssertFalse(agent.config.link)
        XCTAssertEqual(try agent.runOnce(), 0)
        try insert("/wrapped 2026", chat: Fixture.tacoIdentifier)
        XCTAssertEqual(try agent.runOnce(), 1)
        XCTAssertEqual(sender.sent.map(\.kind), ["file", "text"])
        XCTAssertFalse(sender.sent[1].payload.contains("https://"))
        XCTAssertFalse(sender.sent[1].payload.contains("link below"))
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
}
