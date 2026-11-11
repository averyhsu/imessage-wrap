import SwiftUI
import UIKit

/// App-wide state: which recap is playing and what the home screen should say.
///
/// Launch arguments (used by CI and UI tests):
/// - `--autoplay-demo`    play the bundled demo story immediately
/// - `--gallery`          show the debug gallery of the extension's native views
/// - `--open-url <url>`   behave as if that recap link had been opened
/// - `--ui-testing`       expose the story bridge status to UI tests
final class AppModel: ObservableObject {
    @Published var playing: Recap?
    @Published var notice: String?
    @Published var showsGallery = false

    init(arguments: [String] = ProcessInfo.processInfo.arguments) {
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
    }

    func playDemo() {
        notice = nil
        playing = DemoRecap.recap
    }

    /// Plays the recap carried by a link: the custom scheme
    /// (`imessagewrapped://recap#w1=…`) or an https story link.
    @discardableResult
    func open(_ url: URL) -> Bool {
        guard let recap = RecapLink.recap(from: url) else {
            notice = "That link does not contain a recap."
            return false
        }
        RecapStore.shared.remember(recap)
        notice = nil
        playing = recap
        return true
    }

    /// Plays the recap link on the clipboard, if there is one.
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
        notice = nil
        playing = recap
    }
}
