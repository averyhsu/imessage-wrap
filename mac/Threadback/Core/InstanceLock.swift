import Foundation

/// One running copy of Threadback per user: an exclusive flock on a file in Application
/// Support. Two copies (for example one in Downloads and one in Applications) would otherwise
/// both answer the same /wrapped. The lock goes away with the process, so a crash never
/// leaves it stuck.
final class InstanceLock {
    let path: URL
    private var fd: Int32 = -1

    init(path: URL = InstanceLock.defaultPath) {
        self.path = path
    }

    static var defaultPath: URL {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return support.appendingPathComponent("Threadback/instance.lock")
    }

    var isHeld: Bool { fd >= 0 }

    /// Takes the lock, trying again for up to `retryFor` seconds (a copy that is handing over,
    /// as Move to Applications does, lets go a moment after it opened the new one).
    @discardableResult
    func acquire(retryFor seconds: TimeInterval = 0) -> Bool {
        if fd >= 0 { return true }
        try? FileManager.default.createDirectory(at: path.deletingLastPathComponent(), withIntermediateDirectories: true)
        let deadline = Date().addingTimeInterval(seconds)
        repeat {
            let handle = open(path.path, O_RDWR | O_CREAT | O_CLOEXEC, 0o600)
            if handle >= 0 {
                if flock(handle, LOCK_EX | LOCK_NB) == 0 {
                    fd = handle
                    return true
                }
                close(handle)
            }
            if Date() >= deadline { break }
            Thread.sleep(forTimeInterval: 0.1)
        } while true
        return false
    }

    func release() {
        guard fd >= 0 else { return }
        flock(fd, LOCK_UN)
        close(fd)
        fd = -1
    }

    deinit { release() }
}
