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

    /// Live in-bubble layout (`MSMessageLiveLayout`). It has long-standing "stuck on
    /// Loading…" reports on iOS 17 and later; set this to `false` to ship template-only
    /// bubbles. The template card is always attached as the alternate layout either way.
    static let useLiveLayout = true

    /// Custom scheme the containing app registers: `imessagewrapped://recap#w1=<payload>`.
    static let appURLScheme = "imessagewrapped"

    /// Key that carries the payload in links (`w1` = payload format version 1).
    static let payloadKey = "w1"
}
