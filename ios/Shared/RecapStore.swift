import Foundation

/// The last few recaps this install has seen, kept as payload strings in UserDefaults.
/// The app and the extension each have their own defaults (there is no App Group in v1),
/// so each keeps its own list.
final class RecapStore {
    static let shared = RecapStore()

    private let defaults: UserDefaults
    private let recentsKey = "wrapped.recentPayloads.v1"
    private let pendingPayloadKey = "wrapped.pendingPlay.payload"
    private let pendingDateKey = "wrapped.pendingPlay.date"
    private let composedPayloadKey = "wrapped.lastComposed.payload"
    private let composedDateKey = "wrapped.lastComposed.date"
    private let limit = 6

    init(defaults: UserDefaults = UserDefaults.standard) {
        self.defaults = defaults
    }

    /// Most recent first. Entries that no longer decode are dropped.
    func recents() -> [Recap] {
        let payloads = defaults.stringArray(forKey: recentsKey) ?? []
        var result: [Recap] = []
        for payload in payloads {
            if let recap = try? Recap(payload: payload) {
                result.append(recap)
            }
        }
        return result
    }

    /// Remembers a recap. The built-in demo is never stored: it is always one tap away.
    func remember(_ recap: Recap) {
        guard !recap.isDemo else {
            return
        }
        var payloads = defaults.stringArray(forKey: recentsKey) ?? []
        payloads.removeAll { (existing: String) -> Bool in
            return existing == recap.payload
        }
        payloads.insert(recap.payload, at: 0)
        if payloads.count > limit {
            payloads = Array(payloads.prefix(limit))
        }
        defaults.set(payloads, forKey: recentsKey)
    }

    func clear() {
        defaults.removeObject(forKey: recentsKey)
        defaults.removeObject(forKey: pendingPayloadKey)
        defaults.removeObject(forKey: pendingDateKey)
        defaults.removeObject(forKey: composedPayloadKey)
        defaults.removeObject(forKey: composedDateKey)
    }

    // MARK: The recap that was just composed

    /// Recorded when a recap bubble is staged in the input field. The live bubble Messages
    /// creates for that staged message may not be given its message, so it can ask what
    /// was composed a moment ago instead of showing a generic bubble.
    func setLastComposed(_ recap: Recap, now: Date = Date()) {
        defaults.set(recap.payload, forKey: composedPayloadKey)
        defaults.set(now.timeIntervalSince1970, forKey: composedDateKey)
    }

    /// The recap composed within the last `maxAge` seconds, and when.
    func lastComposed(maxAge: TimeInterval = 30, now: Date = Date()) -> (recap: Recap, date: Date)? {
        guard let payload = defaults.string(forKey: composedPayloadKey) else {
            return nil
        }
        let stamp = defaults.double(forKey: composedDateKey)
        let age = now.timeIntervalSince1970 - stamp
        guard age >= 0, age <= maxAge, let recap = try? Recap(payload: payload) else {
            return nil
        }
        return (recap, Date(timeIntervalSince1970: stamp))
    }

    // MARK: Hand-off from a live bubble to the expanded instance

    /// A live bubble calls this just before it asks Messages for the expanded style.
    /// Messages then creates a *new* view controller, which picks the recap up with
    /// `takePendingPlay()` in case `selectedMessage` is not set for it.
    func setPendingPlay(_ recap: Recap, now: Date = Date()) {
        defaults.set(recap.payload, forKey: pendingPayloadKey)
        defaults.set(now.timeIntervalSince1970, forKey: pendingDateKey)
    }

    /// Returns the pending recap once, if it was set within the last `maxAge` seconds.
    func takePendingPlay(maxAge: TimeInterval = 20, now: Date = Date()) -> Recap? {
        guard let payload = defaults.string(forKey: pendingPayloadKey) else {
            return nil
        }
        let stamp = defaults.double(forKey: pendingDateKey)
        defaults.removeObject(forKey: pendingPayloadKey)
        defaults.removeObject(forKey: pendingDateKey)
        let age = now.timeIntervalSince1970 - stamp
        guard age >= 0, age <= maxAge else {
            return nil
        }
        return try? Recap(payload: payload)
    }
}
