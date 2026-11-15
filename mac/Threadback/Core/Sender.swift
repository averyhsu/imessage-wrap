import CoreServices
import Foundation

/// The chat a reply goes to: `chat.guid` exactly as stored (handed to Messages verbatim)
/// and `chat.chat_identifier` (merges the iMessage and SMS rows of one group).
struct ChatRef: Codable, Equatable {
    let guid: String
    let identifier: String
    let name: String
    let rowid: Int
    let members: Int

    var key: String { identifier.isEmpty ? guid : identifier }
}

/// How one send ended, from what Messages recorded in chat.db for the exact message:
/// delivered (is_delivered), sent (is_sent, not yet delivered), written (in the chat, not yet
/// sent), unverified (no such message appeared), failed, or dry-run.
struct SendResult: Equatable {
    enum Status: String { case delivered, sent, written, unverified, failed, dryRun = "dry-run" }

    var status: Status
    var reason: String = ""
    var rowid: Int?
    var orphan = false
    /// The AppleScript error number, when Messages refused.
    var errorNumber: Int?
    /// Which spelling of the chat id was used, as a category ("any;+;"), never the id.
    var idForm = ""

    var sentSomething: Bool { status != .failed }
    var summary: String { reason.isEmpty ? status.rawValue : "\(status.rawValue) (\(reason))" }
}

/// Everything that can put a message into a chat. The agent only talks to this, so tests
/// and dry runs use a recorder and a real send is impossible there.
protocol MessageSender: AnyObject {
    func sendFile(_ url: URL, to chat: ChatRef) -> SendResult
    func sendText(_ text: String, to chat: ChatRef) -> SendResult
}

/// Records what would be sent; never touches Messages.
final class RecordingSender: MessageSender {
    struct Sent: Equatable {
        let kind: String
        let chatKey: String
        let payload: String
    }

    private(set) var sent: [Sent] = []
    /// Called after each recorded send (tests use it to change things mid-reply).
    var afterSend: ((Sent) -> Void)?

    func sendFile(_ url: URL, to chat: ChatRef) -> SendResult {
        let item = Sent(kind: "file", chatKey: chat.key, payload: url.path)
        sent.append(item)
        afterSend?(item)
        return SendResult(status: .dryRun)
    }

    func sendText(_ text: String, to chat: ChatRef) -> SendResult {
        let item = Sent(kind: "text", chatKey: chat.key, payload: text)
        sent.append(item)
        afterSend?(item)
        return SendResult(status: .dryRun)
    }
}

/// Sends through Messages with Apple Events (in-process `NSAppleScript`, so macOS asks
/// "Threadback wants access to control Messages") and verifies every send in chat.db.
///
/// The chat id, the text and the file path are passed as handler PARAMETERS, never
/// interpolated into AppleScript source. Error -1728 ("can't get chat id") gets exactly one
/// retry with the other spelling (`any;+;` <-> `any;-;`); nothing else is retried.
final class AppleScriptSender: MessageSender {
    /// The handler the app calls. Compiled in CI with `osacompile` against the real Messages
    /// dictionary (the app prints it with `--tb-print-applescript`); never run there.
    static let sendScript = """
    on send_reply(chatGuid, messageText, filePath)
    \tif filePath is not "" then set attachmentFile to (POSIX file filePath) as alias
    \ttell application "Messages"
    \t\tset targetChat to chat id chatGuid
    \t\tif messageText is not "" then send messageText to targetChat
    \t\tif filePath is not "" then send attachmentFile to targetChat
    \tend tell
    end send_reply
    """

    /// Read-only: the number of chats Messages exposes. Sends nothing.
    static let countChatsScript = """
    tell application "Messages"
    \treturn count of chats
    end tell
    """

    let openDatabase: () throws -> SQLiteDB
    let decode: (String?, Data?) -> String
    var verifyTimeout: TimeInterval = 8
    var verifyInterval: TimeInterval = 0.4
    private var workingGuid: [String: String] = [:]
    private lazy var script: NSAppleScript? = {
        let script = NSAppleScript(source: AppleScriptSender.sendScript)
        var error: NSDictionary?
        script?.compileAndReturnError(&error)
        return error == nil ? script : nil
    }()

    init(openDatabase: @escaping () throws -> SQLiteDB, decode: @escaping (String?, Data?) -> String) {
        self.openDatabase = openDatabase
        self.decode = decode
    }

    /// Messages can only attach files from ~/Pictures, ~/Downloads or ~/Documents.
    static var stagingFolder: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Pictures/Threadback", isDirectory: true)
    }

    /// Each send stages its own copy under a new name, so two chats can never pick up each
    /// other's card. It is deleted once the send is confirmed; at most `keepStaged` are kept.
    func sendFile(_ url: URL, to chat: ChatRef) -> SendResult {
        let folder = AppleScriptSender.stagingFolder
        let staged = AppleScriptSender.stagedURL(in: folder, extension: url.pathExtension)
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try FileManager.default.copyItem(at: url, to: staged)
        } catch {
            return SendResult(status: .failed, reason: "could not stage the image in ~/Pictures: \(error.localizedDescription)")
        }
        let result = send(chat, text: "", filePath: staged.path, isFile: true)
        // Messages has its own copy once the message is sent.
        if result.status == .delivered || result.status == .sent { try? FileManager.default.removeItem(at: staged) }
        AppleScriptSender.prune(folder, keep: AppleScriptSender.keepStaged)
        return result
    }

    static let keepStaged = 30

    /// A new, unique file name for one send: threadback-card-<UUID>.png.
    static func stagedURL(in folder: URL, extension ext: String) -> URL {
        return folder.appendingPathComponent("threadback-card-\(UUID().uuidString).\(ext.isEmpty ? "png" : ext)")
    }

    /// Keeps the newest `keep` staged cards (our own threadback-card-* files only).
    static func prune(_ folder: URL, keep: Int) {
        let fm = FileManager.default
        guard let names = try? fm.contentsOfDirectory(atPath: folder.path) else { return }
        let ours = names.filter { $0.hasPrefix("threadback-card-") }.map { folder.appendingPathComponent($0) }
        let dated = ours.map { url -> (URL, Date) in
            let date = ((try? fm.attributesOfItem(atPath: url.path))?[.modificationDate] as? Date) ?? .distantPast
            return (url, date)
        }.sorted { $0.1 > $1.1 }
        for (url, _) in dated.dropFirst(max(0, keep)) { try? fm.removeItem(at: url) }
    }

    func sendText(_ text: String, to chat: ChatRef) -> SendResult {
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return SendResult(status: .failed, reason: "nothing to send (empty text)")
        }
        return send(chat, text: text, filePath: "", isFile: false)
    }

    /// Never in CI: a real send there is impossible by construction.
    static var sendingDisabled: Bool {
        let env = ProcessInfo.processInfo.environment
        return env["CI"] != nil || env["GITHUB_ACTIONS"] != nil || env["THREADBACK_NO_SEND"] != nil
    }

    private func send(_ chat: ChatRef, text: String, filePath: String, isFile: Bool) -> SendResult {
        if AppleScriptSender.sendingDisabled {
            return SendResult(status: .failed, reason: "sending is disabled in this environment")
        }
        var guid = workingGuid[chat.key] ?? chat.guid
        guard !guid.isEmpty, !guid.hasPrefix("-") else { return SendResult(status: .failed, reason: "this chat has no usable id") }
        // Never send what cannot be verified: take the "before" mark first.
        let before: Int
        do {
            before = try MessagesDB.maxMessageRowid(openDatabase())
        } catch {
            return SendResult(status: .failed, reason: "cannot read chat.db, so nothing was sent: \(error)")
        }
        var outcome = runHandler(guid: guid, text: text, filePath: filePath)
        if case .failure(let number, _) = outcome, number == -1728 {
            let other = AppleScriptSender.swapGuidForm(guid)
            if other != guid {
                guid = other
                outcome = runHandler(guid: guid, text: text, filePath: filePath)
            }
        }
        if case .failure(let number, let message) = outcome {
            var failed = SendResult(status: .failed, reason: AppleScriptSender.explain(number, message))
            failed.errorNumber = number
            failed.idForm = AppleScriptSender.idForm(guid)
            return failed
        }
        var verdict = verify(chat, before: before, text: text, fileName: isFile ? (filePath as NSString).lastPathComponent : nil)
        verdict.idForm = AppleScriptSender.idForm(guid)
        if [.delivered, .sent, .written].contains(verdict.status) { workingGuid[chat.key] = guid }
        return verdict
    }

    private enum Outcome { case success, failure(Int, String) }

    private func runHandler(guid: String, text: String, filePath: String) -> Outcome {
        guard let script else { return .failure(0, "the send script did not compile") }
        let params = NSAppleEventDescriptor.list()
        params.insert(NSAppleEventDescriptor(string: guid), at: 1)
        params.insert(NSAppleEventDescriptor(string: text), at: 2)
        params.insert(NSAppleEventDescriptor(string: filePath), at: 3)
        let event = AppleScriptSender.handlerEvent(named: "send_reply", parameters: params)
        var error: NSDictionary?
        _ = script.executeAppleEvent(event, error: &error)
        if let error {
            let number = (error[NSAppleScript.errorNumber] as? Int) ?? 0
            let message = (error[NSAppleScript.errorMessage] as? String) ?? "unknown error"
            return .failure(number, message)
        }
        return .success
    }

    /// An event that calls a handler of a compiled script (kASAppleScriptSuite/kASSubroutineEvent).
    static func handlerEvent(named name: String, parameters: NSAppleEventDescriptor) -> NSAppleEventDescriptor {
        let ascr: AEEventClass = 0x6173_6372 // 'ascr'
        let psbr: AEEventID = 0x7073_6272 // 'psbr'
        let snam: AEKeyword = 0x736E_616D // 'snam'
        let directObject: AEKeyword = 0x2D2D_2D2D // '----'
        let event = NSAppleEventDescriptor(
            eventClass: ascr, eventID: psbr, targetDescriptor: NSAppleEventDescriptor.currentProcess(),
            returnID: AEReturnID(-1), transactionID: AETransactionID(0)
        )
        event.setDescriptor(NSAppleEventDescriptor(string: name), forKeyword: snam)
        event.setDescriptor(parameters, forKeyword: directObject)
        return event
    }

    /// "any;+;", "iMessage;-;", "SMS;+;" ... or "other": the shape of a chat id, never the id.
    static func idForm(_ guid: String) -> String {
        let parts = guid.split(separator: ";", maxSplits: 2, omittingEmptySubsequences: false)
        guard parts.count == 3, ["any", "iMessage", "SMS", "RCS"].contains(String(parts[0])),
              ["+", "-"].contains(String(parts[1])) else { return "other" }
        return "\(parts[0]);\(parts[1]);"
    }

    static func swapGuidForm(_ guid: String) -> String {
        if let r = guid.range(of: ";+;") { return guid.replacingCharacters(in: r, with: ";-;") }
        if let r = guid.range(of: ";-;") { return guid.replacingCharacters(in: r, with: ";+;") }
        return guid
    }

    static func explain(_ number: Int, _ message: String) -> String {
        switch number {
        case -1743: return "not allowed to control Messages (Automation permission is off)"
        case -1728: return "Messages could not find this chat (-1728, tried both id spellings)"
        case -600, -609, -10810: return "Messages is not running or could not be reached (\(number))"
        case -1712: return "Messages took too long to answer (-1712)"
        default: return "AppleScript error \(number): \(message)"
        }
    }

    /// Polls chat.db for OUR message: an outgoing row in this chat created after the send,
    /// with exactly this text, or (for the card) an attachment with the unique staged file
    /// name. Anything else the owner sends meanwhile, from this Mac or a phone, never counts.
    private func verify(_ chat: ChatRef, before: Int, text: String, fileName: String?) -> SendResult {
        let deadline = Date().addingTimeInterval(verifyTimeout)
        var last = AppleScriptSender.Judgement.notFound
        while true {
            if let db = try? openDatabase(),
               let ids = try? MessagesDB.chatRowids(db, guids: [chat.guid, AppleScriptSender.swapGuidForm(chat.guid)], identifier: chat.identifier),
               let rows = try? MessagesDB.outgoingRows(db, after: before) {
                last = AppleScriptSender.judge(rows, chatIDs: ids, text: text, fileName: fileName, decode: decode)
                switch last {
                case .found(let row) where row.error != 0 || row.isSent || row.isDelivered:
                    return AppleScriptSender.result(for: row)
                default: break
                }
            }
            if Date() >= deadline { break }
            Thread.sleep(forTimeInterval: verifyInterval)
        }
        switch last {
        case .found(let row):
            return AppleScriptSender.result(for: row)
        case .orphan:
            return SendResult(status: .unverified, reason: "our message was written but is attached to no chat (the known macOS 26 group-send problem); treat it as NOT delivered", orphan: true)
        case .notFound:
            return SendResult(status: .unverified, reason: "Messages said yes but our message did not appear in this chat within \(Int(verifyTimeout)) s")
        }
    }

    enum Judgement: Equatable {
        case notFound
        case orphan
        case found(MessagesDB.OutgoingRow)

        static func == (a: Judgement, b: Judgement) -> Bool {
            switch (a, b) {
            case (.notFound, .notFound), (.orphan, .orphan): return true
            case (.found(let x), .found(let y)): return x.rowid == y.rowid
            default: return false
            }
        }
    }

    /// Our message among the new outgoing rows: in this chat (or in no chat at all, the
    /// orphan case), and exactly ours.
    static func judge(_ rows: [MessagesDB.OutgoingRow], chatIDs: Set<Int>, text: String, fileName: String?,
                      decode: (String?, Data?) -> String) -> Judgement {
        var orphan = false
        for row in rows where isOurs(row, text: text, fileName: fileName, decode: decode) {
            if row.chatIDs.isEmpty { orphan = true; continue }
            if row.chatIDs.contains(where: chatIDs.contains) { return .found(row) }
        }
        return orphan ? .orphan : .notFound
    }

    static func isOurs(_ row: MessagesDB.OutgoingRow, text: String, fileName: String?, decode: (String?, Data?) -> String) -> Bool {
        if let fileName { return row.attachmentNames.contains(fileName) }
        if row.hasAttachment { return false }
        let wanted = squash(text)
        return !wanted.isEmpty && squash(decode(row.text, row.attributedBody)) == wanted
    }

    static func result(for row: MessagesDB.OutgoingRow) -> SendResult {
        if row.error != 0 {
            return SendResult(status: .failed, reason: "Messages recorded error \(row.error); not sent", rowid: row.rowid)
        }
        if row.isDelivered { return SendResult(status: .delivered, rowid: row.rowid) }
        if row.isSent { return SendResult(status: .sent, reason: "sent; not yet marked delivered", rowid: row.rowid) }
        return SendResult(status: .written, reason: "written in the chat; Messages has not marked it sent yet", rowid: row.rowid)
    }

    static func squash(_ text: String) -> String {
        return text.replacingOccurrences(of: "\u{FFFC}", with: " ")
            .split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }
}
