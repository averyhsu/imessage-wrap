import Darwin
import Foundation

/// The feasibility experiment for reading Messages without Full Disk Access: tries every
/// way of reading `<folder>/chat.db` and its `-wal`, and records the exact result of each
/// (errno text, SQLite error, counts). Read-only: it never writes into the folder.
enum AccessProbe {
    static func run(folder: URL, label: String) -> [String: String] {
        var report: [String: String] = [:]
        report["label"] = label
        report["time"] = ISO8601DateFormatter().string(from: Date())
        report["folder"] = folder.path
        report["process"] = "\(ProcessInfo.processInfo.processName) pid \(getpid()) uid \(getuid())"
        report["bundle"] = Bundle.main.bundlePath
        let fm = FileManager.default
        var isDir: ObjCBool = false
        report["folder.exists"] = String(fm.fileExists(atPath: folder.path, isDirectory: &isDir)) + (isDir.boolValue ? " (folder)" : "")
        do {
            let names = try fm.contentsOfDirectory(atPath: folder.path)
            report["folder.list"] = "ok: \(names.count) entries: " + names.sorted().prefix(12).joined(separator: ", ")
        } catch {
            report["folder.list"] = "error: \(describe(error))"
        }
        report["folder.xattrs"] = xattrNames(folder.path)
        for name in ["chat.db", "chat.db-wal", "chat.db-shm"] {
            let path = folder.appendingPathComponent(name).path
            report["\(name).posix"] = posixRead(path)
        }
        let db = folder.appendingPathComponent("chat.db").path
        report["chat.db.xattrs"] = xattrNames(db)
        report["sqlite.inplace"] = sqliteCount(db)
        // The fallback when SQLite cannot use the folder in place (for example because it
        // cannot open the -shm): copy the three files raw and read the copy.
        let copy = fm.temporaryDirectory.appendingPathComponent("threadback-probe-\(UUID().uuidString)", isDirectory: true)
        do {
            try fm.createDirectory(at: copy, withIntermediateDirectories: true)
            var copied: [String] = []
            for name in ["chat.db", "chat.db-wal", "chat.db-shm"] {
                let source = folder.appendingPathComponent(name)
                if fm.fileExists(atPath: source.path) {
                    try fm.copyItem(at: source, to: copy.appendingPathComponent(name))
                    copied.append(name)
                }
            }
            report["copy"] = "ok: " + copied.joined(separator: ", ")
            report["sqlite.copy"] = sqliteCount(copy.appendingPathComponent("chat.db").path)
        } catch {
            report["copy"] = "error: \(describe(error))"
        }
        try? fm.removeItem(at: copy)
        return report
    }

    static func describe(_ error: Error) -> String {
        let ns = error as NSError
        var text = "\(ns.domain) \(ns.code): \(ns.localizedDescription)"
        if let underlying = ns.userInfo[NSUnderlyingErrorKey] as? NSError {
            text += " [underlying \(underlying.domain) \(underlying.code): \(underlying.localizedDescription)]"
        }
        return text
    }

    static func posixRead(_ path: String) -> String {
        let fd = open(path, O_RDONLY)
        if fd < 0 {
            let code = errno
            return "open failed: errno \(code) (\(String(cString: strerror(code))))"
        }
        defer { close(fd) }
        var buffer = [UInt8](repeating: 0, count: 16)
        let n = read(fd, &buffer, 16)
        if n < 0 {
            let code = errno
            return "opened, read failed: errno \(code) (\(String(cString: strerror(code))))"
        }
        var st = stat()
        fstat(fd, &st)
        let head = String(decoding: buffer.prefix(max(0, n)).map { $0 >= 32 && $0 < 127 ? $0 : 46 }, as: UTF8.self)
        return "ok: read \(n) bytes of \(st.st_size) (\"\(head)\")"
    }

    static func sqliteCount(_ path: String) -> String {
        do {
            let db = try SQLiteDB(path: path)
            let messages = try db.query("SELECT COUNT(*), MAX(ROWID) FROM message").rows.first
            let chats = try db.query("SELECT COUNT(*) FROM chat").rows.first?.first?.int ?? -1
            let mode = try db.query("PRAGMA journal_mode").rows.first?.first?.string ?? "?"
            return "ok: \(messages?[0].int ?? -1) messages (max ROWID \(messages?[1].int ?? -1)), \(chats) chats, journal_mode \(mode)"
        } catch {
            return "error: \(error)"
        }
    }

    static func xattrNames(_ path: String) -> String {
        let size = listxattr(path, nil, 0, 0)
        if size < 0 {
            let code = errno
            return "listxattr failed: errno \(code) (\(String(cString: strerror(code))))"
        }
        if size == 0 { return "none" }
        var buffer = [CChar](repeating: 0, count: size)
        let got = listxattr(path, &buffer, size, 0)
        if got <= 0 { return "none" }
        let names = buffer.prefix(got).split(separator: 0).map { String(decoding: $0.map { UInt8(bitPattern: $0) }, as: UTF8.self) }
        return names.joined(separator: ", ")
    }

    /// Writes the report as pretty JSON (sorted keys) and returns the file.
    @discardableResult
    static func write(_ report: [String: String], to folder: URL, name: String) -> URL? {
        let url = folder.appendingPathComponent(name)
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let data = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
            try data.write(to: url)
            return url
        } catch {
            return nil
        }
    }
}
