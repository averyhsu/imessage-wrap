import Foundation
import JavaScriptCore

/// One group chat as the engine lists it (web/make/db.js `listGroupChats`).
struct ChatInfo: Codable, Equatable, Identifiable {
    let id: Int
    let chatIDs: [Int]
    let chatIdentifier: String
    let guid: String
    let name: String
    let members: Int
    let messages: Int
    /// When the chat last had a message (Unix seconds), for "most recently active first".
    var lastUnix: Double?

    enum CodingKeys: String, CodingKey {
        case id, guid, name, members, messages
        case lastUnix = "last_unix"
        case chatIDs = "chat_ids"
        case chatIdentifier = "chat_identifier"
    }

    /// Stable key for allowlists and cooldowns, as in wrapped/mac/engine.py `ChatRef.key`.
    var key: String { chatIdentifier.isEmpty ? guid : chatIdentifier }
}

struct EngineError: Error, CustomStringConvertible {
    let code: String
    let message: String
    var description: String { "\(message) [\(code)]" }
}

/// The shared JavaScript stats engine (web/make/engine.js + db.js, unchanged) running in
/// JavaScriptCore, with SQLite reads served by Swift through `__tbSQL`.
///
/// Not thread-safe: use one instance from one thread (the app uses the main thread).
final class ThreadbackEngine {
    let context: JSContext
    private var databases: [Int: SQLiteDB] = [:]
    private var nextToken = 1
    private var lastException: String?

    /// The bundle holding the .js resources: the app bundle, or the unit-test bundle.
    static var resourceBundle: Bundle { Bundle(for: ThreadbackEngine.self) }

    static let scripts = ["fflate.min", "engine", "db", "bridge", "recap-text"]

    init(bundle: Bundle = ThreadbackEngine.resourceBundle) throws {
        let context: JSContext = JSContext()
        self.context = context
        context.name = "Threadback engine"
        context.exceptionHandler = { [weak self] _, exception in
            self?.lastException = exception?.toString()
        }
        let sql: @convention(block) (Int, String, JSValue) -> JSValue = { [weak self] token, statement, params in
            let ctx: JSContext = JSContext.current()
            guard let self, let db = self.databases[token] else {
                ctx.exception = JSValue(newErrorFromMessage: "no database is open under token \(token)", in: ctx)
                return JSValue(undefinedIn: ctx)
            }
            do {
                let args = params.isUndefined || params.isNull ? [] : (params.toArray() ?? [])
                let result = try db.query(statement, args)
                return ThreadbackEngine.toJS(result, in: ctx)
            } catch {
                ctx.exception = JSValue(newErrorFromMessage: "\(error)", in: ctx)
                return JSValue(undefinedIn: ctx)
            }
        }
        context.setObject(sql, forKeyedSubscript: "__tbSQL" as NSString)
        for name in ThreadbackEngine.scripts {
            guard let url = bundle.url(forResource: name, withExtension: "js"),
                  let source = try? String(contentsOf: url, encoding: .utf8) else {
                throw EngineError(code: "resource", message: "\(name).js is missing from the app bundle")
            }
            lastException = nil
            context.evaluateScript(source, withSourceURL: url)
            if let problem = lastException {
                throw EngineError(code: "load", message: "\(name).js failed to load: \(problem)")
            }
        }
        if context.objectForKeyedSubscript("ThreadbackBridge").isUndefined {
            throw EngineError(code: "load", message: "the bridge did not load")
        }
    }

    // MARK: Databases

    /// Opens a database for the engine and returns its token.
    func open(_ db: SQLiteDB) -> Int {
        let token = nextToken
        nextToken += 1
        databases[token] = db
        return token
    }

    func close(_ token: Int) {
        databases[token] = nil
    }

    // MARK: Calls into JavaScript

    private func call(_ object: String, _ method: String, _ args: [Any]) throws -> String {
        lastException = nil
        let target = context.objectForKeyedSubscript(object)
        guard let result = target?.invokeMethod(method, withArguments: args) else {
            throw EngineError(code: "js", message: "\(object).\(method) returned nothing")
        }
        if result.isUndefined, let problem = lastException {
            throw EngineError(code: "js", message: "\(object).\(method): \(problem)")
        }
        return result.toString() ?? ""
    }

    /// Throws when the bridge answered `{"error": {...}}`.
    private func checked(_ json: String) throws -> String {
        if json.hasPrefix("{\"error\":"),
           let data = json.data(using: .utf8),
           let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let error = object["error"] as? [String: Any] {
            throw EngineError(code: error["code"] as? String ?? "error", message: error["message"] as? String ?? json)
        }
        return json
    }

    private static func json(_ object: Any) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.fragmentsAllowed]) else { return "null" }
        return String(decoding: data, as: UTF8.self)
    }

    /// [[identifier, name], ...] from one address-book database file.
    func loadContacts(token: Int) throws -> [[String]] {
        let json = try checked(call("ThreadbackBridge", "loadContacts", [token]))
        return (try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [[String]]) ?? []
    }

    /// The address books under an AddressBook folder, in the order the Python engine reads
    /// them (wrapped/db.py `_address_books_under`), or the file itself.
    static func addressBookFiles(under path: String) -> [String] {
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: path, isDirectory: &isDir) else { return [] }
        if !isDir.boolValue { return [path] }
        var found: [String] = []
        let root = (path as NSString).appendingPathComponent("AddressBook-v22.abcddb")
        if FileManager.default.fileExists(atPath: root) { found.append(root) }
        let sources = (path as NSString).appendingPathComponent("Sources")
        let names = ((try? FileManager.default.contentsOfDirectory(atPath: sources)) ?? []).sorted()
        for name in names {
            let file = ((sources as NSString).appendingPathComponent(name) as NSString).appendingPathComponent("AddressBook-v22.abcddb")
            if FileManager.default.fileExists(atPath: file) { found.append(file) }
        }
        return found
    }

    /// Contacts from address-book files (fixtures and tests; the app uses `CNContactStore`).
    func contacts(fromAddressBook path: String) -> [[String]] {
        var pairs: [[String]] = []
        for file in ThreadbackEngine.addressBookFiles(under: path) {
            guard let db = try? SQLiteDB(path: file) else { continue }
            let token = open(db)
            defer { close(token) }
            if let more = try? loadContacts(token: token) { pairs += more }
        }
        return pairs
    }

    /// "First Last", else the nickname, else the organisation, cleaned and masked exactly as
    /// db.js does for address-book rows (used for contacts read through CNContactStore).
    func contactLabel(first: String, last: String, nickname: String, organization: String) -> String {
        let value = context.objectForKeyedSubscript("ThreadbackBridge")?
            .invokeMethod("contactLabel", withArguments: [first, last, nickname, organization])
        return value?.toString() ?? ""
    }

    func listChats(token: Int, me: String, contacts: [[String]]) throws -> [ChatInfo] {
        let opts = ThreadbackEngine.json(["me": me, "contacts": contacts])
        let json = try checked(call("ThreadbackBridge", "listChats", [token, NSNull(), opts]))
        struct Listing: Decodable { let chats: [ChatInfo] }
        return try JSONDecoder().decode(Listing.self, from: Data(json.utf8)).chats
    }

    /// Period options as `wrapped stats` takes them: nil = default, "all", or "2025".
    static func periodOptions(_ period: String?) -> [String: Any] {
        guard let period else { return [:] }
        if period == "all" { return ["all_time": true] }
        if let year = Int(period) { return ["year": year] }
        return [:]
    }

    /// Canonical stats JSON for one chat (what `python3 -m wrapped stats --compact` prints).
    /// `chat` is a ROWID, guid, identifier or (part of) a name.
    func statsJSON(token: Int, chat: String, me: String, tz: String?, period: String?,
                   contacts: [[String]], shortNames: Bool) throws -> String {
        var opts = ThreadbackEngine.periodOptions(period)
        opts["me"] = me
        opts["contacts"] = contacts
        if let tz { opts["tz"] = tz }
        return try checked(call("ThreadbackBridge", "stats", [token, NSNull(), chat, ThreadbackEngine.json(opts), shortNames]))
    }

    /// Canonical stats JSON for the group chat that has this chat.ROWID among its rows. Never
    /// a name match: if the chat is gone, this throws (no_chat).
    func statsJSON(token: Int, chatID: Int, me: String, tz: String?, period: String?,
                   contacts: [[String]], shortNames: Bool) throws -> String {
        var opts = ThreadbackEngine.periodOptions(period)
        opts["me"] = me
        opts["contacts"] = contacts
        if let tz { opts["tz"] = tz }
        return try checked(call("ThreadbackBridge", "statsById", [token, NSNull(), chatID, ThreadbackEngine.json(opts), shortNames]))
    }

    func shortNames(statsJSON: String, me: String) throws -> String {
        return try checked(call("ThreadbackBridge", "shortNames", [statsJSON, me]))
    }

    /// The share link, or throws (link_too_long, ...).
    func buildLink(statsJSON: String, quotes: Bool) throws -> String {
        let json = try checked(call("ThreadbackBridge", "buildLink", [statsJSON, quotes]))
        let object = try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any]
        guard let url = object?["url"] as? String else { throw EngineError(code: "link", message: "no url") }
        return url
    }

    func statsFromURL(_ url: String) throws -> String {
        return try checked(call("ThreadbackBridge", "statsFromUrl", [url]))
    }

    /// `message.text`, else the string inside `attributedBody`, cleaned (wrapped api.decode_text).
    func decodeText(text: String?, attributedBody: Data?) -> String {
        var args: [Any] = [text.map { $0 as Any } ?? NSNull()]
        if let body = attributedBody, !body.isEmpty {
            args.append(ThreadbackEngine.uint8Array(body, in: context))
        } else {
            args.append(NSNull())
        }
        let value = context.objectForKeyedSubscript("ThreadbackBridge")?.invokeMethod("decodeText", withArguments: args)
        return value?.toString() ?? ""
    }

    /// The text recap (wrapped/mac/text.py): lines, or the one-line "nothing to recap".
    enum RecapText: Equatable {
        case lines([String])
        case empty(String)

        var message: String {
            switch self {
            case .lines(let lines): return lines.joined(separator: "\n")
            case .empty(let line): return line
            }
        }
    }

    func recapText(statsJSON: String, withLink: Bool) throws -> RecapText {
        let json = try call("ThreadbackText", "recapJSON", [statsJSON, withLink])
        let object = try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any]
        if let lines = object?["lines"] as? [String] { return .lines(lines) }
        if let empty = object?["empty"] as? String { return .empty(empty) }
        throw EngineError(code: "text", message: object?["error"] as? String ?? json)
    }

    /// A command typed into a chat (wrapped/mac/triggers.py), or nil.
    func parseTrigger(_ text: String, currentYear: Int) -> Trigger? {
        guard let json = try? call("ThreadbackText", "triggerJSON", [text, currentYear]),
              let object = try? JSONSerialization.jsonObject(with: Data(json.utf8), options: [.fragmentsAllowed]) as? [String: Any],
              let command = object["command"] as? String else { return nil }
        return Trigger(command: command, period: object["period"] as? String)
    }

    func safeChatName(_ name: String) -> String {
        let value = context.objectForKeyedSubscript("ThreadbackText")?.invokeMethod("safeChatName", withArguments: [name])
        return value?.toString() ?? ""
    }

    // MARK: Swift -> JavaScript values

    private static func toJS(_ result: (columns: [String], rows: [[SQLValue]]), in ctx: JSContext) -> JSValue {
        var blobs: [(Int, Int, Data)] = []
        var rows: [[Any]] = []
        rows.reserveCapacity(result.rows.count)
        for (r, row) in result.rows.enumerated() {
            var out: [Any] = []
            out.reserveCapacity(row.count)
            for (c, value) in row.enumerated() {
                switch value {
                case .null: out.append(NSNull())
                case .integer(let v): out.append(NSNumber(value: Double(v)))
                case .real(let v): out.append(NSNumber(value: v))
                case .text(let s): out.append(s)
                case .blob(let d):
                    out.append(NSNull())
                    blobs.append((r, c, d))
                }
            }
            rows.append(out)
        }
        let object = JSValue(newObjectIn: ctx)!
        object.setValue(result.columns, forProperty: "columns")
        let rowsValue = JSValue(object: rows, in: ctx)!
        for (r, c, d) in blobs {
            rowsValue.atIndex(r).setValue(uint8Array(d, in: ctx), at: c)
        }
        object.setValue(rowsValue, forProperty: "rows")
        return object
    }

    /// A real `Uint8Array` (db.js tests `instanceof Uint8Array`), copied from `data`.
    static func uint8Array(_ data: Data, in ctx: JSContext) -> JSValue {
        let count = data.count
        let bytes = UnsafeMutableRawPointer.allocate(byteCount: max(count, 1), alignment: 8)
        if count > 0 {
            data.copyBytes(to: bytes.assumingMemoryBound(to: UInt8.self), count: count)
        }
        var exception: JSValueRef?
        let object = JSObjectMakeTypedArrayWithBytesNoCopy(
            ctx.jsGlobalContextRef, kJSTypedArrayTypeUint8Array, bytes, count,
            { pointer, _ in pointer?.deallocate() }, nil, &exception
        )
        return JSValue(jsValueRef: object, in: ctx)
    }
}

/// A whole-message command: `/wrapped`, `/recap`, optionally a year or `all`.
struct Trigger: Equatable {
    let command: String
    let period: String?
}
