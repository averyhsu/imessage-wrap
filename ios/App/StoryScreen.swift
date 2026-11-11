import MessageUI
import Messages
import SwiftUI
import UIKit

/// The story, full screen, inside the containing app.
struct StoryScreen: UIViewControllerRepresentable {
    let recap: Recap
    let onClose: () -> Void

    func makeCoordinator() -> Coordinator {
        return Coordinator(onClose: onClose)
    }

    func makeUIViewController(context: Context) -> StoryViewController {
        let story = StoryViewController(recap: recap)
        story.delegate = context.coordinator
        return story
    }

    func updateUIViewController(_ uiViewController: StoryViewController, context: Context) {
        context.coordinator.onClose = onClose
    }

    final class Coordinator: NSObject, StoryViewControllerDelegate, MFMessageComposeViewControllerDelegate {
        var onClose: () -> Void

        init(onClose: @escaping () -> Void) {
            self.onClose = onClose
            super.init()
        }

        func storyDidRequestClose(_ story: StoryViewController) {
            onClose()
        }

        /// "Send to this chat" inside the app: there is no conversation here, so open the
        /// system composer with the recap bubble attached and let the user pick the chat.
        /// Where iMessage is unavailable, fall back to sharing the story link.
        func storyDidRequestSend(_ story: StoryViewController) {
            let recap = story.recap
            guard let link = try? RecapLinkBuilder.fit(payload: recap.payload) else {
                return
            }
            guard story.presentedViewController == nil else {
                return
            }
            story.pause()

            if MFMessageComposeViewController.canSendText() {
                let composer = MFMessageComposeViewController()
                composer.messageComposeDelegate = self
                if let message = try? RecapMessageComposer.message(for: recap) {
                    composer.message = message
                } else {
                    composer.body = link.url.absoluteString
                }
                story.present(composer, animated: true, completion: nil)
                return
            }

            let sheet = UIActivityViewController(activityItems: [link.url], applicationActivities: nil)
            if let popover = sheet.popoverPresentationController {
                popover.sourceView = story.view
                popover.sourceRect = CGRect(x: story.view.bounds.midX, y: story.view.bounds.maxY - 80, width: 1, height: 1)
                popover.permittedArrowDirections = []
            }
            sheet.completionWithItemsHandler = { [weak story] (_: UIActivity.ActivityType?, _: Bool, _: [Any]?, _: Error?) in
                story?.resume()
            }
            story.present(sheet, animated: true, completion: nil)
        }

        func story(_ story: StoryViewController, didRequestOpen url: URL) {
            UIApplication.shared.open(url, options: [:], completionHandler: nil)
        }

        func messageComposeViewController(
            _ controller: MFMessageComposeViewController,
            didFinishWith result: MessageComposeResult
        ) {
            let presenter = controller.presentingViewController as? StoryViewController
            controller.dismiss(animated: true) {
                presenter?.resume()
            }
        }
    }
}
