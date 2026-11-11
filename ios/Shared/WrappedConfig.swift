import Foundation

/// Where the payload travels inside a recap link (docs/SCHEMA.md §5).
enum RecapLinkForm {
    /// `https://…/#w1=<payload>`: the default. Browsers never send a fragment to a server.
    case fragment
    /// `https://…/?w1=<payload>`: fallback for transports that drop fragments.
    case query
}

/// Constants shared by the app and the iMessage extension.
enum WrappedConfig {
    /// Public product name (docs/SCHEMA.md §7). The single source is the build setting
    /// `PRODUCT_DISPLAY_NAME` in `project.yml`, which both Info.plists use as
    /// `CFBundleDisplayName`; this reads it back so Swift never repeats the literal.
    static let productName: String = {
        if let name = Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String,
           !name.isEmpty {
            return name
        }
        return "Threadback"
    }()

    static let productDescriptor = "Your group chat's year in review"

    /// Where the web story is hosted. A recap link is this URL plus `#w1=<payload>`.
    /// Change it here and nowhere else.
    static let baseURLString = "https://averyhsu.github.io/imessage-wrap/"

    /// THE switch for the link form used when this app builds a link (for `MSMessage.url`
    /// and for sharing). Parsing always accepts both forms. Whether a `#fragment` survives
    /// an iMessage round trip between real devices is unverified; if it does not, flip this
    /// to `.query` (the stats then reach the web host when a Mac user opens the link).
    static let linkForm: RecapLinkForm = .fragment

    /// Whole-URL budget for a recap link. `MSMessage.url` rejects anything over 5,000
    /// characters; the contract keeps a margin.
    static let maxLinkLength = 4800

    /// Whether a recap is sent as a live in-bubble view (`MSMessageLiveLayout`) or as the
    /// template card alone. Off by default, on the evidence of the iOS 26.5 Simulator
    /// (CI run 43050898939): Messages never gives a live bubble's view controller its
    /// conversation, so a recipient's bubble cannot read its own message and can only show
    /// a generic "Open to play this recap" state, while the template card always shows the
    /// chat name and the count. Live layout also has long-standing "stuck on Loading…"
    /// reports on iOS 17 and later. Turn this on once a real iPhone shows a recipient's
    /// live bubble with the recap in it; the template card stays attached as the fallback.
    static let useLiveLayout = false

    /// Custom scheme the containing app registers: `threadback://recap#w1=<payload>`.
    /// Registered through the build setting `APP_URL_SCHEME` in `project.yml`.
    static let appURLScheme = "threadback"

    /// Key that carries the payload in links (`w1` = payload format version 1).
    static let payloadKey = "w1"
}
