import Foundation

/// A small, tolerant view of the stats JSON (docs/SCHEMA.md §1): just what the native
/// shell draws itself. Unknown keys are ignored and missing keys fall back to neutral
/// values; the full stats object always travels untouched inside the payload.
struct RecapSummary: Codable, Equatable {
    struct Sender: Codable, Equatable {
        var name: String
        var messages: Int
    }

    var version: Int
    var chatName: String
    var memberCount: Int?
    var periodLabel: String
    var totalMessages: Int
    var topSenders: [Sender]
    var personalityTitle: String?

    init(
        version: Int = 1,
        chatName: String,
        memberCount: Int? = nil,
        periodLabel: String,
        totalMessages: Int,
        topSenders: [Sender] = [],
        personalityTitle: String? = nil
    ) {
        self.version = version
        self.chatName = chatName
        self.memberCount = memberCount
        self.periodLabel = periodLabel
        self.totalMessages = totalMessages
        self.topSenders = topSenders
        self.personalityTitle = personalityTitle
    }

    // MARK: Decoding (tolerant)

    private struct Key: CodingKey {
        var stringValue: String
        var intValue: Int? { return nil }

        init(_ name: String) {
            self.stringValue = name
        }

        init?(stringValue: String) {
            self.stringValue = stringValue
        }

        init?(intValue: Int) {
            return nil
        }
    }

    /// One `senders[]` entry. Its initialiser never throws, so one odd entry cannot make
    /// the whole array undecodable.
    private struct LossySender: Decodable {
        var name: String?
        var messages: Int?

        init(from decoder: Decoder) throws {
            guard let container = try? decoder.container(keyedBy: Key.self) else {
                return
            }
            name = RecapSummary.string(container, "name")
            messages = RecapSummary.int(container, "messages")
        }
    }

    private static func string(_ container: KeyedDecodingContainer<Key>?, _ name: String) -> String? {
        guard let container = container else {
            return nil
        }
        let key = Key(name)
        if let value = try? container.decode(String.self, forKey: key) {
            return value
        }
        if let value = try? container.decode(Int.self, forKey: key) {
            return String(value)
        }
        return nil
    }

    private static func int(_ container: KeyedDecodingContainer<Key>?, _ name: String) -> Int? {
        guard let container = container else {
            return nil
        }
        let key = Key(name)
        if let value = try? container.decode(Int.self, forKey: key) {
            return value
        }
        if let value = try? container.decode(Double.self, forKey: key),
           value.isFinite, abs(value) < 1e15 {
            return Int(value)
        }
        if let value = try? container.decode(String.self, forKey: key) {
            return Int(value)
        }
        return nil
    }

    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Key.self)
        let chat = try? root.nestedContainer(keyedBy: Key.self, forKey: Key("chat"))
        let period = try? root.nestedContainer(keyedBy: Key.self, forKey: Key("period"))
        let totals = try? root.nestedContainer(keyedBy: Key.self, forKey: Key("totals"))
        let personality = try? root.nestedContainer(keyedBy: Key.self, forKey: Key("personality"))

        // A recap must at least look like a stats object.
        guard chat != nil || totals != nil else {
            throw RecapPayloadError.notAStatsObject
        }

        version = RecapSummary.int(root, "v") ?? 1

        let name = (RecapSummary.string(chat, "name") ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        chatName = name.isEmpty ? "Your group chat" : name
        memberCount = RecapSummary.int(chat, "members")

        periodLabel = (RecapSummary.string(period, "label") ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        totalMessages = max(0, RecapSummary.int(totals, "messages") ?? 0)

        let lossy = (try? root.decode([LossySender].self, forKey: Key("senders"))) ?? []
        var senders: [Sender] = []
        for entry in lossy {
            guard let senderName = entry.name, !senderName.isEmpty else {
                continue
            }
            senders.append(Sender(name: senderName, messages: max(0, entry.messages ?? 0)))
            if senders.count == 3 {
                break
            }
        }
        topSenders = senders

        let title = (RecapSummary.string(personality, "title") ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        personalityTitle = title.isEmpty ? nil : title
    }

    // MARK: Encoding (same nested shape as the stats JSON, subset of keys)

    func encode(to encoder: Encoder) throws {
        var root = encoder.container(keyedBy: Key.self)
        try root.encode(version, forKey: Key("v"))

        var chat = root.nestedContainer(keyedBy: Key.self, forKey: Key("chat"))
        try chat.encode(chatName, forKey: Key("name"))
        if let memberCount = memberCount {
            try chat.encode(memberCount, forKey: Key("members"))
        }

        var period = root.nestedContainer(keyedBy: Key.self, forKey: Key("period"))
        try period.encode(periodLabel, forKey: Key("label"))

        var totals = root.nestedContainer(keyedBy: Key.self, forKey: Key("totals"))
        try totals.encode(totalMessages, forKey: Key("messages"))

        try root.encode(topSenders, forKey: Key("senders"))

        if let personalityTitle = personalityTitle {
            var personality = root.nestedContainer(keyedBy: Key.self, forKey: Key("personality"))
            try personality.encode(personalityTitle, forKey: Key("title"))
        }
    }

    static func decode(json: Data) throws -> RecapSummary {
        do {
            return try JSONDecoder().decode(RecapSummary.self, from: json)
        } catch {
            throw RecapPayloadError.notAStatsObject
        }
    }

    // MARK: Display strings

    private static let countFormatter: NumberFormatter = {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        formatter.maximumFractionDigits = 0
        return formatter
    }()

    static func formatCount(_ value: Int) -> String {
        return countFormatter.string(from: NSNumber(value: value)) ?? String(value)
    }

    /// "48,213"
    var formattedTotal: String {
        return RecapSummary.formatCount(totalMessages)
    }

    /// "2026 in review" (docs/SCHEMA.md §7), or "In review" when the period has no label.
    var reviewLabel: String {
        return periodLabel.isEmpty ? "In review" : "\(periodLabel) in review"
    }

    /// "Dinner Club · 2026 in review": the caption under the message bubble.
    var caption: String {
        return "\(chatName) · \(reviewLabel)"
    }

    /// "48,213 messages"
    var messagesLine: String {
        return totalMessages == 1 ? "1 message" : "\(formattedTotal) messages"
    }

    /// "48,213 messages · Tap to play": the subcaption under the message bubble.
    var subcaption: String {
        return "\(messagesLine) · Tap to play"
    }

    /// "2026 · 48,213 messages": the second line of a compact list row.
    var shortLine: String {
        return periodLabel.isEmpty ? messagesLine : "\(periodLabel) · \(messagesLine)"
    }
}

/// A recap as it travels: the opaque payload plus the decoded summary.
struct Recap: Identifiable, Equatable {
    let payload: String
    let summary: RecapSummary

    var id: String {
        return payload
    }

    /// Decodes and validates a payload. Throws `RecapPayloadError`.
    init(payload: String) throws {
        let json = try RecapPayload.decode(payload)
        self.summary = try RecapSummary.decode(json: json)
        self.payload = payload
    }

    /// For built-in constants whose payload is already known to match the summary.
    init(unvalidatedPayload payload: String, summary: RecapSummary) {
        self.payload = payload
        self.summary = summary
    }

    /// Wraps the UTF-8 JSON bytes of a stats object.
    init(statsJSON: Data) throws {
        self.summary = try RecapSummary.decode(json: statsJSON)
        self.payload = try RecapPayload.encode(json: statsJSON)
    }

    static func == (lhs: Recap, rhs: Recap) -> Bool {
        return lhs.payload == rhs.payload
    }

    /// True for the built-in sample (invented data). It is labelled "Sample" wherever it
    /// is shown or sent, and it is never kept among the recent recaps.
    var isDemo: Bool {
        return payload == DemoRecap.payload
    }

    /// "Dinner Club · 2026 in review", with "Sample · " in front for the built-in sample.
    var caption: String {
        return isDemo ? "Sample · \(summary.caption)" : summary.caption
    }

    /// "2026 IN REVIEW", or "SAMPLE · 2026 IN REVIEW".
    var eyebrow: String {
        let label = summary.reviewLabel.uppercased()
        return isDemo ? "SAMPLE · \(label)" : label
    }
}
