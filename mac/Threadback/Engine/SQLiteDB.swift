import Foundation
import SQLite3

/// A value read from SQLite, with the storage class it had.
enum SQLValue {
    case null
    case integer(Int64)
    case real(Double)
    case text(String)
    case blob(Data)

    var int: Int? {
        switch self {
        case .integer(let v): return Int(v)
        case .real(let v): return Int(v)
        case .text(let s): return Int(s)
        default: return nil
        }
    }

    var string: String? {
        switch self {
        case .text(let s): return s
        case .blob(let d): return String(decoding: d, as: UTF8.self)
        case .integer(let v): return String(v)
        default: return nil
        }
    }

    var data: Data? {
        if case .blob(let d) = self { return d }
        return nil
    }
}

struct SQLiteError: Error, CustomStringConvertible {
    let code: Int32
    let extendedCode: Int32
    let message: String
    var description: String { "\(message) (SQLite \(code)/\(extendedCode))" }
}

/// The system SQLite (libsqlite3), read-only.
///
/// `mode=ro`, never `immutable=1`: an immutable connection ignores the write-ahead log and
/// silently misses the newest messages (same rule as wrapped/mac/chatdb.py).
final class SQLiteDB {
    private(set) var handle: OpaquePointer?
    let path: String

    init(path: String, readOnly: Bool = true) throws {
        self.path = path
        var url = URLComponents()
        url.scheme = "file"
        url.path = path
        if readOnly { url.queryItems = [URLQueryItem(name: "mode", value: "ro")] }
        let uri = url.string ?? "file:\(path)"
        let flags = (readOnly ? SQLITE_OPEN_READONLY : (SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE)) | SQLITE_OPEN_URI
        var db: OpaquePointer?
        let rc = sqlite3_open_v2(uri, &db, flags, nil)
        if rc != SQLITE_OK {
            let error = SQLiteDB.error(db, rc)
            sqlite3_close_v2(db)
            throw error
        }
        sqlite3_extended_result_codes(db, 1)
        sqlite3_busy_timeout(db, 5000)
        handle = db
        // Touch the schema now, so a permission problem shows up here and not mid-query.
        _ = try query("SELECT 1 FROM sqlite_master LIMIT 1")
    }

    deinit {
        if let handle { sqlite3_close_v2(handle) }
    }

    private static func error(_ db: OpaquePointer?, _ rc: Int32) -> SQLiteError {
        let message = db.flatMap { sqlite3_errmsg($0) }.map { String(cString: $0) } ?? String(cString: sqlite3_errstr(rc))
        let extended = db.map { sqlite3_extended_errcode($0) } ?? rc
        return SQLiteError(code: rc & 0xFF, extendedCode: extended, message: message)
    }

    private static let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    /// Runs a statement and returns its column names and rows.
    func query(_ sql: String, _ params: [Any] = []) throws -> (columns: [String], rows: [[SQLValue]]) {
        var stmt: OpaquePointer?
        let rc = sqlite3_prepare_v2(handle, sql, -1, &stmt, nil)
        guard rc == SQLITE_OK, let stmt else { throw SQLiteDB.error(handle, rc) }
        defer { sqlite3_finalize(stmt) }
        for (i, param) in params.enumerated() {
            let index = Int32(i + 1)
            switch param {
            case is NSNull:
                sqlite3_bind_null(stmt, index)
            case let v as Int64:
                sqlite3_bind_int64(stmt, index, v)
            case let v as Int:
                sqlite3_bind_int64(stmt, index, Int64(v))
            case let n as NSNumber where CFGetTypeID(n) == CFBooleanGetTypeID():
                sqlite3_bind_int64(stmt, index, n.boolValue ? 1 : 0)
            case let n as NSNumber:
                let d = n.doubleValue
                if d == d.rounded(), abs(d) < 9.0e15 {
                    sqlite3_bind_int64(stmt, index, Int64(d))
                } else {
                    sqlite3_bind_double(stmt, index, d)
                }
            case let v as Double:
                sqlite3_bind_double(stmt, index, v)
            case let v as Data:
                _ = v.withUnsafeBytes { buf in
                    sqlite3_bind_blob(stmt, index, buf.baseAddress, Int32(buf.count), SQLiteDB.transient)
                }
            default:
                sqlite3_bind_text(stmt, index, "\(param)", -1, SQLiteDB.transient)
            }
        }
        let count = sqlite3_column_count(stmt)
        let columns = (0..<count).map { String(cString: sqlite3_column_name(stmt, $0)) }
        var rows: [[SQLValue]] = []
        while true {
            let step = sqlite3_step(stmt)
            if step == SQLITE_DONE { break }
            guard step == SQLITE_ROW else { throw SQLiteDB.error(handle, step) }
            var row: [SQLValue] = []
            row.reserveCapacity(Int(count))
            for c in 0..<count {
                switch sqlite3_column_type(stmt, c) {
                case SQLITE_INTEGER:
                    row.append(.integer(sqlite3_column_int64(stmt, c)))
                case SQLITE_FLOAT:
                    row.append(.real(sqlite3_column_double(stmt, c)))
                case SQLITE_TEXT:
                    let n = Int(sqlite3_column_bytes(stmt, c))
                    if let p = sqlite3_column_text(stmt, c) {
                        row.append(.text(String(decoding: UnsafeBufferPointer(start: p, count: n), as: UTF8.self)))
                    } else {
                        row.append(.text(""))
                    }
                case SQLITE_BLOB:
                    let n = Int(sqlite3_column_bytes(stmt, c))
                    if n > 0, let p = sqlite3_column_blob(stmt, c) {
                        row.append(.blob(Data(bytes: p, count: n)))
                    } else {
                        row.append(.blob(Data()))
                    }
                default:
                    row.append(.null)
                }
            }
            rows.append(row)
        }
        return (columns, rows)
    }

    /// For tests and the fixture tools only: run a statement that changes the database.
    func execute(_ sql: String, _ params: [Any] = []) throws -> Int64 {
        _ = try query(sql, params)
        return sqlite3_last_insert_rowid(handle)
    }
}
