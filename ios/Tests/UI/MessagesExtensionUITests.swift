import XCTest

/// The REAL extension inside the Simulator's Messages app.
///
/// `testLiveBubble…`: open a conversation, open the app drawer, launch the extension, stage
/// and send the demo recap, check the live bubble, tap it and watch the story play in the
/// expanded style, then close it.
/// `testTemplateCard…`: the same with the template layout only, which is the card people
/// without the app (and Macs) see.
///
/// Apple documents no automation for Messages, so these drive `com.apple.MobileSMS` by its
/// accessibility tree as found on iOS 26 (the "add" button, the drawer list, "sendButton").
/// Every step is screenshotted and its hierarchy dumped; CI runs this class in its own
/// step that is allowed to fail, and the main test run skips it.
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

    private func checkpoint(_ name: String) {
        UIArtifacts.snap("messages-" + name, in: self)
        UIArtifacts.dumpToFile(messages, name: "messages-" + name)
    }

    private func anyElement(labelContaining text: String) -> XCUIElement {
        let predicate = NSPredicate(format: "label CONTAINS[c] %@ OR identifier CONTAINS[c] %@", text, text)
        return messages.descendants(matching: .any).matching(predicate).firstMatch
    }

    /// Taps the first candidate that exists and is hittable. Returns whether one was tapped.
    private func tapFirst(_ what: String, _ candidates: [XCUIElement], timeout: TimeInterval = 4) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            for (index, candidate) in candidates.enumerated() where candidate.exists {
                if candidate.isHittable {
                    UIArtifacts.note("messages: \(what): tapping candidate #\(index) id='\(candidate.identifier)' label='\(candidate.label)'")
                    candidate.tap()
                    return true
                }
            }
            pause(0.5)
        } while Date() < deadline
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

    /// The story's bridge status inside Messages ("ready 12 (ready in 2.1s)", "slide 2/12 …",
    /// "loaded, not ready: …", "error: …"). Debug builds of the extension expose it as
    /// the invisible label `story.bridge`.
    private func waitForStory(timeout: TimeInterval, until matches: (String) -> Bool) -> String {
        let label = messages.staticTexts["story.bridge"]
        let deadline = Date().addingTimeInterval(timeout)
        var last = "(no story.bridge element)"
        while Date() < deadline {
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
    private func openLauncherInConversation(_ index: Int, prefix: String) -> Bool {
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

        // Messages may reopen the last conversation; go back to the list first.
        let entryField = messages.textFields["messageBodyField"]
        if entryField.exists {
            _ = messages.buttons["BackButton"].tapIfExists(timeout: 2)
            pause(1.5)
        }
        checkpoint(prefix + "1-conversation-list")

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
            checkpoint(prefix + "2-no-app-drawer")
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
            checkpoint(prefix + "2-app-drawer-without-us")
            XCTFail("'\(productName)' is not in the Messages app drawer")
            return false
        }
        UIArtifacts.note("messages: our app in the drawer: id='\(ours.identifier)' label='\(ours.label)' after \(swipes) swipe(s)")
        checkpoint(prefix + "2-app-drawer")
        if ours.isHittable {
            ours.tap()
        } else {
            ours.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        }

        let sawLauncher = messages.buttons["launcher.sendDemo"].waitForExistence(timeout: 25)
        UIArtifacts.note("messages: launcher visible=\(sawLauncher)")
        XCTAssertTrue(sawLauncher, "our launcher did not appear inside Messages")
        pause(1)
        checkpoint(prefix + "3-launcher-compact")
        return sawLauncher
    }

    /// Waits for the staged bubble (Messages shows its send button), screenshots it, sends.
    private func sendStagedBubble(prefix: String) -> Bool {
        let sendButton = messages.buttons["sendButton"]
        let staged = sendButton.waitForExistence(timeout: 15)
        UIArtifacts.note("messages: bubble staged (send button present)=\(staged)")
        XCTAssertTrue(staged, "no bubble was staged in the input field")
        pause(2)
        checkpoint(prefix + "4-bubble-staged")
        if staged {
            sendButton.tap()
        }
        return staged
    }

    /// Waits for the story to report over the bridge, screenshots it, taps through two
    /// more slides and uses the page's close control.
    private func watchStoryPlay(prefix: String) {
        let status = waitForStory(timeout: 90) { status in
            return self.isPlaying(status) || status.hasPrefix("error")
        }
        UIArtifacts.note("messages: story bridge status after the tap: \(status)")
        pause(2.5)
        checkpoint(prefix + "6-story-expanded")
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
            checkpoint(prefix + (step == 1 ? "7-story-next-slide" : "8-story-another-slide"))
        }
        UIArtifacts.note("messages: story bridge statuses while tapping: \(seen)")

        // The page's own close control (top right) asks native to return to compact.
        messages.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.151)).tap()
        let backToCompact = messages.buttons["launcher.sendDemo"].waitForExistence(timeout: 12)
        UIArtifacts.note("messages: the story's close control returned to the compact launcher=\(backToCompact)")
        pause(1.5)
        checkpoint(prefix + "9-after-close")
    }

    // MARK: Tests

    func testLiveBubbleInsideMessages() throws {
        guard openLauncherInConversation(0, prefix: "live-") else {
            return
        }
        messages.buttons["launcher.sendDemo"].tap()
        guard sendStagedBubble(prefix: "live-") else {
            return
        }

        let bubble = messages.buttons["bubble.recap"]
        let sawBubble = bubble.waitForExistence(timeout: 20)
        pause(4)
        checkpoint("live-5-bubble-sent")
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
        watchStoryPlay(prefix: "live-")

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
        checkpoint("live-91-other-end-of-the-chat")
        let received = messages.buttons["bubble.recap"]
        let sawReceived = received.waitForExistence(timeout: 10)
        UIArtifacts.note("messages: received bubble present=\(sawReceived)")
        guard sawReceived else {
            return
        }
        pause(6)
        UIArtifacts.note("messages: received bubble label='\(received.label)'")
        UIArtifacts.note("messages: received bubble notes='\(String(describing: received.value))'")
        checkpoint("live-92-received-bubble")
        received.tap()
        let status = waitForStory(timeout: 90) { status in
            return self.isPlaying(status) || status.hasPrefix("error")
        }
        UIArtifacts.note("messages: received bubble tapped, story bridge status: \(status)")
        pause(2.5)
        checkpoint("live-93-received-bubble-plays")
    }

    func testTemplateCardInsideMessages() throws {
        guard openLauncherInConversation(1, prefix: "template-") else {
            return
        }
        // A debug-only control: stages the demo with the template layout alone.
        let hook = messages.buttons["launcher.sendDemoAsTemplate"]
        guard hook.waitForExistence(timeout: 5) else {
            XCTFail("the debug control for template-only bubbles is missing")
            return
        }
        hook.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        guard sendStagedBubble(prefix: "template-") else {
            return
        }
        pause(5)
        checkpoint("template-5-card-sent")

        // The card is Messages' own bubble; its caption carries our text
        // ("Dinner Club 🍝 · 2026 in review").
        // Live bubbles from the other test may be in the transcript too; they carry the
        // identifier "bubble.recap", the card does not. The newest card is the last match.
        let predicate = NSPredicate(format: "label CONTAINS[c] %@ AND identifier != %@", "2026 in review", "bubble.recap")
        let cards = messages.descendants(matching: .any).matching(predicate)
        let sawCard = cards.firstMatch.waitForExistence(timeout: 10)
        XCTAssertTrue(sawCard, "the template card did not appear in the transcript")
        guard sawCard else {
            return
        }
        let card = cards.element(boundBy: max(0, cards.count - 1))
        UIArtifacts.note("messages: template card: \(cards.count) match(es), tapping type=\(card.elementType.rawValue) id='\(card.identifier)' label='\(card.label)'")
        if card.isHittable {
            card.tap()
        } else {
            card.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.4)).tap()
        }
        watchStoryPlay(prefix: "template-")
    }
}
