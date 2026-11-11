import Messages
import SwiftUI
import UIKit

/// The iMessage app extension's single view controller.
///
/// Messages creates several instances of this class at the same time: one for the app's
/// own interface (compact, or expanded), and with live layout one more per recap bubble in
/// the transcript (`.transcript` style). Each instance shows exactly one of:
///
/// - compact:    the launcher (send the demo, paste a link, recent recaps)
/// - expanded:   the story for the selected recap, or a roomier launcher when there is none
/// - transcript: the live bubble (a light native view, never a web view)
///
/// Tap-to-play: a template bubble tap arrives as `didSelect` or as `selectedMessage` in
/// `willBecomeActive`. A live bubble gets no `didSelect`; it calls
/// `requestPresentationStyle(.expanded)`, which makes Messages create a *new* instance, so
/// the bubble also leaves the recap in `RecapStore` as a hand-off in case that new
/// instance has no `selectedMessage`.
final class MessagesViewController: MSMessagesAppViewController, StoryViewControllerDelegate {
    private let store = RecapStore.shared
    private let launcherModel = LauncherModel()

    private var contentController: UIViewController?
    private var contentConstraints: [NSLayoutConstraint] = []
    private var bubbleView: RecapBubbleView?
    private var bubbleRecap: Recap?

    /// The recap that is playing, or waiting for the expanded style to play.
    private var storyRecap: Recap?
    /// True once this activation has looked at `selectedMessage` / the hand-off.
    private var consumedLaunchRecap = false
    private var hasContent = false

    // MARK: View

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        launcherModel.onSendDemo = { [weak self] in
            self?.compose(DemoRecap.recap)
        }
        launcherModel.onPasteLink = { [weak self] in
            self?.pasteLink()
        }
        launcherModel.onPlay = { [weak self] (recap: Recap) in
            self?.play(recap)
        }
        launcherModel.onSend = { [weak self] (recap: Recap) in
            self?.compose(recap)
        }
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        // Safety net: if Messages showed the view without `willBecomeActive`, still draw.
        if !hasContent {
            updateContent(for: presentationStyle, conversation: activeConversation)
        }
    }

    // MARK: Conversation lifecycle

    override func willBecomeActive(with conversation: MSConversation) {
        super.willBecomeActive(with: conversation)
        consumedLaunchRecap = false
        updateContent(for: presentationStyle, conversation: conversation)
    }

    override func didBecomeActive(with conversation: MSConversation) {
        super.didBecomeActive(with: conversation)
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
        play(recap)
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
        updateContent(for: presentationStyle, conversation: activeConversation)
    }

    /// Size of the live bubble. Only called in the transcript style.
    override func contentSizeThatFits(_ size: CGSize) -> CGSize {
        return RecapBubbleView.preferredSize(fitting: size)
    }

    // MARK: Choosing what to show

    private func updateContent(for style: MSMessagesAppPresentationStyle, conversation: MSConversation?) {
        hasContent = true
        switch style {
        case .transcript:
            showBubble(for: conversation)
        case .expanded:
            if let recap = storyRecap ?? launchRecap(from: conversation) ?? store.takePendingPlay() {
                showStory(recap)
            } else {
                showLauncher(roomy: true)
            }
        case .compact:
            showLauncher(roomy: false)
            if storyRecap == nil, let recap = launchRecap(from: conversation) {
                play(recap)
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

    private func play(_ recap: Recap) {
        storyRecap = recap
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
    }

    private func showStory(_ recap: Recap) {
        storyRecap = recap
        store.remember(recap)
        if let current = contentController as? StoryViewController, current.recap == recap {
            return
        }
        let story = StoryViewController(recap: recap)
        story.delegate = self
        // In the expanded style Messages draws its own header over the top of this view;
        // the safe area tells us where it ends.
        install(story, belowTopSafeArea: true)
    }

    private func showBubble(for conversation: MSConversation?) {
        removeContent()
        let recap = RecapMessageComposer.recap(from: conversation?.selectedMessage)
        bubbleRecap = recap
        if let recap = recap {
            store.remember(recap)
        }

        let bubble = RecapBubbleView(frame: view.bounds)
        bubble.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        bubble.configure(with: recap?.summary)
        bubble.onTap = { [weak self] in
            self?.bubbleTapped()
        }
        view.addSubview(bubble)
        bubbleView = bubble
    }

    private func bubbleTapped() {
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
    private func compose(_ recap: Recap) {
        guard let conversation = activeConversation else {
            launcherModel.notice = "Open a conversation to send a recap."
            return
        }
        let message: MSMessage
        do {
            message = try RecapMessageComposer.message(for: recap)
        } catch {
            let reason = (error as? LocalizedError)?.errorDescription
            launcherModel.notice = reason ?? "This recap could not be sent."
            return
        }

        store.remember(recap)
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
        compose(story.recap)
    }

    func storyDidRequestClose(_ story: StoryViewController) {
        storyRecap = nil
        requestPresentationStyle(.compact)
    }

    func story(_ story: StoryViewController, didRequestOpen url: URL) {
        // An extension cannot open web links; the story is self-contained, so ignore them.
    }
}
