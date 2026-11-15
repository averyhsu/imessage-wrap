import Foundation

/// What the owner decided, read by the agent right before it does anything: whether
/// everything is paused, and which chats are on right now. The window changes it on the main
/// thread; the agent reads it on its own queue, before each command and before each of the
/// three sends of a reply, so Pause and Turn off take effect mid-reply.
final class AgentControl {
    private let lock = NSLock()
    private var pausedValue = false
    private var liveValue = Set<String>()

    var paused: Bool {
        get { lock.withLock { pausedValue } }
        set { lock.withLock { pausedValue = newValue } }
    }

    /// The keys of the chats that may be answered now (turned on, and confirmed for what a
    /// reply carries in this version).
    var liveKeys: Set<String> {
        get { lock.withLock { liveValue } }
        set { lock.withLock { liveValue = newValue } }
    }

    func mayAnswer(_ key: String) -> Bool {
        lock.withLock { !pausedValue && liveValue.contains(key) }
    }
}

/// What turning a chat on means, said before it happens, and the signature of it that is
/// stored with each approval (the Python helper's scope_signature, for one chat). If what a
/// reply carries changes in a later version (for example, a link is added), the stored
/// signature no longer matches and that chat is not answered until the owner confirms again.
enum Consent {
    /// What a reply carries in this build.
    static func signature(link: Bool = MacConfig.storySiteIsLive) -> String {
        return "reply-v1:card,text" + (link ? ",link" : "") + ";quotes-off;short-names;cooldown-120"
    }

    static func needsConfirmation(stored: String?, current: String = signature()) -> Bool {
        return stored != current
    }

    static func title(chat: String) -> String {
        return "Turn on Threadback for \u{201C}\(chat)\u{201D}?"
    }

    /// The whole statement, shown before "Turn on" takes effect.
    static func statement(link: Bool = MacConfig.storySiteIsLive) -> String {
        if link {
            return "When anyone in this chat types /wrapped, your Mac replies from your Apple ID with three messages: a picture, a short text and a link.\n\n"
                + "Anyone in the chat can trigger it, at most once every 2 minutes.\n\n"
                + "The link opens the recap (the chat\u{2019}s name, first names and counts; no message text) for anyone it is forwarded to."
        }
        return "When anyone in this chat types /wrapped, your Mac replies from your Apple ID with two messages: a picture and a short text.\n\n"
            + "Anyone in the chat can trigger it, at most once every 2 minutes."
    }

    /// The question asked when what a reply carries has changed since the chat was turned on.
    static func changedTitle(chat: String) -> String {
        return "Replies in \u{201C}\(chat)\u{201D} now include a link"
    }

    static let changedStatement = "Since you turned this chat on, Threadback\u{2019}s replies changed: each reply is now three messages from your Apple ID, a picture, a short text and a link.\n\n"
        + "The link opens the recap (the chat\u{2019}s name, first names and counts; no message text) for anyone it is forwarded to.\n\n"
        + "Nothing is sent in this chat until you choose."
}
