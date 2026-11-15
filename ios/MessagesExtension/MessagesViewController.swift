import Messages
import SwiftUI
import UIKit

/// The iMessage app extension's single view controller.
///
/// Messages creates several instances of this class at the same time: one for the app's
/// own interface (compact, or expanded), and with live layout one more per recap bubble in
/// the transcript (`.transcript` style). Each instance shows exactly one of:
///
/// - compact:    the launcher (paste a recap link, recaps the user made, see a sample)
/// - expanded:   the story for the selected recap, or a roomier launcher when there is none
/// - transcript: the experimental live bubble (a light native view, never a web view)
///
/// Tap-to-play: a card tap arrives as `didSelect` or as `selectedMessage` in
/// `willBecomeActive`. A live bubble gets no `didSelect`; it calls
/// `requestPresentationStyle(.expanded)`, which makes Messages create a *new* instance, so
/// the bubble also leaves the recap in `RecapStore` as a hand-off in case that new
/// instance has no `selectedMessage`.
///
/// What is remembered: only recaps the user pasted or sent from here. A recap that merely
/// arrived in a conversation is played, never stored or offered for sending elsewhere.
final class MessagesViewController: MSMessagesAppViewController, StoryViewControllerDelegate {
    private let store = RecapStore.shared
    private let launcherModel = LauncherModel()

    private var contentController: UIViewController?
    private var contentConstraints: [NSLayoutConstraint] = []
    private var bubbleView: RecapBubbleView?
    private var bubbleRecap: Recap?

    /// The recap that is playing, or waiting for the expanded style to play.
    private var storyRecap: Recap?
    /// True when that recap came out of a message in the conversation (someone sent it),
    /// false when the user picked it in the launcher. A recap that arrived in a
    /// conversation is never added to "Your recaps", even if it is sent on from the story.
    private var storyIsFromConversation = false
    /// True once this activation has looked at `selectedMessage` / the hand-off.
    private var consumedLaunchRecap = false
    private var hasContent = false
    private let createdAt = Date()
    /// Which lifecycle call led to the current content (debug notes only).
    private var updateReason = "initial"
    private var bubbleNotes: [String] = []

    // MARK: View

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        #if DEBUG
        // Debug builds expose the story's bridge status as an invisible accessibility
        // label, so UI tests can tell that the story really plays inside Messages.
        StoryViewController.showsBridgeStatusForTesting = true
        #endif

        launcherModel.onPasteLink = { [weak self] in
            self?.pasteLink()
        }
        launcherModel.onSeeSample = { [weak self] in
            // Plays the built-in sample. Nothing is staged in the conversation.
            self?.play(DemoRecap.recap, fromConversation: false)
        }
        launcherModel.onClearRecents = { [weak self] in
            self?.clearRecents()
        }
        launcherModel.onSendDemoWithLayout = { [weak self] (live: Bool) in
            self?.compose(DemoRecap.recap, live: live)
        }
        launcherModel.onPlay = { [weak self] (recap: Recap) in
            self?.play(recap, fromConversation: false)
        }
        launcherModel.onSend = { [weak self] (recap: Recap) in
            self?.compose(recap)
        }
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        // Safety net: if Messages showed the view without `willBecomeActive`, still draw.
        if !hasContent {
            updateReason = "viewWillAppear"
            updateContent(for: presentationStyle, conversation: activeConversation)
        }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        refreshBubble(reason: "viewDidAppear")
    }

    // MARK: Conversation lifecycle

    override func willBecomeActive(with conversation: MSConversation) {
        super.willBecomeActive(with: conversation)
        consumedLaunchRecap = false
        updateReason = "willBecomeActive"
        updateContent(for: presentationStyle, conversation: conversation)
    }

    override func didBecomeActive(with conversation: MSConversation) {
        super.didBecomeActive(with: conversation)
        refreshBubble(reason: "didBecomeActive")
        // A request made from `willBecomeActive` can come too early to be honoured.
        if storyRecap != nil, presentationStyle == .compact {
            requestPresentationStyle(.expanded)
        }
    }

    override func didSelect(_ message: MSMessage, conversation: MSConversation) {
        super.didSelect(message, conversation: conversation)
        guard presentationStyle != .transcript,
              let recap = RecapMessageComposer.recap(from: message) else {
            return
        }
        play(recap, fromConversation: true)
    }

    override func willTransition(to presentationStyle: MSMessagesAppPresentationStyle) {
        super.willTransition(to: presentationStyle)
        // Leaving the expanded style: drop the story now so it is not squeezed into the
        // keyboard-sized area during the animation.
        if presentationStyle == .compact, contentController is StoryViewController {
            storyRecap = nil
            showLauncher(roomy: false)
        }
    }

    override func didTransition(to presentationStyle: MSMessagesAppPresentationStyle) {
        super.didTransition(to: presentationStyle)
        if presentationStyle == .compact {
            storyRecap = nil
        }
        updateReason = "didTransition"
        updateContent(for: presentationStyle, conversation: activeConversation)
    }

    /// Size of the live bubble. Only called in the transcript style, possibly several times.
    override func contentSizeThatFits(_ size: CGSize) -> CGSize {
        if bubbleView != nil, bubbleRecap == nil {
            DispatchQueue.main.async { [weak self] in
                self?.refreshBubble(reason: "contentSizeThatFits")
            }
        }
        return RecapBubbleView.preferredSize(fitting: size)
    }

    // MARK: Choosing what to show

    private func updateContent(for style: MSMessagesAppPresentationStyle, conversation: MSConversation?) {
        hasContent = true
        switch style {
        case .transcript:
            showBubble(for: conversation, reason: updateReason)
        case .expanded:
            if let recap = storyRecap {
                showStory(recap)
            } else if let recap = launchRecap(from: conversation) ?? store.takePendingPlay() {
                storyIsFromConversation = true
                showStory(recap)
            } else {
                showLauncher(roomy: true)
            }
        case .compact:
            showLauncher(roomy: false)
            if storyRecap == nil, let recap = launchRecap(from: conversation) {
                play(recap, fromConversation: true)
            }
        @unknown default:
            showLauncher(roomy: false)
        }
    }

    /// The recap this activation was opened for: the selected message's, or the hand-off
    /// left by a live bubble. Answered once per activation so closing the story does not
    /// immediately reopen it.
    private func launchRecap(from conversation: MSConversation?) -> Recap? {
        guard !consumedLaunchRecap else {
            return nil
        }
        consumedLaunchRecap = true
        if let recap = RecapMessageComposer.recap(from: conversation?.selectedMessage) {
            return recap
        }
        return store.takePendingPlay()
    }

    private func play(_ recap: Recap, fromConversation: Bool) {
        storyRecap = recap
        storyIsFromConversation = fromConversation
        if presentationStyle == .expanded {
            showStory(recap)
        } else {
            requestPresentationStyle(.expanded)
        }
    }

    // MARK: Content

    private func showLauncher(roomy: Bool) {
        launcherModel.isRoomy = roomy
        launcherModel.recents = store.recents()
        if contentController is UIHostingController<LauncherView> {
            return
        }
        let host = UIHostingController(rootView: LauncherView(model: launcherModel))
        host.view.backgroundColor = .black
        install(host, belowTopSafeArea: false)

        // Start the story's web view now, while the person looks at the launcher, so a
        // story opens without waiting for a web process and a page load.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
            self?.prewarmStory()
        }
    }

    private func prewarmStory() {
        guard presentationStyle != .transcript else {
            return
        }
        // It waits, invisible, at the back of this view until a story takes it.
        StoryWebViewPool.prewarm(in: view)
    }

    private func clearRecents() {
        store.clear()
        launcherModel.recents = []
        launcherModel.notice = nil
    }

    private func showStory(_ recap: Recap) {
        storyRecap = recap
        if let current = contentController as? StoryViewController, current.recap == recap {
            return
        }
        let story = StoryViewController(recap: recap)
        story.delegate = self
        // Full bleed: in the expanded style Messages draws its grabber (and on older
        // systems a header) over the top of this view. The page pads its own controls by
        // the safe-area inset, so its background can run all the way to the top edge.
        install(story, belowTopSafeArea: false)
    }

    /// The recap a live bubble should show: the one its message carries. If Messages gave
    /// this instance no message at all and a recap was staged from this extension a moment
    /// before the instance was created, it is the bubble of that staged recap.
    private func recapForBubble(_ message: MSMessage?) -> Recap? {
        if let recap = RecapMessageComposer.recap(from: message) {
            return recap
        }
        if message == nil,
           let composed = store.lastComposed(),
           createdAt >= composed.date {
            return composed.recap
        }
        return nil
    }

    private func showBubble(for conversation: MSConversation?, reason: String) {
        removeContent()
        let message = conversation?.selectedMessage
        let recap = recapForBubble(message)
        bubbleRecap = recap

        let bubble = RecapBubbleView(frame: view.bounds)
        bubble.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        bubble.configure(with: recap?.summary, eyebrow: recap?.eyebrow)
        bubble.onTap = { [weak self] in
            self?.bubbleTapped()
        }
        view.addSubview(bubble)
        bubbleView = bubble
        noteBubbleState(reason, message: message, recap: recap)

        // Messages does not always hand a transcript instance its message by the time
        // `willBecomeActive` runs, so keep looking for a little while.
        if recap == nil {
            let delays: [TimeInterval] = [0.15, 0.5, 1.2, 2.5, 5.0]
            for delay in delays {
                DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                    self?.refreshBubble(reason: "retry+\(delay)s")
                }
            }
        }
    }

    /// Fills in a live bubble that was drawn before its message was available.
    private func refreshBubble(reason: String) {
        guard let bubble = bubbleView, bubbleRecap == nil else {
            return
        }
        let message = activeConversation?.selectedMessage
        let recap = recapForBubble(message)
        noteBubbleState(reason, message: message, recap: recap)
        guard let found = recap else {
            return
        }
        bubbleRecap = found
        bubble.configure(with: found.summary, eyebrow: found.eyebrow)
    }

    /// Debug builds record how a live bubble found (or did not find) its message, as the
    /// bubble's accessibility value. UI tests and the debugger can read it.
    private func noteBubbleState(_ reason: String, message: MSMessage?, recap: Recap?) {
        #if DEBUG
        let length = message?.url?.absoluteString.count ?? 0
        let fromMessage = RecapMessageComposer.recap(from: message) != nil
        let entry = "\(reason): conversation=\(activeConversation != nil) selected=\(message != nil)"
            + " url=\(message?.url != nil) length=\(length) fragment=\(message?.url?.fragment != nil)"
            + " recap=\(recap != nil) fromMessage=\(fromMessage)"
        bubbleNotes.append(entry)
        if bubbleNotes.count > 6 {
            bubbleNotes.removeFirst()
        }
        bubbleView?.accessibilityValue = bubbleNotes.joined(separator: " | ")
        #endif
    }

    private func bubbleTapped() {
        refreshBubble(reason: "tap")
        if let recap = bubbleRecap {
            store.setPendingPlay(recap)
        }
        requestPresentationStyle(.expanded)
    }

    private func install(_ controller: UIViewController, belowTopSafeArea: Bool) {
        removeContent()
        addChild(controller)
        controller.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(controller.view)
        let top: NSLayoutConstraint
        if belowTopSafeArea {
            top = controller.view.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor)
        } else {
            top = controller.view.topAnchor.constraint(equalTo: view.topAnchor)
        }
        contentConstraints = [
            top,
            controller.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            controller.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            controller.view.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ]
        NSLayoutConstraint.activate(contentConstraints)
        controller.didMove(toParent: self)
        contentController = controller
    }

    private func removeContent() {
        if let controller = contentController {
            // A story hands its web view back, ready for the next one.
            (controller as? StoryViewController)?.releaseWebView()
            controller.willMove(toParent: nil)
            NSLayoutConstraint.deactivate(contentConstraints)
            contentConstraints = []
            controller.view.removeFromSuperview()
            controller.removeFromParent()
            contentController = nil
        }
        bubbleView?.removeFromSuperview()
        bubbleView = nil
    }

    // MARK: Actions

    /// Stages a recap bubble in the conversation's input field. The user taps send.
    /// `remember` is false for a recap that arrived in a conversation: sending it on does
    /// not add it to "Your recaps".
    private func compose(_ recap: Recap, live: Bool = WrappedConfig.useLiveLayout, remember: Bool = true) {
        guard let conversation = activeConversation else {
            launcherModel.notice = "Open a conversation to send a recap."
            return
        }
        let message: MSMessage
        do {
            message = try RecapMessageComposer.message(for: recap, live: live)
        } catch {
            let reason = (error as? LocalizedError)?.errorDescription
            launcherModel.notice = reason ?? "This recap could not be sent."
            return
        }

        if remember {
            store.remember(recap)
        }
        if live {
            // Only the experimental live bubble needs this hand-off (see `recapForBubble`).
            store.setLastComposed(recap)
        }
        launcherModel.notice = nil
        conversation.insert(message) { [weak self] (error: Error?) in
            guard let error = error else {
                return
            }
            let text = "Messages could not add the recap. \(error.localizedDescription)"
            DispatchQueue.main.async {
                self?.launcherModel.notice = text
            }
        }

        if presentationStyle == .expanded {
            storyRecap = nil
            requestPresentationStyle(.compact)
        } else {
            launcherModel.recents = store.recents()
        }
    }

    /// Reads a recap link from the clipboard and stages it.
    private func pasteLink() {
        let pasteboard = UIPasteboard.general
        var text: String?
        if pasteboard.hasURLs, let url = pasteboard.url {
            text = url.absoluteString
        } else if pasteboard.hasStrings {
            text = pasteboard.string
        }
        guard let found = text, let recap = RecapLink.recap(inText: found) else {
            launcherModel.notice = "No recap link on the clipboard. Copy a recap link, then tap Paste again."
            return
        }
        compose(recap)
    }

    // MARK: StoryViewControllerDelegate

    func storyDidRequestSend(_ story: StoryViewController) {
        compose(story.recap, remember: !storyIsFromConversation)
    }

    func storyDidRequestClose(_ story: StoryViewController) {
        storyRecap = nil
        requestPresentationStyle(.compact)
    }

    func story(_ story: StoryViewController, didRequestOpen url: URL) {
        // An extension cannot open web links; the story is self-contained, so ignore them.
    }
}
