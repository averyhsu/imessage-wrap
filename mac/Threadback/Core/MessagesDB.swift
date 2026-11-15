import Foundation

/// What the agent and the sender need from the Messages database (wrapped/mac/chatdb.py).
/// The engine owns everything about counting; this only sees new rows, finds the chat a
/// row belongs to and checks that a send produced an outgoing row in the right chat.
enum MessagesDB {
    static let appleEpoch: Double = 978_307_200
    static let groupStyle = 43

    struct NewRow {
        let rowid: Int
        let unixTime: Double
        let isFromMe: Bool
        let text: String?
        let attributedBody: Data?
        let associatedType: Int
        let itemType: Int
    }

    struct ChatRow {
        let rowid: Int
        let guid: String
        let identifier: String
        let displayName: String
        let style: Int
        var isGroup: Bool { style == MessagesDB.groupStyle }
        var key: String { identifier.isEmpty ? guid : identifier }
    }

    struct OutgoingRow {
        let rowid: Int
        var chatIDs: [Int]
        let error: Int
        let hasAttachment: Bool
        let text: String?
        let attributedBody: Data?
        /// message.is_sent and message.is_delivered, as Messages sets them later.
        var isSent = false
        var isDelivered = false
        /// The file names of its attachments (attachment.transfer_name and filename's last part).
        var attachmentNames: [String] = []
    }

    /// `message.date` to Unix seconds (nanoseconds since 2001 when large, else seconds).
    static func appleTimeToUnix(_ value: SQLValue) -> Double {
        var v: Double
        switch value {
        case .integer(let i): v = Double(i)
        case .real(let d): v = d
        case .text(let s): v = Double(s) ?? 0
        default: v = 0
        }
        if abs(v) > 1e11 { v /= 1e9 }
        return v + appleEpoch
    }

    static func messageColumns(_ db: SQLiteDB) throws -> Set<String> {
        let result = try db.query("PRAGMA table_info(message)")
        return Set(result.rows.compactMap { $0.count > 1 ? $0[1].string : nil })
    }

    static func maxMessageRowid(_ db: SQLiteDB) throws -> Int {
        return try db.query("SELECT MAX(ROWID) FROM message").rows.first?.first?.int ?? 0
    }

    /// Rows with ROWID > cursor, in order. The text is not filtered in SQL: a typed command
    /// often lives only in attributedBody.
    static func newRows(_ db: SQLiteDB, after cursor: Int, limit: Int = 500) throws -> [NewRow] {
        let cols = try messageColumns(db)
        let body = cols.contains("attributedBody") ? "attributedBody" : "NULL"
        let assoc = cols.contains("associated_message_type") ? "associated_message_type" : "0"
        let item = cols.contains("item_type") ? "item_type" : "0"
        let sql = "SELECT ROWID, date, is_from_me, text, \(body), \(assoc), \(item) FROM message WHERE ROWID > ? ORDER BY ROWID LIMIT ?"
        return try db.query(sql, [cursor, limit]).rows.map { r in
            var text: String?
            if case .text(let s) = r[3] { text = s }
            return NewRow(
                rowid: r[0].int ?? 0,
                unixTime: appleTimeToUnix(r[1]),
                isFromMe: (r[2].int ?? 0) != 0,
                text: text,
                attributedBody: r[4].data,
                associatedType: r[5].int ?? 0,
                itemType: r[6].int ?? 0
            )
        }
    }

    static func chatsForMessage(_ db: SQLiteDB, rowid: Int) throws -> [ChatRow] {
        let sql = "SELECT c.ROWID, c.guid, c.chat_identifier, c.display_name, c.style FROM chat_message_join j "
            + "JOIN chat c ON c.ROWID = j.chat_id WHERE j.message_id = ? ORDER BY c.ROWID"
        return try db.query(sql, [rowid]).rows.map(chatRow)
    }

    private static func chatRow(_ r: [SQLValue]) -> ChatRow {
        return ChatRow(rowid: r[0].int ?? 0, guid: r[1].string ?? "", identifier: r[2].string ?? "",
                       displayName: r[3].string ?? "", style: r[4].int ?? 0)
    }

    /// Every chat.ROWID that is the same logical chat: either GUID spelling, plus rows that
    /// share the non-empty chat_identifier.
    static func chatRowids(_ db: SQLiteDB, guids: [String], identifier: String) throws -> Set<Int> {
        var ids = Set<Int>()
        for guid in guids where !guid.isEmpty {
            for r in try db.query("SELECT ROWID FROM chat WHERE guid = ?", [guid]).rows { if let v = r[0].int { ids.insert(v) } }
        }
        if !identifier.isEmpty {
            for r in try db.query("SELECT ROWID FROM chat WHERE chat_identifier = ?", [identifier]).rows { if let v = r[0].int { ids.insert(v) } }
        }
        return ids
    }

    static func outgoingRows(_ db: SQLiteDB, after rowid: Int) throws -> [OutgoingRow] {
        let cols = try messageColumns(db)
        let err = cols.contains("error") ? "m.error" : "0"
        let att = cols.contains("cache_has_attachments") ? "m.cache_has_attachments" : "0"
        let body = cols.contains("attributedBody") ? "m.attributedBody" : "NULL"
        let sent = cols.contains("is_sent") ? "m.is_sent" : "0"
        let delivered = cols.contains("is_delivered") ? "m.is_delivered" : "0"
        let sql = "SELECT m.ROWID, \(err), \(att), m.text, \(body), j.chat_id, \(sent), \(delivered) FROM message m "
            + "LEFT JOIN chat_message_join j ON j.message_id = m.ROWID WHERE m.ROWID > ? AND m.is_from_me = 1 ORDER BY m.ROWID"
        var order: [Int] = []
        var byID: [Int: OutgoingRow] = [:]
        for r in try db.query(sql, [rowid]).rows {
            let id = r[0].int ?? 0
            if byID[id] == nil {
                var text: String?
                if case .text(let s) = r[3] { text = s }
                byID[id] = OutgoingRow(rowid: id, chatIDs: [], error: r[1].int ?? 0, hasAttachment: (r[2].int ?? 0) != 0,
                                       text: text, attributedBody: r[4].data,
                                       isSent: (r[6].int ?? 0) != 0, isDelivered: (r[7].int ?? 0) != 0)
                order.append(id)
            }
            if let chat = r[5].int, byID[id]?.chatIDs.contains(chat) == false { byID[id]?.chatIDs.append(chat) }
        }
        // Attachment names (the card is matched by its unique staged file name).
        let names = "SELECT j.message_id, a.transfer_name, a.filename FROM message_attachment_join j "
            + "JOIN attachment a ON a.ROWID = j.attachment_id WHERE j.message_id > ?"
        if let rows = try? db.query(names, [rowid]).rows {
            for r in rows {
                guard let id = r[0].int, byID[id] != nil else { continue }
                for value in [r[1].string, r[2].string] {
                    if let value, !value.isEmpty { byID[id]?.attachmentNames.append((value as NSString).lastPathComponent) }
                }
            }
        }
        return order.compactMap { byID[$0] }
    }
}
