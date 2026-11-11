import UIKit
import WebKit

/// What a `StoryWebView` tells whoever is showing it.
@MainActor
protocol StoryWebViewOwner: AnyObject {
    /// A bridge message from the story page (docs/SCHEMA.md §6), already checked to come
    /// from the main frame of the bundled page.
    func storyWebView(_ story: StoryWebView, didReceive type: String, body: [String: Any])
    func storyWebViewDidFinishLoading(_ story: StoryWebView)
    func storyWebView(_ story: StoryWebView, didFailWith reason: String)
    /// A link inside the story was tapped; the web view itself never leaves the story.
    func storyWebView(_ story: StoryWebView, wantsToOpen url: URL)
}

/// Keeps `WKUserContentController` from retaining its message handler.
private final class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?

    init(target: WKScriptMessageHandler) {
        self.target = target
        super.init()
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        target?.userContentController(userContentController, didReceive: message)
    }
}

/// A web view locked to the bundled story page.
///
/// It can be created before any story is asked for (see `StoryWebViewPool`): the page
/// loads in embed mode and waits. `play(payload:)` then hands it a recap through the
/// page's `#w1=` fragment, which starts the story without loading anything again.
@MainActor
final class StoryWebView: NSObject, WKScriptMessageHandler, WKNavigationDelegate, UIScrollViewDelegate {
    static let bridgeName = "wrapped"

    let webView: WKWebView
    weak var owner: StoryWebViewOwner?

    /// True once the bundled page has finished loading.
    private(set) var isPageLoaded = false
    /// True when the bundled page is missing or the web process died too often.
    private(set) var isBroken = false
    /// How many navigations away from the bundled page were refused.
    private(set) var blockedNavigations = 0
    /// How many bridge messages were dropped because they did not come from the main
    /// frame of the bundled page, and where the last one came from.
    private(set) var ignoredMessages = 0
    private(set) var lastIgnoredSource = ""

    private let readAccessURL: URL?
    private let pagePath: String
    private var pendingPayload: String?
    private var currentPayload: String?
    private var restarts = 0

    // How the last `play` went, for the bridge status that tests and logs read.
    private var askedAt = Date()
    private var wasLoadedWhenAsked = false
    private var handedOverAfter: TimeInterval?
    private var scriptBackAfter: TimeInterval?
    private var scriptNote = ""

    /// "warm, handed over +0.00s, script back +0.31s [direct 290 ms], restarts 0": whether
    /// the page was already loaded when the story was asked for, when the recap was
    /// handed to it, when the page had finished starting the story (and how long that
    /// took inside the page), and how often the web process had to be started again.
    var timingNote: String {
        let source = wasLoadedWhenAsked ? "warm" : "cold"
        let handed = handedOverAfter.map { String(format: "%.2f", $0) } ?? "-"
        let back = scriptBackAfter.map { String(format: "%.2f", $0) } ?? "-"
        return "\(source), handed over +\(handed)s, script back +\(back)s [\(scriptNote)], restarts \(restarts)"
    }

    override init() {
        let location = RecapLink.bundledStoryLocation(payload: nil)
        readAccessURL = location?.directory
        pagePath = location.map { StoryWebView.canonicalPath($0.url) } ?? ""

        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        let content = WKUserContentController()
        content.addUserScript(
            WKUserScript(
                source: StoryWebView.errorReportingScript,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            )
        )
        content.addUserScript(
            WKUserScript(
                source: StoryWebView.viewportScript,
                injectionTime: .atDocumentEnd,
                forMainFrameOnly: true
            )
        )
        configuration.userContentController = content

        let web = WKWebView(frame: CGRect(x: 0, y: 0, width: 390, height: 780), configuration: configuration)
        web.isOpaque = false
        web.backgroundColor = WrappedTheme.nightUI
        web.underPageBackgroundColor = WrappedTheme.nightUI
        web.scrollView.backgroundColor = WrappedTheme.nightUI
        web.scrollView.bounces = false
        web.scrollView.alwaysBounceVertical = false
        web.scrollView.alwaysBounceHorizontal = false
        web.scrollView.showsVerticalScrollIndicator = false
        web.scrollView.showsHorizontalScrollIndicator = false
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.allowsLinkPreview = false
        web.allowsBackForwardNavigationGestures = false
        web.accessibilityIdentifier = "story.web"
        #if DEBUG
        web.isInspectable = true
        #endif
        webView = web
        super.init()

        // The handler exists before the page loads: the page only enters embed mode when
        // it finds `window.webkit.messageHandlers.wrapped`.
        content.add(WeakScriptMessageHandler(target: self), name: StoryWebView.bridgeName)
        web.scrollView.delegate = self
        web.navigationDelegate = self
        loadPage(payload: nil)
    }

    /// A path that compares equal however the same file is spelled (`/var` and
    /// `/private/var` on a device).
    private static func canonicalPath(_ url: URL) -> String {
        return url.resolvingSymlinksInPath().standardizedFileURL.path
    }

    private func isStoryPage(_ url: URL?) -> Bool {
        guard let url = url, url.isFileURL, !pagePath.isEmpty else {
            return false
        }
        return StoryWebView.canonicalPath(url) == pagePath
    }

    /// Whether a bridge message is listened to: only from the main frame, and only while
    /// that frame shows the bundled story page.
    func acceptsMessage(fromMainFrame isMainFrame: Bool, frameURL: URL?) -> Bool {
        return isMainFrame && isStoryPage(frameURL)
    }

    /// Whether a navigation may go ahead: the main frame may only (re)load the bundled
    /// story page, including changes of its #fragment. The story has no frames, so
    /// nothing is ever loaded into one.
    func allowsNavigation(inMainFrame isMainFrame: Bool, to url: URL?) -> Bool {
        return isMainFrame && isStoryPage(url)
    }

    private func loadPage(payload: String?) {
        guard let location = RecapLink.bundledStoryLocation(payload: payload),
              let directory = readAccessURL else {
            isBroken = true
            return
        }
        isPageLoaded = false
        webView.loadFileURL(location.url, allowingReadAccessTo: directory)
    }

    // MARK: Playing

    /// Plays a recap. If the page is already loaded this is immediate; otherwise the recap
    /// is handed over as soon as the page finishes loading.
    func play(payload: String) {
        currentPayload = payload
        askedAt = Date()
        wasLoadedWhenAsked = isPageLoaded
        handedOverAfter = nil
        scriptBackAfter = nil
        scriptNote = ""
        if isBroken {
            owner?.storyWebView(self, didFailWith: "The story files are missing from this build.")
            return
        }
        if isPageLoaded {
            handOver(payload)
        } else {
            pendingPayload = payload
        }
    }

    private func handOver(_ payload: String) {
        pendingPayload = nil
        handedOverAfter = Date().timeIntervalSince(askedAt)
        // The recap goes into the page address as its #fragment, then the page is asked to
        // read the address, once. Writing the fragment with replaceState is not a
        // navigation, so the page's own hashchange and popstate listeners do not start the
        // story a second time. If that is refused, a plain fragment change does the job.
        // The fragment travels as a JSON string, never spliced into the script as text.
        let fragment = RecapLink.storyFragment(payload: payload)
        guard let json = try? JSONSerialization.data(withJSONObject: [fragment], options: []),
              let literal = String(data: json, encoding: .utf8) else {
            owner?.storyWebView(self, didFailWith: "The recap could not be handed to the story.")
            return
        }
        // SCRIPT: hand-over
        let script = """
        (function (list) {
          var fragment = list[0];
          var began = Date.now();
          var direct = false;
          try {
            window.history.replaceState(window.history.state, '', '#' + fragment);
            direct = window.location.hash === '#' + fragment;
          } catch (e) {
            direct = false;
          }
          var canRoute = !!(window.WrappedApp && window.WrappedApp.route);
          if (canRoute && window.location.hash === '#' + fragment) {
            window.WrappedApp.route();
          } else {
            direct = false;
            window.location.hash = fragment;
          }
          return (direct ? 'direct ' : 'fragment ') + (Date.now() - began) + ' ms';
        })(\(literal));
        """
        let asked = askedAt
        webView.evaluateJavaScript(script) { [weak self] (result: Any?, _: Error?) in
            guard let self = self, self.askedAt == asked else {
                return
            }
            self.scriptBackAfter = Date().timeIntervalSince(asked)
            self.scriptNote = (result as? String) ?? "no result"
        }
    }

    /// Stops the story and returns the page to its waiting state, ready for the next recap.
    func reset() {
        currentPayload = nil
        pendingPayload = nil
        webView.transform = .identity
        webView.alpha = 1
        guard isPageLoaded else {
            return
        }
        // SCRIPT: reset
        let script = """
        (function () {
          try {
            window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
          } catch (e) {}
          if (window.location.hash && window.location.hash !== '#') {
            window.location.hash = '';
            return 'fragment';
          }
          if (window.WrappedApp && window.WrappedApp.route) {
            window.WrappedApp.route();
          }
          return 'direct';
        })();
        """
        webView.evaluateJavaScript(script, completionHandler: nil)
    }

    func evaluate(_ script: String, completion: ((Any?, Error?) -> Void)? = nil) {
        webView.evaluateJavaScript(script) { (result: Any?, error: Error?) in
            completion?(result, error)
        }
    }

    // MARK: Page → native (WKScriptMessageHandler)

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        // Only the main frame of the bundled story page may talk to native code.
        guard message.name == StoryWebView.bridgeName else {
            return
        }
        let frame = message.frameInfo
        guard acceptsMessage(fromMainFrame: frame.isMainFrame, frameURL: frame.request.url) else {
            ignoredMessages += 1
            let scheme = frame.request.url?.scheme ?? "none"
            let file = frame.request.url?.lastPathComponent ?? ""
            lastIgnoredSource = "mainFrame=\(frame.isMainFrame) \(scheme):\(file)"
            NSLog("[story] ignored a bridge message (%@)", lastIgnoredSource)
            return
        }
        guard let body = message.body as? [String: Any],
              let type = body["type"] as? String else {
            return
        }
        owner?.storyWebView(self, didReceive: type, body: body)
    }

    // MARK: WKNavigationDelegate

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void
    ) {
        let url = navigationAction.request.url
        // A navigation with no target frame would open a new window; treat it like the
        // main frame, so it is refused unless it is the story page itself.
        let isMainFrame = navigationAction.targetFrame?.isMainFrame ?? true
        if allowsNavigation(inMainFrame: isMainFrame, to: url) {
            decisionHandler(.allow)
            return
        }
        // The web view stays on the bundled story page, whatever asks it to move.
        blockedNavigations += 1
        decisionHandler(.cancel)
        let scheme = (url?.scheme ?? "").lowercased()
        if isMainFrame,
           let url = url,
           navigationAction.navigationType == .linkActivated,
           scheme == "https" || scheme == "http" {
            // A tapped web link is handed to the host, which opens it outside.
            owner?.storyWebView(self, wantsToOpen: url)
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        isPageLoaded = true
        owner?.storyWebViewDidFinishLoading(self)
        if let payload = pendingPayload {
            handOver(payload)
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        owner?.storyWebView(self, didFailWith: "navigation failed: \(StoryWebView.describe(error))")
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        owner?.storyWebView(self, didFailWith: "provisional navigation failed: \(StoryWebView.describe(error))")
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // The web process was killed (memory pressure is the usual cause): start it again
        // once, with whatever was playing.
        isPageLoaded = false
        if restarts < 2 {
            restarts += 1
            pendingPayload = currentPayload
            loadPage(payload: nil)
        } else {
            isBroken = true
            owner?.storyWebView(self, didFailWith: "the web process stopped repeatedly")
        }
    }

    static func describe(_ error: Error) -> String {
        let nsError = error as NSError
        return "\(nsError.domain) \(nsError.code) \(nsError.localizedDescription)"
    }

    // MARK: UIScrollViewDelegate (no pinch zoom)

    func scrollViewWillBeginZooming(_ scrollView: UIScrollView, with view: UIView?) {
        scrollView.pinchGestureRecognizer?.isEnabled = false
    }

    // MARK: Injected scripts

    /// Forwards uncaught page errors to native so a broken story is diagnosable from logs.
    private static let errorReportingScript = """
    (function () {
      function post(o) {
        try { window.webkit.messageHandlers.wrapped.postMessage(o); } catch (e) {}
      }
      window.addEventListener('error', function (e) {
        post({ type: 'jserror', message: String((e && e.message) || e) + ' @' + String((e && e.filename) || '') + ':' + String((e && e.lineno) || 0) });
      });
      window.addEventListener('unhandledrejection', function (e) {
        post({ type: 'jserror', message: 'unhandledrejection: ' + String(e && e.reason) });
      });
    })();
    """

    /// Makes sure the page cannot be pinch- or double-tap-zoomed, whatever its viewport tag says.
    private static let viewportScript = """
    (function () {
      var head = document.head || document.documentElement;
      var meta = document.querySelector('meta[name="viewport"]');
      if (!meta) {
        meta = document.createElement('meta');
        meta.setAttribute('name', 'viewport');
        meta.setAttribute('content', 'width=device-width, initial-scale=1, viewport-fit=cover');
        head.appendChild(meta);
      }
      var content = meta.getAttribute('content') || '';
      if (content.indexOf('user-scalable') === -1) { content += ', user-scalable=no'; }
      if (content.indexOf('maximum-scale') === -1) { content += ', maximum-scale=1'; }
      meta.setAttribute('content', content);
    })();
    """
}

/// Keeps one story web view warm, so a story does not wait for a web process to start and
/// the page to load.
///
/// The waiting web view sits, invisible, inside a view that is on screen (the home screen,
/// the launcher), so that WebKit treats its page as on screen rather than as a background
/// page, and so that the page is already laid out at a real size.
@MainActor
enum StoryWebViewPool {
    private static var idle: StoryWebView?
    private static weak var host: UIView?

    /// True when a web view with the story page loaded is waiting.
    static var isWarm: Bool {
        return idle?.isPageLoaded ?? false
    }

    /// Creates the web view and loads the story page ahead of time. `view`, when given,
    /// is where the waiting web view sits from now on. Cheap to call again.
    static func prewarm(in view: UIView? = nil) {
        if let view = view {
            host = view
        }
        if idle == nil {
            let story = StoryWebView()
            if !story.isBroken {
                idle = story
            }
        }
        park()
    }

    private static func park() {
        guard let story = idle, let host = host, host.window != nil else {
            return
        }
        let web = story.webView
        guard web.superview !== host else {
            return
        }
        web.removeFromSuperview()
        web.transform = .identity
        web.frame = host.bounds
        web.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        web.alpha = 0
        web.isUserInteractionEnabled = false
        host.insertSubview(web, at: 0)
    }

    /// The warm web view if there is one, otherwise a new one.
    static func take() -> StoryWebView {
        if let story = idle {
            idle = nil
            let web = story.webView
            web.removeFromSuperview()
            web.alpha = 1
            web.isUserInteractionEnabled = true
            // One whose web process died for good while it waited is not handed out.
            if !story.isBroken {
                return story
            }
        }
        return StoryWebView()
    }

    /// Hands a web view back when its story is dismissed. It is reset and kept for the
    /// next story unless one is already waiting.
    static func recycle(_ story: StoryWebView) {
        story.owner = nil
        story.webView.removeFromSuperview()
        guard !story.isBroken, idle == nil else {
            return
        }
        story.reset()
        idle = story
        park()
    }
}

/// A view that, once it is on screen, warms the story web view up and gives it a place to
/// wait. The containing app puts one behind its home screen.
final class StoryWarmUpView: UIView {
    override func didMoveToWindow() {
        super.didMoveToWindow()
        guard window != nil else {
            return
        }
        // Not during the first frame: let the screen come up first.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
            self?.warmUp()
        }
    }

    private func warmUp() {
        guard window != nil else {
            return
        }
        StoryWebViewPool.prewarm(in: self)
    }
}
