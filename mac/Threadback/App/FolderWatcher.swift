import Foundation

/// Tells the app when the Messages database changes, instead of polling it every two
/// seconds. Messages appends every new message to `chat.db-wal`, so the watcher listens to
/// that file (writes, growth) and to the folder (the file being replaced after a
/// checkpoint). Bursts are coalesced; a slow safety poll covers anything missed.
final class FolderWatcher {
    private let folder: URL
    private let queue: DispatchQueue
    private let changed: () -> Void
    private var folderSource: DispatchSourceFileSystemObject?
    private var walSource: DispatchSourceFileSystemObject?
    private var poll: DispatchSourceTimer?
    private var pending = false
    private(set) var isWatching = false
    private(set) var events = 0

    /// `changed` runs on `queue`, at most once per `delay`.
    init(folder: URL, queue: DispatchQueue, delay: TimeInterval = 0.4, safetyPoll: TimeInterval = 60,
         changed: @escaping () -> Void) {
        self.folder = folder
        self.queue = queue
        self.changed = changed
        self.delay = delay
        self.safetyPoll = safetyPoll
    }

    private let delay: TimeInterval
    private let safetyPoll: TimeInterval

    func start() {
        stop()
        folderSource = watch(folder.path, events: [.write, .link, .rename, .delete]) { [weak self] in
            self?.armWAL()          // the -wal may have been replaced
            self?.fire()
        }
        armWAL()
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + safetyPoll, repeating: safetyPoll)
        timer.setEventHandler { [weak self] in self?.changed() }
        timer.resume()
        poll = timer
        isWatching = folderSource != nil || walSource != nil
    }

    func stop() {
        folderSource?.cancel()
        walSource?.cancel()
        poll?.cancel()
        folderSource = nil
        walSource = nil
        poll = nil
        isWatching = false
    }

    private func armWAL() {
        walSource?.cancel()
        walSource = watch(folder.appendingPathComponent("chat.db-wal").path, events: [.write, .extend, .delete, .rename]) { [weak self] in
            self?.fire()
        }
        isWatching = folderSource != nil || walSource != nil
    }

    private func watch(_ path: String, events: DispatchSource.FileSystemEvent, handler: @escaping () -> Void) -> DispatchSourceFileSystemObject? {
        let fd = open(path, O_EVTONLY)
        guard fd >= 0 else { return nil }
        let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: events, queue: queue)
        source.setEventHandler(handler: handler)
        source.setCancelHandler { close(fd) }
        source.resume()
        return source
    }

    /// Coalesces a burst of events into one call after `delay`.
    private func fire() {
        events += 1
        guard !pending else { return }
        pending = true
        queue.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self else { return }
            self.pending = false
            self.changed()
        }
    }
}
