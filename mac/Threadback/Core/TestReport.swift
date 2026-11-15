import Foundation

/// One `/wrapped` reply as the owner may share it: statuses and error numbers only. No chat
/// name, no chat id, no text, no names.
struct ReplyRecord: Codable, Equatable {
    struct Part: Codable, Equatable {
        let part: String          // "image", "text", "link"
        let status: String        // delivered, not confirmed, failed, dry run
        let errorNumber: Int?
        let idForm: String        // "any;+;", "iMessage;-;", ... (a category, never the id)
        let orphan: Bool
    }

    let time: Date
    let period: String            // "default", "all", or a year
    let parts: [Part]
    let failedBeforeSending: Bool

    init(_ outcome: ReplyOutcome, time: Date) {
        self.time = time
        self.period = outcome.trigger.period ?? "default"
        self.failedBeforeSending = !outcome.error.isEmpty
        self.parts = outcome.results.map { item in
            let (name, result) = item
            return Part(part: name == "card" ? "image" : name, status: ReplyRecord.word(result.status),
                 errorNumber: result.errorNumber, idForm: result.idForm, orphan: result.orphan)
        }
    }

    static func word(_ status: SendResult.Status) -> String {
        switch status {
        case .delivered: return "delivered"
        case .unverified: return "not confirmed"
        case .failed: return "failed"
        case .dryRun: return "dry run"
        }
    }

    /// "image: delivered · text: failed (error -1743)"
    var summary: String {
        if failedBeforeSending && parts.isEmpty { return "could not build the reply" }
        return parts.map { part in
            var line = "\(part.part): \(part.status)"
            if let number = part.errorNumber { line += " (error \(number))" }
            if part.orphan { line += " (row attached to no chat)" }
            return line
        }.joined(separator: " · ")
    }
}

/// Everything the "Copy test report" text is made of. Only categories, counts, statuses
/// and error numbers go in; the builder never sees a name.
struct ReportFacts {
    var appVersion = "?"
    var commit = "?"
    var signature = "?"
    var macOS = "?"
    var architecture = "?"
    var location = "?"
    var directReadBeforeGrant = "not tried"
    var readAfterGrant = "not tried"
    var walReadable = "not tried"
    var accessMethod = "not set up"
    var bookmarkThisLaunch = "not used"
    var readNow = "not tried"
    var groupChats: Int?
    var totalMessages: Int?
    var contacts = "?"
    var automation = "not asked"
    var loginItem = "?"
    var linkInReplies = "?"
    var chatsTurnedOn = 0
    var watcher = "not running"
    var card = "?"
    var replies: [ReplyRecord] = []
}

enum TestReport {
    static func text(_ facts: ReportFacts, now: Date = Date()) -> String {
        let stamp = ISO8601DateFormatter()
        var lines = [
            "Threadback test report (\(stamp.string(from: now)))",
            "App: \(facts.appVersion), commit \(facts.commit), signature \(facts.signature)",
            "macOS: \(facts.macOS), \(facts.architecture)",
            "Running from: \(facts.location)",
            "Messages folder:",
            "  direct read before Grant Access: \(facts.directReadBeforeGrant)",
            "  read after Grant Access: \(facts.readAfterGrant)",
            "  chat.db-wal readable: \(facts.walReadable)",
            "  access method: \(facts.accessMethod)",
            "  bookmark on this launch: \(facts.bookmarkThisLaunch)",
            "  read now: \(facts.readNow)",
            "Counts: \(facts.groupChats.map { String($0) } ?? "?") group chats, \(facts.totalMessages.map { String($0) } ?? "?") messages",
            "Contacts: \(facts.contacts)",
            "Automation (control Messages): \(facts.automation)",
            "Login item: \(facts.loginItem)",
            "Link in replies: \(facts.linkInReplies)",
            "Chats turned on: \(facts.chatsTurnedOn)",
            "Watching for new messages: \(facts.watcher)",
            "Card: \(facts.card)",
        ]
        if facts.replies.isEmpty {
            lines.append("Replies to /wrapped: none yet")
        } else {
            lines.append("Last replies to /wrapped (newest first):")
            for (index, reply) in facts.replies.reversed().prefix(5).enumerated() {
                let forms = Set(reply.parts.map(\.idForm).filter { !$0.isEmpty }).sorted().joined(separator: ", ")
                lines.append("  \(index + 1). \(stamp.string(from: reply.time)) period \(reply.period): \(reply.summary)"
                             + (forms.isEmpty ? "" : " [chat id form \(forms)]"))
            }
        }
        return scrub(lines.joined(separator: "\n"))
    }

    /// Belt and braces: the home folder and the account name never appear.
    static func scrub(_ text: String, home: String = NSHomeDirectory(), user: String = NSUserName(),
                      fullName: String = NSFullUserName()) -> String {
        var out = text
        if home.count > 1 { out = out.replacingOccurrences(of: home, with: "~") }
        for name in [fullName, user] where name.count >= 3 {
            out = out.replacingOccurrences(of: name, with: "<user>")
        }
        return out
    }

    /// "ok" or "errno 1 (Operation not permitted)" from AccessProbe.posixRead.
    static func shortRead(_ posix: String) -> String {
        if posix.hasPrefix("ok") { return "ok" }
        if let range = posix.range(of: "errno ") { return String(posix[range.lowerBound...]) }
        return posix
    }

    /// A SQLite or other error as numbers and generic words only.
    static func shortError(_ error: Error) -> String {
        if let sqlite = error as? SQLiteError {
            return "SQLite error \(sqlite.code)/\(sqlite.extendedCode)"
        }
        let ns = error as NSError
        return "\(ns.domain) \(ns.code)"
    }
}
