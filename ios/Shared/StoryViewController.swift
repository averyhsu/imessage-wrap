import UIKit
import WebKit

/// What the story asks its native host to do (docs/SCHEMA.md §6).
protocol StoryViewControllerDelegate: AnyObject {
    /// "Send to this chat" was tapped in the story.
    func storyDidRequestSend(_ story: StoryViewController)
    /// The story was dismissed from inside the page.
    func storyDidRequestClose(_ story: StoryViewController)
    /// A link inside the story was tapped. The story itself never leaves its bundled page.
    func story(_ story: StoryViewController, didRequestOpen url: URL)
}

/// Keeps `WKUserContentController` from retaining the view controller.
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

/// Plays one recap: the bundled web story in a `WKWebView`, plus the native half of the
/// embed bridge (haptics, share sheet, send, close). Used by the app and by the iMessage
/// extension's expanded style.
final class StoryViewController: UIViewController, WKScriptMessageHandler, WKNavigationDelegate, UIScrollViewDelegate, UIGestureRecognizerDelegate {
    static let bridgeName = "wrapped"

    /// When true, the last bridge event is exposed through an invisible accessibility
    /// label (`story.bridge`) so UI tests can wait for "ready" and watch slides change.
    static var showsBridgeStatusForTesting = false

    let recap: Recap
    weak var delegate: StoryViewControllerDelegate?

    /// When true, dragging the story down dismisses it, so nobody is ever stuck in a
    /// full-screen story. The containing app turns this on; Messages has its own control
    /// for collapsing the expanded style. Set it before the view loads.
    var allowsSwipeDownToClose = false

    private var webView: WKWebView?
    private var statusLabel: UILabel?
    private var failureLabel: UILabel?
    private var loadingIndicator: UIActivityIndicatorView?
    private var reloadsAfterCrash = 0

    private(set) var slideCount = 0
    private(set) var currentSlide = 0
    private(set) var isReady = false
    private(set) var lastBridgeEvent = "loading"

    init(recap: Recap) {
        self.recap = recap
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override var prefersStatusBarHidden: Bool {
        return true
    }

    override var prefersHomeIndicatorAutoHidden: Bool {
        return true
    }

    override var preferredStatusBarStyle: UIStatusBarStyle {
        return .lightContent
    }

    // MARK: View

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []

        let content = WKUserContentController()
        content.add(WeakScriptMessageHandler(target: self), name: StoryViewController.bridgeName)
        content.addUserScript(
            WKUserScript(
                source: StoryViewController.errorReportingScript,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            )
        )
        content.addUserScript(
            WKUserScript(
                source: StoryViewController.viewportScript,
                injectionTime: .atDocumentEnd,
                forMainFrameOnly: true
            )
        )
        configuration.userContentController = content

        let web = WKWebView(frame: view.bounds, configuration: configuration)
        web.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        web.isOpaque = false
        web.backgroundColor = .black
        web.underPageBackgroundColor = .black
        web.scrollView.backgroundColor = .black
        web.scrollView.bounces = false
        web.scrollView.alwaysBounceVertical = false
        web.scrollView.alwaysBounceHorizontal = false
        web.scrollView.showsVerticalScrollIndicator = false
        web.scrollView.showsHorizontalScrollIndicator = false
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.scrollView.delegate = self
        web.allowsLinkPreview = false
        web.allowsBackForwardNavigationGestures = false
        web.navigationDelegate = self
        web.accessibilityIdentifier = "story.web"
        #if DEBUG
        if #available(iOS 16.4, *) {
            web.isInspectable = true
        }
        #endif
        view.addSubview(web)
        webView = web
        if allowsSwipeDownToClose {
            installSwipeDownToClose()
        }

        // A quiet native spinner until the page reports that the story is on screen.
        let spinner = UIActivityIndicatorView(style: .large)
        spinner.color = .white
        spinner.translatesAutoresizingMaskIntoConstraints = false
        spinner.startAnimating()
        view.addSubview(spinner)
        NSLayoutConstraint.activate([
            spinner.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: view.centerYAnchor)
        ])
        loadingIndicator = spinner

        if StoryViewController.showsBridgeStatusForTesting {
            let label = UILabel(frame: CGRect(x: 0, y: 0, width: 4, height: 4))
            label.textColor = .clear
            label.backgroundColor = .clear
            label.font = UIFont.systemFont(ofSize: 2)
            label.isUserInteractionEnabled = false
            label.isAccessibilityElement = true
            label.accessibilityIdentifier = "story.bridge"
            label.text = lastBridgeEvent
            label.accessibilityLabel = lastBridgeEvent
            view.addSubview(label)
            statusLabel = label
        }

        loadStory()
    }

    private func loadStory() {
        guard let location = RecapLink.bundledStoryLocation(payload: recap.payload) else {
            showFailure("The story files are missing from this build.")
            return
        }
        webView?.loadFileURL(location.url, allowingReadAccessTo: location.directory)
    }

    private func hideLoadingIndicator() {
        guard let spinner = loadingIndicator else {
            return
        }
        loadingIndicator = nil
        UIView.animate(
            withDuration: 0.2,
            animations: {
                spinner.alpha = 0
            },
            completion: { (_: Bool) in
                spinner.removeFromSuperview()
            }
        )
    }

    private func showFailure(_ text: String) {
        hideLoadingIndicator()
        setStatus("error: \(text)")
        if failureLabel == nil {
            let label = UILabel()
            label.translatesAutoresizingMaskIntoConstraints = false
            label.textColor = UIColor.white.withAlphaComponent(0.8)
            label.font = UIFont.systemFont(ofSize: 16, weight: .semibold)
            label.numberOfLines = 0
            label.textAlignment = .center
            view.addSubview(label)
            NSLayoutConstraint.activate([
                label.centerYAnchor.constraint(equalTo: view.centerYAnchor),
                label.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 32),
                label.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -32)
            ])
            failureLabel = label
        }
        failureLabel?.text = text
    }

    private func setStatus(_ text: String) {
        lastBridgeEvent = text
        statusLabel?.text = text
        statusLabel?.accessibilityLabel = text
    }

    // MARK: Native → page

    func pause() {
        evaluate("window.WrappedStory && window.WrappedStory.pause && window.WrappedStory.pause();")
    }

    func resume() {
        evaluate("window.WrappedStory && window.WrappedStory.resume && window.WrappedStory.resume();")
    }

    func goTo(slide index: Int) {
        evaluate("window.WrappedStory && window.WrappedStory.goTo && window.WrappedStory.goTo(\(index));")
    }

    private func evaluate(_ script: String) {
        webView?.evaluateJavaScript(script, completionHandler: nil)
    }

    // MARK: Page → native (WKScriptMessageHandler)

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard message.name == StoryViewController.bridgeName,
              let body = message.body as? [String: Any],
              let type = body["type"] as? String else {
            return
        }
        handleBridgeMessage(type: type, body: body)
    }

    private func intValue(_ value: Any?) -> Int? {
        if let number = value as? NSNumber {
            return number.intValue
        }
        if let string = value as? String {
            return Int(string)
        }
        return nil
    }

    private func handleBridgeMessage(type: String, body: [String: Any]) {
        switch type {
        case "ready":
            isReady = true
            hideLoadingIndicator()
            slideCount = intValue(body["slides"]) ?? slideCount
            setStatus("ready \(slideCount)")
        case "slide":
            hideLoadingIndicator()
            currentSlide = intValue(body["index"]) ?? currentSlide
            slideCount = intValue(body["total"]) ?? slideCount
            setStatus("slide \(currentSlide)/\(slideCount)")
        case "haptic":
            playHaptic(style: (body["style"] as? String) ?? "light")
        case "share":
            presentShareSheet(pngDataURL: body["png"] as? String, text: body["text"] as? String)
        case "send":
            setStatus("send")
            delegate?.storyDidRequestSend(self)
        case "close":
            setStatus("close")
            delegate?.storyDidRequestClose(self)
        case "error":
            let text = (body["message"] as? String) ?? "unknown"
            NSLog("[story] page error: %@", text)
            if !isReady {
                setStatus("error: \(text)")
            }
        default:
            break
        }
    }

    // MARK: Haptics

    private func playHaptic(style: String) {
        switch style {
        case "success":
            let generator = UINotificationFeedbackGenerator()
            generator.notificationOccurred(.success)
        case "medium":
            let generator = UIImpactFeedbackGenerator(style: .medium)
            generator.impactOccurred()
        default:
            let generator = UIImpactFeedbackGenerator(style: .light)
            generator.impactOccurred()
        }
    }

    // MARK: Share sheet

    /// Decodes `data:image/png;base64,…` into PNG bytes.
    static func imageData(fromDataURL dataURL: String) -> Data? {
        guard let comma = dataURL.firstIndex(of: ",") else {
            return nil
        }
        let header = dataURL[dataURL.startIndex..<comma]
        guard header.hasPrefix("data:image/"), header.hasSuffix(";base64") else {
            return nil
        }
        let encoded = String(dataURL[dataURL.index(after: comma)...])
        return Data(base64Encoded: encoded, options: .ignoreUnknownCharacters)
    }

    private func presentShareSheet(pngDataURL: String?, text: String?) {
        var items: [Any] = []
        if let dataURL = pngDataURL,
           let data = StoryViewController.imageData(fromDataURL: dataURL),
           UIImage(data: data) != nil {
            // Share a real PNG file so the card keeps its quality and gets a sensible name.
            let file = FileManager.default.temporaryDirectory.appendingPathComponent("recap.png")
            if (try? data.write(to: file, options: .atomic)) != nil {
                items.append(file)
            } else if let image = UIImage(data: data) {
                items.append(image)
            }
        }
        if let text = text, !text.isEmpty {
            items.append(text)
        }
        guard !items.isEmpty, presentedViewController == nil else {
            return
        }
        setStatus("share \(items.count)")

        let sheet = UIActivityViewController(activityItems: items, applicationActivities: nil)
        if let popover = sheet.popoverPresentationController {
            popover.sourceView = view
            popover.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.maxY - 80, width: 1, height: 1)
            popover.permittedArrowDirections = []
        }
        sheet.completionWithItemsHandler = { [weak self] (_: UIActivity.ActivityType?, _: Bool, _: [Any]?, _: Error?) in
            self?.resume()
        }
        pause()
        present(sheet, animated: true, completion: nil)
    }

    // MARK: WKNavigationDelegate

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        let scheme = (url.scheme ?? "").lowercased()
        if url.isFileURL || scheme == "about" || scheme == "blob" || scheme == "data" {
            decisionHandler(.allow)
            return
        }
        // The story is fully bundled: never navigate the web view to the network.
        decisionHandler(.cancel)
        if navigationAction.navigationType == .linkActivated, scheme == "https" || scheme == "http" {
            delegate?.story(self, didRequestOpen: url)
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // Fallback: a page that never reports "ready" must not keep the spinner forever.
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in
            self?.hideLoadingIndicator()
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        showFailure("The story could not be loaded.")
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        showFailure("The story could not be loaded.")
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // The web process was killed (memory pressure is the usual cause): reload once.
        if reloadsAfterCrash < 1 {
            reloadsAfterCrash += 1
            loadStory()
        } else {
            showFailure("The story stopped unexpectedly.")
        }
    }

    // MARK: Swipe down to close

    private func installSwipeDownToClose() {
        let pan = UIPanGestureRecognizer(target: self, action: #selector(handleDismissPan(_:)))
        pan.delegate = self
        pan.maximumNumberOfTouches = 1
        view.addGestureRecognizer(pan)
    }

    @objc private func handleDismissPan(_ pan: UIPanGestureRecognizer) {
        guard let web = webView else {
            return
        }
        let translation = pan.translation(in: view)
        switch pan.state {
        case .changed:
            let offset = max(0, translation.y)
            web.transform = CGAffineTransform(translationX: 0, y: offset * 0.5)
            web.alpha = 1 - min(0.5, offset / 600)
        case .ended, .cancelled, .failed:
            let velocity = pan.velocity(in: view)
            let draggedDown = translation.y > 140 && abs(translation.x) < translation.y
            if pan.state == .ended, draggedDown, velocity.y >= 0 {
                setStatus("close")
                delegate?.storyDidRequestClose(self)
            } else {
                UIView.animate(withDuration: 0.2) {
                    web.transform = .identity
                    web.alpha = 1
                }
            }
        default:
            break
        }
    }

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard let pan = gestureRecognizer as? UIPanGestureRecognizer else {
            return true
        }
        // Only a clearly downward drag starts the dismissal; taps and sideways swipes
        // belong to the story.
        let velocity = pan.velocity(in: view)
        return velocity.y > 0 && abs(velocity.y) > abs(velocity.x) * 1.5
    }

    func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
    ) -> Bool {
        return true
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
        post({ type: 'error', message: String((e && e.message) || e) + ' @' + String((e && e.filename) || '') + ':' + String((e && e.lineno) || 0) });
      });
      window.addEventListener('unhandledrejection', function (e) {
        post({ type: 'error', message: 'unhandledrejection: ' + String(e && e.reason) });
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
