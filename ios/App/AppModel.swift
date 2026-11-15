import SwiftUI
import UIKit

/// App-wide state: which recap is playing and what the home screen should say.
///
/// Launch arguments, honoured in DEBUG builds only (CI and UI tests use them):
/// - `--autoplay-demo`    play the bundled sample story immediately
/// - `--gallery`          show the debug gallery of the extension's native views
/// - `--open-url <url>`   behave as if that recap link had been opened
/// - `--ui-testing`       expose the story bridge status to UI tests
final class AppModel: ObservableObject {
    @Published var playing: Recap?
    @Published var notice: String?
    @Published var showsGallery = false
    /// Recaps the user pasted into the app, newest first.
    @Published var recents: [Recap] = []

    init(arguments: [String] = ProcessInfo.processInfo.arguments) {
        recents = RecapStore.shared.recents()
        #if DEBUG
        if arguments.contains("--gallery") {
            showsGallery = true
        }
        if arguments.contains("--autoplay-demo") {
            playing = DemoRecap.recap
        }
        if let index = arguments.firstIndex(of: "--open-url"),
           index + 1 < arguments.count,
           let url = URL(string: arguments[index + 1]) {
            _ = open(url)
        }
        #endif
    }

    /// Plays the built-in sample (invented data).
    func playSample() {
        notice = nil
        playing = DemoRecap.recap
    }

    func play(_ recap: Recap) {
        notice = nil
        playing = recap
    }

    /// Plays the recap carried by a link the system handed to the app. Only recap links
    /// are accepted (`RecapLink.isRecapLink`): the app's own scheme with host `recap`, or
    /// the https story page. Anything else stays on Home with a notice. A recap opened
    /// this way is played, not kept.
    @discardableResult
    func open(_ url: URL) -> Bool {
        guard let recap = RecapLink.recap(from: url) else {
            notice = "That link does not contain a recap."
            return false
        }
        notice = nil
        playing = recap
        return true
    }

    /// Plays the recap link on the clipboard, if there is one, and keeps it under
    /// "Your recaps" (the user brought it here themselves).
    func pasteLink() {
        let pasteboard = UIPasteboard.general
        var text: String?
        if pasteboard.hasURLs, let url = pasteboard.url {
            text = url.absoluteString
        } else if pasteboard.hasStrings {
            text = pasteboard.string
        }
        guard let found = text, let recap = RecapLink.recap(inText: found) else {
            notice = "No recap link on the clipboard. Copy a recap link, then tap Paste again."
            return
        }
        RecapStore.shared.remember(recap)
        recents = RecapStore.shared.recents()
        notice = nil
        playing = recap
    }

    func clearRecents() {
        RecapStore.shared.clear()
        recents = []
    }
}
