import Foundation

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

    /// Where the web story is hosted. A recap link is this URL plus `#w1=<payload>`
    /// (docs/SCHEMA.md §5). Change it here and nowhere else.
    static let baseURLString = "https://averyhsu.github.io/imessage-wrap/"

    static var baseURL: URL {
        // The literal above is a valid URL; the fallback only exists to avoid a force unwrap.
        return URL(string: baseURLString) ?? URL(fileURLWithPath: "/")
    }

    /// Custom scheme the containing app registers: `imessagewrapped://recap#w1=<payload>`.
    static let appURLScheme = "imessagewrapped"
}
