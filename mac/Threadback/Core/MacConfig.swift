import Foundation

/// Build-time switches of the Mac app.
enum MacConfig {
    /// Where a recap link points (the web story). Same constant as the iOS app.
    static let storyBaseURL = WrappedConfig.baseURLString

    /// THE switch for the link in replies. The story site (GitHub Pages) is not published
    /// yet, so a link would be a 404 in the friends' chat: while this is false, replies are
    /// the image and the text only, the text uses its no-link wording, and every preview
    /// shows exactly that. Set it to true once `storyBaseURL` serves the story.
    static let storySiteIsLive = false

    /// The commit the app was built from (CI passes THREADBACK_COMMIT to xcodebuild).
    static var commit: String {
        let value = Bundle.main.object(forInfoDictionaryKey: "ThreadbackCommit") as? String ?? ""
        return value.isEmpty ? "local" : value
    }

    static var version: String {
        let short = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?"
        return "\(short) (\(build))"
    }
}

/// Where the app is running from, as a category (never the path: it contains the user name).
enum AppLocation: String {
    case applications = "Applications"
    case userApplications = "~/Applications"
    case translocated = "translocated (opened from where it was downloaded)"
    case downloads = "Downloads"
    case other = "somewhere else"

    static func classify(bundlePath: String, home: String) -> AppLocation {
        if bundlePath.contains("/AppTranslocation/") { return .translocated }
        if bundlePath.hasPrefix("/Applications/") { return .applications }
        let homeSlash = home.hasSuffix("/") ? home : home + "/"
        if bundlePath.hasPrefix(homeSlash + "Applications/") { return .userApplications }
        if bundlePath.hasPrefix(homeSlash + "Downloads/") { return .downloads }
        return .other
    }

    static var current: AppLocation {
        classify(bundlePath: Bundle.main.bundlePath, home: FileManager.default.homeDirectoryForCurrentUser.path)
    }

    /// Lasting permissions and the login item want a stable home for the app.
    var needsMove: Bool { self == .translocated || self == .downloads }

    /// Only a copy that is not translocated can be moved by the app itself; a translocated
    /// copy is a read-only mirror and the person has to drag the original.
    var canMoveItself: Bool { self == .downloads }
}
