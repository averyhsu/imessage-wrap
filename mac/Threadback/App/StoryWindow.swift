import AppKit
import WebKit

/// Plays the interactive story for one chat, on this Mac only: the bundled web story
/// (web/index.html, the same files as the site and the iOS app) in a phone-sized window,
/// with the recap handed over in the page address (#w1=...). Nothing is fetched, and the
/// web view may not navigate anywhere but the bundled story page (docs/SCHEMA.md 6).
final class StoryWindow: NSObject, NSWindowDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    private static var open: [StoryWindow] = []

    let window: NSWindow
    private let webView: WKWebView
    private let pagePath: String
    private let chatName: String
    private(set) var slides = 0
    private(set) var index = -1

    /// Opens a window playing `payload` (the link payload of the short-name stats).
    @discardableResult
    static func play(payload: String, chatName: String) -> StoryWindow? {
        guard let location = RecapLink.bundledStoryLocation(payload: payload) else { return nil }
        let story = StoryWindow(location: location, chatName: chatName)
        open.append(story)
        story.window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        return story
    }

    private init(location: (url: URL, directory: URL), chatName: String) {
        self.chatName = chatName
        pagePath = location.url.resolvingSymlinksInPath().standardizedFileURL.path
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let content = WKUserContentController()
        configuration.userContentController = content
        webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 390, height: 780), configuration: configuration)
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsMagnification = false
        webView.setAccessibilityIdentifier("story.web")
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 390, height: 780),
                          styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        super.init()
        // The page turns its bridge on only when it finds window.webkit.messageHandlers.wrapped.
        content.add(WeakHandler(self), name: "wrapped")
        webView.navigationDelegate = self
        window.title = "\(chatName) \u{00B7} story"
        window.identifier = NSUserInterfaceItemIdentifier("threadback.story")
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = MacPalette.night
        window.contentView = webView
        window.delegate = self
        window.center()
        webView.loadFileURL(location.url, allowingReadAccessTo: location.directory)
    }

    private func updateTitle() {
        // The title doubles as the test hook: "Taco · story · slide 2 of 12".
        let position = slides > 0 && index >= 0 ? " \u{00B7} slide \(index + 1) of \(slides)" : ""
        window.title = "\(chatName) \u{00B7} story\(position)"
        window.setAccessibilityValue(slides > 0 ? "ready \(slides) slides, at \(index + 1)" : "loading")
    }

    // MARK: Bridge

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let body = message.body as? [String: Any],
              let type = body["type"] as? String else { return }
        switch type {
        case "ready":
            slides = (body["slides"] as? Int) ?? slides
            index = max(index, 0)
            window.makeFirstResponder(webView)
        case "slide":
            index = (body["index"] as? Int) ?? index
            slides = (body["total"] as? Int) ?? slides
        case "close":
            window.close()
        case "error":
            window.title = "\(chatName) \u{00B7} the story could not be shown"
            return
        default:
            return
        }
        updateTitle()
    }

    // MARK: Navigation: only the bundled story page

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url
        let isMainFrame = navigationAction.targetFrame?.isMainFrame ?? true
        let samePage = url?.isFileURL == true && url?.resolvingSymlinksInPath().standardizedFileURL.path == pagePath
        decisionHandler(isMainFrame && samePage ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        window.makeFirstResponder(webView)
    }

    func windowWillClose(_ notification: Notification) {
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "wrapped")
        StoryWindow.open.removeAll { $0 === self }
    }
}

/// WKUserContentController keeps its handlers alive; this keeps the window from leaking.
private final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}
