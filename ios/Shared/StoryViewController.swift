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

/// Plays one recap: the bundled web story in a `WKWebView`, plus the native half of the
/// embed bridge (haptics, share sheet, send, close). Used by the app and by the iMessage
/// extension's expanded style.
///
/// Until the page reports that the story is on screen, a native cover in the look of the
/// story's first slide is shown (the chat name on the brand gradient), so the screen is
/// never black; it cross-fades into the story.
final class StoryViewController: UIViewController, StoryWebViewOwner, UIGestureRecognizerDelegate {
    /// When true, the last bridge event is exposed through an invisible accessibility
    /// label (`story.bridge`) so UI tests can wait for "ready" and watch slides change.
    static var showsBridgeStatusForTesting = false

    let recap: Recap
    weak var delegate: StoryViewControllerDelegate?

    /// When true, dragging the story down dismisses it, so nobody is ever stuck in a
    /// full-screen story. The containing app turns this on; Messages has its own control
    /// for collapsing the expanded style. Set it before the view loads.
    var allowsSwipeDownToClose = false

    private var story: StoryWebView?
    private var cover: StoryCoverView?
    private var statusLabel: UILabel?
    private var failureLabel: UILabel?
    private var playStartedAt = Date()
    private var readyNote = ""

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
        view.backgroundColor = WrappedTheme.coverBottomUI

        // A web view that was warmed up earlier starts the story at once; a new one has
        // to start its process and load the page first.
        let story = StoryWebViewPool.take()
        story.owner = self
        let web = story.webView
        web.transform = .identity
        web.alpha = 1
        web.frame = view.bounds
        web.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(web)
        self.story = story
        if allowsSwipeDownToClose {
            installSwipeDownToClose()
        }

        // The cover hides the web view until the story is on screen.
        let cover = StoryCoverView(frame: view.bounds)
        cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        cover.configure(with: recap.summary, isSample: recap.isDemo)
        view.addSubview(cover)
        self.cover = cover

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

        playStartedAt = Date()
        setStatus(story.isPageLoaded ? "loading: warm web view" : "loading: cold web view")
        story.play(payload: recap.payload)

        // Whatever happens, the cover does not stay up forever.
        DispatchQueue.main.asyncAfter(deadline: .now() + 12.0) { [weak self] in
            self?.revealIfStillWaiting()
        }
    }

    /// Returns the web view to the pool. Hosts call this when the story goes away.
    func releaseWebView() {
        guard let story = story else {
            return
        }
        self.story = nil
        StoryWebViewPool.recycle(story)
    }

    private func revealStory() {
        guard let cover = cover else {
            return
        }
        self.cover = nil
        UIView.animate(
            withDuration: 0.35,
            animations: {
                cover.alpha = 0
            },
            completion: { (_: Bool) in
                cover.removeFromSuperview()
            }
        )
    }

    private func showFailure(_ text: String) {
        revealStory()
        setStatus("error: \(text)")
        if failureLabel == nil {
            // A native notice that covers the page; tapping it leaves the story.
            let notice = UIView(frame: view.bounds)
            notice.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            notice.backgroundColor = WrappedTheme.nightUI
            notice.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(handleFailureTap)))
            view.addSubview(notice)

            let label = UILabel()
            label.translatesAutoresizingMaskIntoConstraints = false
            label.textColor = UIColor.white.withAlphaComponent(0.86)
            label.font = UIFont.systemFont(ofSize: 17, weight: .semibold)
            label.numberOfLines = 0
            label.textAlignment = .center
            label.accessibilityIdentifier = "story.failure"
            notice.addSubview(label)
            NSLayoutConstraint.activate([
                label.centerYAnchor.constraint(equalTo: notice.centerYAnchor),
                label.leadingAnchor.constraint(equalTo: notice.leadingAnchor, constant: 32),
                label.trailingAnchor.constraint(equalTo: notice.trailingAnchor, constant: -32)
            ])
            failureLabel = label
        }
        failureLabel?.text = text + "\n\nTap to close."
    }

    @objc private func handleFailureTap() {
        delegate?.storyDidRequestClose(self)
    }

    private func setStatus(_ text: String) {
        lastBridgeEvent = text
        statusLabel?.text = text
        statusLabel?.accessibilityLabel = text
    }

    // MARK: Native → page

    func pause() {
        story?.evaluate("window.WrappedStory && window.WrappedStory.pause && window.WrappedStory.pause();")
    }

    func resume() {
        story?.evaluate("window.WrappedStory && window.WrappedStory.resume && window.WrappedStory.resume();")
    }

    func goTo(slide index: Int) {
        story?.evaluate("window.WrappedStory && window.WrappedStory.goTo && window.WrappedStory.goTo(\(index));")
    }

    // MARK: StoryWebViewOwner

    private func intValue(_ value: Any?) -> Int? {
        if let number = value as? NSNumber {
            return number.intValue
        }
        if let string = value as? String {
            return Int(string)
        }
        return nil
    }

    func storyWebView(_ story: StoryWebView, didReceive type: String, body: [String: Any]) {
        switch type {
        case "ready":
            isReady = true
            revealStory()
            slideCount = intValue(body["slides"]) ?? slideCount
            // "(ready in 0.3s)": from asking for the story to the story being on screen.
            let elapsed = String(format: "%.1f", Date().timeIntervalSince(playStartedAt))
            readyNote = " (ready in \(elapsed)s)"
            setStatus("ready \(slideCount)\(readyNote)")
            NSLog("[story] ready after %@ s, %ld slides", elapsed, slideCount)
        case "slide":
            revealStory()
            currentSlide = intValue(body["index"]) ?? currentSlide
            slideCount = intValue(body["total"]) ?? slideCount
            setStatus("slide \(currentSlide)/\(slideCount)\(readyNote)")
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
            // The page could not read or show the recap; the contract leaves the notice
            // to the native side.
            let text = (body["message"] as? String) ?? "unknown"
            NSLog("[story] the page reported an error: %@", text)
            showFailure("This recap could not be played.")
            setStatus("error: page: \(text)")
        case "jserror":
            // An uncaught script error, forwarded by the script the web view injects.
            let text = (body["message"] as? String) ?? "unknown"
            NSLog("[story] uncaught page error: %@", text)
            if !isReady {
                setStatus("loading: script error: \(text)")
            }
        default:
            break
        }
    }

    func storyWebViewDidFinishLoading(_ story: StoryWebView) {
        if !isReady {
            setStatus("loaded")
        }
        // Fallback: a page that never reports "ready" must not keep the cover forever.
        // If it still has not reported by then, record what the page looks like inside.
        DispatchQueue.main.asyncAfter(deadline: .now() + 4.0) { [weak self] in
            self?.revealIfStillWaiting()
        }
    }

    private func revealIfStillWaiting() {
        guard !isReady else {
            return
        }
        revealStory()
        let script = """
        (function () {
          try {
            return [
              'readyState=' + document.readyState,
              'visibility=' + document.visibilityState,
              'class=' + document.documentElement.className,
              'story=' + (typeof window.WrappedStory),
              'handler=' + !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.wrapped),
              'size=' + window.innerWidth + 'x' + window.innerHeight
            ].join(' ');
          } catch (e) {
            return 'probe failed: ' + e;
          }
        })()
        """
        story?.evaluate(script) { [weak self] (result: Any?, error: Error?) in
            guard let self = self, !self.isReady else {
                return
            }
            let text: String
            if let value = result as? String {
                text = value
            } else if let error = error {
                text = "js error: \(StoryWebView.describe(error))"
            } else {
                text = "no result"
            }
            let ignored = self.story.map { "ignored=\($0.ignoredMessages) \($0.lastIgnoredSource)" } ?? ""
            NSLog("[story] not ready after load: %@ %@", text, ignored)
            self.setStatus("loaded, not ready: \(text) \(ignored)")
        }
    }

    func storyWebView(_ story: StoryWebView, didFailWith reason: String) {
        showFailure("The story could not be loaded.")
        setStatus("error: \(reason)")
    }

    func storyWebView(_ story: StoryWebView, wantsToOpen url: URL) {
        delegate?.story(self, didRequestOpen: url)
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

    // MARK: Swipe down to close

    private func installSwipeDownToClose() {
        let pan = UIPanGestureRecognizer(target: self, action: #selector(handleDismissPan(_:)))
        pan.delegate = self
        pan.maximumNumberOfTouches = 1
        view.addGestureRecognizer(pan)
    }

    @objc private func handleDismissPan(_ pan: UIPanGestureRecognizer) {
        guard let web = story?.webView else {
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
}

/// What is on screen while the story gets ready: the brand gradient with the chat name
/// and "2026 in review", in the look of the story's first slide.
final class StoryCoverView: UIView {
    private let gradientLayer = CAGradientLayer()
    private let lightBlob = CAShapeLayer()
    private let deepBlob = CAShapeLayer()
    private let eyebrowLabel = UILabel()
    private let nameLabel = UILabel()
    private let reviewLabel = UILabel()
    private let reviewPill = UIView()
    private let countLabel = UILabel()
    private let spinner = UIActivityIndicatorView(style: .medium)

    override init(frame: CGRect) {
        super.init(frame: frame)
        setUp()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    private func setUp() {
        backgroundColor = WrappedTheme.coverMidUI
        clipsToBounds = true
        isAccessibilityElement = false
        accessibilityIdentifier = "story.cover"

        gradientLayer.colors = WrappedTheme.coverCGColors
        gradientLayer.locations = [0.0, 0.38, 1.0]
        gradientLayer.startPoint = CGPoint(x: 0.37, y: 0)
        gradientLayer.endPoint = CGPoint(x: 0.63, y: 1)
        layer.addSublayer(gradientLayer)
        lightBlob.fillColor = WrappedTheme.blobLightUI.cgColor
        deepBlob.fillColor = WrappedTheme.blobDeepUI.cgColor
        layer.addSublayer(lightBlob)
        layer.addSublayer(deepBlob)

        eyebrowLabel.font = WrappedTheme.displayFont(ofSize: 13, weight: .heavy)
        eyebrowLabel.textColor = UIColor.white.withAlphaComponent(0.85)

        nameLabel.font = WrappedTheme.displayFont(ofSize: 44, weight: .black)
        nameLabel.textColor = .white
        nameLabel.numberOfLines = 3
        nameLabel.adjustsFontSizeToFitWidth = true
        nameLabel.minimumScaleFactor = 0.6
        nameLabel.lineBreakMode = .byTruncatingTail

        reviewLabel.font = WrappedTheme.displayFont(ofSize: 22, weight: .black)
        reviewLabel.textColor = WrappedTheme.coverBottomUI
        reviewLabel.translatesAutoresizingMaskIntoConstraints = false
        reviewPill.backgroundColor = .white
        reviewPill.layer.cornerRadius = 22
        reviewPill.layer.masksToBounds = true
        reviewPill.addSubview(reviewLabel)

        countLabel.font = UIFont.systemFont(ofSize: 16, weight: .semibold)
        countLabel.textColor = UIColor.white.withAlphaComponent(0.85)

        spinner.color = .white
        spinner.startAnimating()

        let stack = UIStackView(arrangedSubviews: [eyebrowLabel, nameLabel, reviewPill, countLabel])
        stack.axis = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.setCustomSpacing(16, after: nameLabel)
        stack.setCustomSpacing(14, after: reviewPill)
        stack.translatesAutoresizingMaskIntoConstraints = false
        spinner.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        addSubview(spinner)

        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 28),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -28),
            stack.centerYAnchor.constraint(equalTo: centerYAnchor, constant: 10),
            reviewPill.heightAnchor.constraint(equalToConstant: 44),
            reviewLabel.leadingAnchor.constraint(equalTo: reviewPill.leadingAnchor, constant: 18),
            reviewLabel.trailingAnchor.constraint(equalTo: reviewPill.trailingAnchor, constant: -18),
            reviewLabel.centerYAnchor.constraint(equalTo: reviewPill.centerYAnchor),
            spinner.centerXAnchor.constraint(equalTo: centerXAnchor),
            spinner.bottomAnchor.constraint(equalTo: safeAreaLayoutGuide.bottomAnchor, constant: -28)
        ])
    }

    func configure(with summary: RecapSummary, isSample: Bool) {
        eyebrowLabel.attributedText = NSAttributedString(
            string: isSample ? "SAMPLE RECAP" : "YOUR GROUP CHAT",
            attributes: [.kern: 1.4]
        )
        nameLabel.text = summary.chatName
        reviewLabel.text = summary.reviewLabel
        countLabel.text = summary.messagesLine
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        gradientLayer.frame = bounds
        StoryCoverView.place(
            lightBlob,
            size: CGSize(width: bounds.width * 0.85, height: bounds.height * 0.27),
            center: CGPoint(x: bounds.maxX - bounds.width * 0.12, y: bounds.minY + bounds.height * 0.05),
            degrees: 14
        )
        StoryCoverView.place(
            deepBlob,
            size: CGSize(width: bounds.width * 0.92, height: bounds.height * 0.3),
            center: CGPoint(x: bounds.minX + bounds.width * 0.08, y: bounds.maxY - bounds.height * 0.02),
            degrees: -10
        )
        CATransaction.commit()
    }

    private static func place(_ blob: CAShapeLayer, size: CGSize, center: CGPoint, degrees: CGFloat) {
        let rect = CGRect(x: -size.width / 2, y: -size.height / 2, width: size.width, height: size.height)
        blob.path = UIBezierPath(roundedRect: rect, cornerRadius: size.height * 0.36).cgPath
        blob.bounds = CGRect(origin: .zero, size: .zero)
        blob.position = center
        blob.setAffineTransform(CGAffineTransform(rotationAngle: degrees * .pi / 180))
    }
}
