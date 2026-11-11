import UIKit
import XCTest

/// The REAL extension inside the Simulator's Messages app.
///
/// `testCardFlowInsideMessages` is the product: open a conversation, open the app drawer,
/// launch the extension, paste a recap link, send the card, tap it and watch the story play
/// in the expanded style, close it, see the recap under "Your recaps", play the sample
/// (which stages nothing) and clear the list. Its screenshots are named `messages-…`.
///
/// `testSampleSentFromItsStoryIsLabelledInsideMessages`: "See a sample", through to the
/// story's last slide, "Send to this chat": the card that is staged and sent says "Sample".
///
/// `testExperimentalLiveLayoutInsideMessages` exercises the live bubble layout, which is
/// experimental and off by default (`WrappedConfig.useLiveLayout`). Its screenshots are
/// named `experimental-live-…` and are not part of the product.
///
/// Apple documents no automation for Messages, so these drive `com.apple.MobileSMS` by its
/// accessibility tree as found on iOS 26 (the "add" button, the drawer list, "sendButton").
/// Every step is screenshotted and its hierarchy dumped; CI runs each test in its own step
/// that is allowed to fail, and the main test run skips this class.
final class MessagesExtensionUITests: XCTestCase {
    private let messages = XCUIApplication(bundleIdentifier: "com.apple.MobileSMS")
    private let productName = "Threadback"

    override func setUpWithError() throws {
        continueAfterFailure = true
    }

    // MARK: Helpers

    private func pause(_ seconds: TimeInterval) {
        Thread.sleep(forTimeInterval: seconds)
    }

    /// Screenshot plus accessibility dump, both under the same name.
    private func checkpoint(_ name: String) {
        UIArtifacts.snap(name, in: self)
        UIArtifacts.dumpToFile(messages, name: name)
    }

    private func anyElement(labelContaining text: String) -> XCUIElement {
        let predicate = NSPredicate(format: "label CONTAINS[c] %@ OR identifier CONTAINS[c] %@", text, text)
        return messages.descendants(matching: .any).matching(predicate).firstMatch
    }

    /// Taps the first candidate that exists and is hittable. Returns whether one was tapped.
    private func tapFirst(_ what: String, _ candidates: [XCUIElement], timeout: TimeInterval = 4) -> Bool {
        let deadline = UIArtifacts.uptime() + timeout
        repeat {
            for (index, candidate) in candidates.enumerated() where candidate.exists {
                if candidate.isHittable {
                    UIArtifacts.note("messages: \(what): tapping candidate #\(index) id='\(candidate.identifier)' label='\(candidate.label)'")
                    candidate.tap()
                    return true
                }
            }
            pause(0.5)
        } while UIArtifacts.uptime() < deadline
        UIArtifacts.note("messages: \(what): no candidate found")
        return false
    }

    private func dismissInterruptions() {
        for label in ["Continue", "OK", "Not Now", "Skip", "Close", "Done"] {
            let button = messages.buttons[label]
            if button.exists, button.isHittable {
                UIArtifacts.note("messages: dismissing '\(label)'")
                button.tap()
                pause(1)
            }
        }
    }

    /// The story's bridge status inside Messages ("ready 12 (ready in 0.6s)", "slide 2/12 …",
    /// "loaded, not ready: …", "error: …"). Debug builds of the extension expose it as
    /// the invisible label `story.bridge`.
    private func waitForStory(timeout: TimeInterval, until matches: (String) -> Bool) -> String {
        let label = messages.staticTexts["story.bridge"]
        let deadline = UIArtifacts.uptime() + timeout
        var last = "(no story.bridge element)"
        while UIArtifacts.uptime() < deadline {
            if label.exists {
                last = label.label
                if matches(last) {
                    return last
                }
            }
            pause(0.5)
        }
        return last
    }

    private func isPlaying(_ status: String) -> Bool {
        return status.hasPrefix("ready") || status.hasPrefix("slide")
    }

    /// Registers the extension (the containing app must have run once), opens Messages and
    /// a conversation, opens the app drawer and launches our extension in compact style.
    /// Returns false, after recording failures, if any step could not be done.
    /// With `prefix` nil the steps on the way are not screenshotted (failures still are).
    private func openLauncherInConversation(_ index: Int, prefix givenPrefix: String?) -> Bool {
        let prefix = givenPrefix ?? "messages-opening-"
        let record = givenPrefix != nil
        let app = XCUIApplication()
        app.launch()
        _ = app.staticTexts["home.title"].waitForExistence(timeout: 30)
        app.terminate()

        messages.launch()
        let foreground = messages.wait(for: .runningForeground, timeout: 30)
        UIArtifacts.note("messages: foreground=\(foreground)")
        pause(2)
        dismissInterruptions()
        pause(1)

        // Messages may come back in a conversation or in a "New Message" sheet (seen when
        // it is relaunched; the Simulator also resets its simulated chats then). Get to
        // the conversation list first.
        let entryField = messages.textFields["messageBodyField"]
        for _ in 0..<3 {
            let compose = messages.navigationBars["CKComposeChat"].buttons["Cancel"]
            if compose.exists, compose.isHittable {
                UIArtifacts.note("messages: closing the New Message sheet")
                compose.tap()
                pause(1.5)
            } else if messages.buttons["BackButton"].exists, messages.buttons["BackButton"].isHittable {
                UIArtifacts.note("messages: leaving the open conversation")
                messages.buttons["BackButton"].tap()
                pause(1.5)
            } else {
                break
            }
        }
        if record {
            checkpoint(prefix + "01-conversation-list")
        }

        let cell = messages.cells.element(boundBy: index)
        guard cell.waitForExistence(timeout: 8) else {
            XCTFail("no conversation #\(index) in the Simulator's Messages app")
            return false
        }
        UIArtifacts.note("messages: opening conversation '\(cell.label)'")
        cell.tap()
        pause(2)
        dismissInterruptions()
        _ = entryField.waitForExistence(timeout: 10)

        // The "+" next to the text field (button "add" on iOS 26) opens the app drawer.
        let openedDrawer = tapFirst("app drawer", [
            messages.buttons["add"],
            messages.otherElements["MessageEntryView"].buttons.firstMatch,
            messages.buttons["Apps"],
            messages.buttons["browserButton"]
        ], timeout: 8)
        guard openedDrawer else {
            checkpoint(prefix + "02-no-app-drawer")
            XCTFail("could not open the Messages app drawer")
            return false
        }
        pause(2)

        // Third-party apps sit below the built-in ones.
        var ours = anyElement(labelContaining: productName)
        var swipes = 0
        while !(ours.exists && ours.isHittable) && swipes < 3 {
            messages.swipeUp()
            pause(1.2)
            swipes += 1
            ours = anyElement(labelContaining: productName)
        }
        guard ours.exists else {
            checkpoint(prefix + "02-app-drawer-without-us")
            XCTFail("'\(productName)' is not in the Messages app drawer")
            return false
        }
        UIArtifacts.note("messages: our app in the drawer: id='\(ours.identifier)' label='\(ours.label)' after \(swipes) swipe(s)")
        if record {
            checkpoint(prefix + "02-app-drawer")
        }
        if ours.isHittable {
            ours.tap()
        } else {
            ours.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        }

        let sawLauncher = messages.buttons["launcher.paste"].waitForExistence(timeout: 25)
        UIArtifacts.note("messages: launcher visible=\(sawLauncher)")
        XCTAssertTrue(sawLauncher, "our launcher did not appear inside Messages")
        pause(1)
        if record || !sawLauncher {
            checkpoint(prefix + "03-launcher")
        }
        return sawLauncher
    }

    /// Whether Messages shows a staged bubble (its send button appears).
    private func waitForStagedBubble(timeout: TimeInterval) -> Bool {
        return messages.buttons["sendButton"].waitForExistence(timeout: timeout)
    }

    /// Screenshots the staged bubble and sends it.
    private func sendStagedBubble(named name: String) {
        pause(2)
        checkpoint(name)
        messages.buttons["sendButton"].tap()
    }

    /// Waits for the story to report over the bridge, screenshots it, taps through two
    /// more slides and uses the page's close control. `names` are the four checkpoints:
    /// story, next slide, another slide, after close.
    private func watchStoryPlay(names: [String]) {
        let status = waitForStory(timeout: 90) { status in
            return self.isPlaying(status) || status.hasPrefix("error")
        }
        UIArtifacts.note("messages: story bridge status after the tap: \(status)")
        pause(2.5)
        checkpoint(names[0])
        XCTAssertTrue(isPlaying(status), "the story never reported ready inside Messages (last status: \(status))")
        guard isPlaying(status) else {
            return
        }

        // Tap the right side of the story to move on, as a person would.
        let next = messages.coordinate(withNormalizedOffset: CGVector(dx: 0.86, dy: 0.55))
        var seen: [String] = [status]
        for step in 1...2 {
            next.tap()
            pause(2.2)
            seen.append(waitForStory(timeout: 3) { _ in
                return true
            })
            checkpoint(names[step])
        }
        UIArtifacts.note("messages: story bridge statuses while tapping: \(seen)")
        closeStory()
        pause(1.5)
        checkpoint(names[3])
    }

    /// "slide 3/12 (…)" → (3, 12)
    private func slidePosition(_ status: String) -> (index: Int, total: Int)? {
        guard status.hasPrefix("slide ") else {
            return nil
        }
        let head = status.dropFirst("slide ".count).prefix(while: { (character: Character) -> Bool in
            return character != " "
        })
        let parts = head.split(separator: "/")
        guard parts.count == 2, let index = Int(parts[0]), let total = Int(parts[1]) else {
            return nil
        }
        return (index, total)
    }

    /// A control inside the story page (the page is accessible to UI tests like any view).
    private func storyButton(_ label: String) -> XCUIElement {
        return messages.webViews.buttons[label].firstMatch
    }

    /// The page's own close control (top right) asks native to return to compact.
    @discardableResult
    private func closeStory() -> Bool {
        let close = storyButton("Close")
        if close.exists, close.isHittable {
            close.tap()
        } else {
            UIArtifacts.note("messages: the story's Close button was not found by its label; tapping its place")
            messages.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.151)).tap()
        }
        let backToCompact = messages.buttons["launcher.paste"].waitForExistence(timeout: 12)
        UIArtifacts.note("messages: the story's close control returned to the compact launcher=\(backToCompact)")
        return backToCompact
    }

    // MARK: The product: paste a recap link, send the card, tap it

    func testCardFlowInsideMessages() throws {
        // What a person does first: copy their recap link somewhere else.
        UIPasteboard.general.string = TestRecap.link
        defer {
            UIPasteboard.general.string = ""
        }
        guard openLauncherInConversation(0, prefix: "messages-") else {
            return
        }

        // Paste it. iOS asks before an app reads what another app copied.
        messages.buttons["launcher.paste"].tap()
        let asked = PastePermission.allowIfAsked(app: messages, in: self, snapshotName: "messages-04-ios-asks-before-pasting")
        UIArtifacts.note("messages: iOS asked for permission to paste=\(asked)")
        let pasted = waitForStagedBubble(timeout: 15)
        UIArtifacts.note("messages: card staged by pasting the link=\(pasted)")
        if !pasted {
            checkpoint("messages-05-paste-did-not-stage")
            let notice = messages.staticTexts["launcher.notice"]
            UIArtifacts.note("messages: launcher notice after paste='\(notice.exists ? notice.label : "(none)")'")
            XCTFail("pasting the recap link did not stage a card")
            // Carry on with the sample card, staged by a debug-only control, so the rest
            // of the flow is still exercised.
            let hook = messages.buttons["launcher.sendDemoTemplate"]
            guard hook.waitForExistence(timeout: 5) else {
                return
            }
            hook.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
            guard waitForStagedBubble(timeout: 15) else {
                XCTFail("no card was staged in the input field")
                return
            }
        }
        sendStagedBubble(named: "messages-05-card-staged")
        pause(5)
        checkpoint("messages-06-card-sent")

        // The card is Messages' own bubble; its label carries our caption and subcaption
        // ("Sunday Hikers · 2026 in review, 13,018 messages · Tap to play, 1 image"). The
        // launcher below it lists the same recap, so match on both parts. The newest card
        // is the last match.
        let predicate = NSPredicate(
            format: "label CONTAINS[c] %@ AND label CONTAINS[c] %@ AND identifier != %@",
            "in review", "Tap to play", "bubble.recap"
        )
        let cards = messages.descendants(matching: .any).matching(predicate)
        let sawCard = cards.firstMatch.waitForExistence(timeout: 10)
        if sawCard {
            let card = cards.element(boundBy: max(0, cards.count - 1))
            UIArtifacts.note("messages: card: \(cards.count) match(es), tapping type=\(card.elementType.rawValue) id='\(card.identifier)' label='\(card.label)'")
            if pasted {
                XCTAssertTrue(card.label.contains(TestRecap.chatName), "the card should carry the pasted recap's caption, but reads '\(card.label)'")
                XCTAssertFalse(card.label.contains("Sample"), "a person's own recap is not labelled as a sample")
            }
            if card.isHittable {
                card.tap()
            } else {
                card.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.4)).tap()
            }
        } else {
            // No element carries the caption: tap the newest bubble in the transcript.
            let bubbles = messages.collectionViews["TranscriptCollectionView"].cells
            let count = bubbles.count
            UIArtifacts.note("messages: card not found by its caption; tapping the last of \(count) transcript cell(s)")
            XCTAssertGreaterThan(count, 0, "the card did not appear in the transcript")
            guard count > 0 else {
                return
            }
            bubbles.element(boundBy: count - 1).coordinate(withNormalizedOffset: CGVector(dx: 0.7, dy: 0.4)).tap()
        }
        watchStoryPlay(names: [
            "messages-07-story-plays",
            "messages-08-story-next-slide",
            "messages-09-story-another-slide",
            "messages-10-closed-recap-is-kept"
        ])

        // The recap the person pasted and sent is now under "Your recaps".
        let row = messages.buttons["recents.play"]
        if pasted {
            let listed = row.waitForExistence(timeout: 8)
            UIArtifacts.note("messages: the sent recap is listed under Your recaps=\(listed) label='\(listed ? row.label : "")'")
            XCTAssertTrue(listed, "the recap that was pasted and sent should be listed in the launcher")
        }

        // "See a sample" plays the built-in sample and puts nothing into the conversation.
        let sample = messages.buttons["launcher.seeSample"]
        guard sample.waitForExistence(timeout: 8) else {
            XCTFail("the launcher has no 'See a sample' control")
            return
        }
        sample.tap()
        let sampleStatus = waitForStory(timeout: 90) { status in
            return self.isPlaying(status) || status.hasPrefix("error")
        }
        UIArtifacts.note("messages: sample story bridge status: \(sampleStatus)")
        pause(2.5)
        checkpoint("messages-11-sample-plays")
        XCTAssertTrue(isPlaying(sampleStatus), "the sample did not play (last status: \(sampleStatus))")
        closeStory()
        pause(1.5)
        let stagedBySample = messages.buttons["sendButton"].exists
        UIArtifacts.note("messages: seeing the sample staged a message=\(stagedBySample)")
        XCTAssertFalse(stagedBySample, "seeing the sample must not put anything into the conversation")

        // Clear forgets the recaps.
        let clear = messages.buttons["recents.clear"]
        if pasted, clear.waitForExistence(timeout: 5) {
            clear.tap()
            pause(1.5)
            let stillListed = messages.buttons["recents.play"].exists
            UIArtifacts.note("messages: a recap is still listed after Clear=\(stillListed)")
            XCTAssertFalse(stillListed, "Clear should forget the recaps")
            checkpoint("messages-12-your-recaps-cleared")
        }
    }

    // MARK: The sample, sent from inside its story, says "Sample"

    func testSampleSentFromItsStoryIsLabelledInsideMessages() throws {
        guard openLauncherInConversation(0, prefix: nil) else {
            return
        }
        let sample = messages.buttons["launcher.seeSample"]
        guard sample.waitForExistence(timeout: 8) else {
            XCTFail("the launcher has no 'See a sample' control")
            return
        }
        sample.tap()
        var status = waitForStory(timeout: 90) { status in
            return self.isPlaying(status) || status.hasPrefix("error")
        }
        UIArtifacts.note("messages: sample story bridge status: \(status)")
        XCTAssertTrue(isPlaying(status), "the sample did not play (last status: \(status))")
        guard isPlaying(status) else {
            checkpoint("messages-sample-1-did-not-play")
            return
        }

        // Go to the last slide with the page's own "Next slide" control.
        var presses = 0
        while presses < 24 {
            status = waitForStory(timeout: 2) { _ in
                return true
            }
            if let position = slidePosition(status), position.index >= position.total - 1 {
                break
            }
            let next = storyButton("Next slide")
            if next.exists, next.isHittable {
                next.tap()
            } else {
                messages.coordinate(withNormalizedOffset: CGVector(dx: 0.86, dy: 0.55)).tap()
            }
            presses += 1
            pause(0.6)
        }
        UIArtifacts.note("messages: sample story after \(presses) press(es) of Next: \(status)")

        let send = storyButton("Send to this chat")
        let sawSend = send.waitForExistence(timeout: 10)
        pause(1.5)
        checkpoint("messages-sample-1-last-slide")
        XCTAssertTrue(sawSend, "the story's last slide has no 'Send to this chat' (last status: \(status))")
        guard sawSend else {
            return
        }
        send.tap()

        let staged = waitForStagedBubble(timeout: 15)
        UIArtifacts.note("messages: the sample was staged from its story=\(staged)")
        XCTAssertTrue(staged, "'Send to this chat' did not stage a card")
        guard staged else {
            checkpoint("messages-sample-2-nothing-staged")
            return
        }
        pause(2)
        let labelled = NSPredicate(format: "label CONTAINS[c] %@ AND label CONTAINS[c] %@", "Sample · ", "in review")
        let stagedCard = messages.descendants(matching: .any).matching(labelled).firstMatch
        let stagedSaysSample = stagedCard.waitForExistence(timeout: 5)
        UIArtifacts.note("messages: the staged card says Sample=\(stagedSaysSample) label='\(stagedSaysSample ? stagedCard.label : "")'")
        checkpoint("messages-sample-2-staged-card-says-sample")
        XCTAssertTrue(stagedSaysSample, "the staged sample card should say Sample in its caption")

        messages.buttons["sendButton"].tap()
        pause(5)
        let sentCard = messages.descendants(matching: .any).matching(labelled).firstMatch
        let sentSaysSample = sentCard.waitForExistence(timeout: 8)
        UIArtifacts.note("messages: the sent card says Sample=\(sentSaysSample) label='\(sentSaysSample ? sentCard.label : "")'")
        checkpoint("messages-sample-3-sent-card-says-sample")
        XCTAssertTrue(sentSaysSample, "the sent sample card should say Sample in its caption")

        // The sample is never kept among the person's recaps.
        let keptSample = NSPredicate(format: "identifier == %@ AND label CONTAINS[c] %@", "recents.play", "Dinner Club")
        let kept = messages.buttons.matching(keptSample).firstMatch.exists
        UIArtifacts.note("messages: the sample is listed under Your recaps=\(kept)")
        XCTAssertFalse(kept, "the sample must not be listed under Your recaps")
    }

    // MARK: Experimental (off by default): the live bubble layout

    func testExperimentalLiveLayoutInsideMessages() throws {
        let prefix = "experimental-live-"
        guard openLauncherInConversation(0, prefix: prefix) else {
            return
        }
        // A debug-only control stages the sample as a live bubble whatever the default
        // layout is (`WrappedConfig.useLiveLayout`).
        let hook = messages.buttons["launcher.sendDemoLive"]
        guard hook.waitForExistence(timeout: 5) else {
            XCTFail("the debug control for live bubbles is missing")
            return
        }
        hook.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        let staged = waitForStagedBubble(timeout: 15)
        UIArtifacts.note("messages: live bubble staged (send button present)=\(staged)")
        XCTAssertTrue(staged, "no bubble was staged in the input field")
        guard staged else {
            return
        }
        sendStagedBubble(named: prefix + "04-bubble-staged")

        let bubble = messages.buttons["bubble.recap"]
        let sawBubble = bubble.waitForExistence(timeout: 20)
        pause(4)
        checkpoint(prefix + "05-bubble-sent")
        XCTAssertTrue(sawBubble, "the live recap bubble did not appear in the transcript")
        guard sawBubble else {
            return
        }
        let bubbleLabel = bubble.label
        UIArtifacts.note("messages: live bubble label='\(bubbleLabel)'")
        UIArtifacts.note("messages: live bubble notes='\(String(describing: bubble.value))'")
        XCTAssertTrue(
            bubbleLabel.contains("Dinner Club") && bubbleLabel.contains("48,213"),
            "the live bubble should show the recap itself, but it reads '\(bubbleLabel)'"
        )

        bubble.tap()
        watchStoryPlay(names: [
            prefix + "06-story-plays",
            prefix + "07-story-next-slide",
            prefix + "08-story-another-slide",
            prefix + "09-after-close"
        ])

        // The Simulator's two conversations are the two ends of one simulated chat: what
        // was sent in one arrives in the other. That bubble is drawn by a transcript
        // instance that did not compose it, which is what a recipient's phone does.
        // (More than 30 s have passed, so the "just composed" shortcut cannot apply.)
        let sentFrom = messages.buttons["ConversationTitle"].label
        _ = messages.buttons["BackButton"].tapIfExists(timeout: 5)
        pause(2)
        var otherEnd: XCUIElement?
        for index in 0..<min(messages.cells.count, 4) {
            let cell = messages.cells.element(boundBy: index)
            if cell.exists, !sentFrom.isEmpty, !cell.label.contains(sentFrom) {
                otherEnd = cell
                break
            }
        }
        guard let other = otherEnd else {
            UIArtifacts.note("messages: other end of the chat: no second conversation found (sent from '\(sentFrom)')")
            return
        }
        UIArtifacts.note("messages: other end of the chat: opening '\(other.label)'")
        other.tap()
        pause(5)
        checkpoint(prefix + "10-other-end-of-the-chat")
        let received = messages.buttons["bubble.recap"]
        let sawReceived = received.waitForExistence(timeout: 10)
        UIArtifacts.note("messages: received live bubble present=\(sawReceived)")
        guard sawReceived else {
            return
        }
        pause(6)
        UIArtifacts.note("messages: received live bubble label='\(received.label)'")
        UIArtifacts.note("messages: received live bubble notes='\(String(describing: received.value))'")
        checkpoint(prefix + "11-received-bubble")
        received.tap()
        let status = waitForStory(timeout: 90) { status in
            return self.isPlaying(status) || status.hasPrefix("error")
        }
        UIArtifacts.note("messages: received live bubble tapped, story bridge status: \(status)")
        pause(2.5)
        checkpoint(prefix + "12-received-bubble-plays")
    }
}
