import XCTest

/// The REAL extension inside the Simulator's Messages app: open a conversation, open the
/// app drawer, launch the extension, stage and send the demo recap, check the bubble, tap
/// it and watch the story play in the expanded style.
///
/// Apple documents no automation for Messages, so this drives `com.apple.MobileSMS` by its
/// accessibility tree as found on iOS 26 (the "add" button, the drawer list, "sendButton").
/// Every step is screenshotted and its hierarchy dumped; CI runs the test in its own step
/// that is allowed to fail, and the main test run skips it.
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
                    UIArtifacts.note("messages: \(what): tapping candidate #\(index) type=\(candidate.elementType.rawValue) id='\(candidate.identifier)' label='\(candidate.label)'")
                    candidate.tap()
                    return true
                }
                UIArtifacts.note("messages: \(what): candidate #\(index) exists but is not hittable (id='\(candidate.identifier)' label='\(candidate.label)')")
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

    /// The story's bridge status inside Messages ("ready 12", "slide 2/12", "loaded, not
    /// ready: …", "error: …"). Debug builds of the extension expose it as `story.bridge`.
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

    // MARK: The walkthrough

    func testRecapBubbleInsideMessages() throws {
        // The extension is registered once the containing app has been installed and run.
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
        checkpoint("01-conversation-list")

        // 1. Open a conversation (the Simulator ships two simulated ones).
        let firstCell = messages.cells.firstMatch
        let inConversation = firstCell.waitForExistence(timeout: 8)
        if inConversation {
            UIArtifacts.note("messages: opening conversation '\(firstCell.label)'")
            firstCell.tap()
        }
        XCTAssertTrue(inConversation, "no conversation to open in the Simulator's Messages app")
        pause(2)
        dismissInterruptions()
        _ = messages.textFields["messageBodyField"].waitForExistence(timeout: 10)
        checkpoint("02-conversation")

        // 2. Open the app drawer: the "+" next to the text field (button "add" on iOS 26).
        let openedDrawer = tapFirst("app drawer", [
            messages.buttons["add"],
            messages.otherElements["MessageEntryView"].buttons.firstMatch,
            messages.buttons["Apps"],
            messages.buttons["browserButton"]
        ], timeout: 8)
        XCTAssertTrue(openedDrawer, "could not open the Messages app drawer")
        pause(2)
        checkpoint("03-app-drawer")

        // 3. Find our app in the list; third-party apps sit below the built-in ones.
        var ours = anyElement(labelContaining: productName)
        var swipes = 0
        while !(ours.exists && ours.isHittable) && swipes < 3 {
            messages.swipeUp()
            pause(1.2)
            swipes += 1
            ours = anyElement(labelContaining: productName)
        }
        let foundOurs = ours.exists
        XCTAssertTrue(foundOurs, "'\(productName)' is not in the Messages app drawer")
        if foundOurs {
            UIArtifacts.note("messages: our app in the drawer: id='\(ours.identifier)' label='\(ours.label)' after \(swipes) swipe(s)")
            checkpoint("04-app-drawer-our-app")
            if ours.isHittable {
                ours.tap()
            } else {
                ours.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
            }
        }

        // 4. Our launcher in the compact style.
        let sendDemo = messages.buttons["launcher.sendDemo"]
        let sawLauncher = sendDemo.waitForExistence(timeout: 25)
        UIArtifacts.note("messages: launcher visible=\(sawLauncher)")
        XCTAssertTrue(sawLauncher, "our launcher did not appear inside Messages")
        pause(1)
        checkpoint("05-launcher-compact")

        // 5. "Send the demo recap" stages a bubble in the input field.
        if sawLauncher {
            sendDemo.tap()
        }
        let sendButton = messages.buttons["sendButton"]
        let staged = sendButton.waitForExistence(timeout: 15)
        UIArtifacts.note("messages: bubble staged (send button present)=\(staged)")
        XCTAssertTrue(staged, "tapping 'Send the demo recap' did not stage a bubble")
        pause(2)
        checkpoint("06-bubble-staged")

        // 6. Send it.
        if staged {
            sendButton.tap()
        }
        let bubble = messages.buttons["bubble.recap"]
        let sawBubble = bubble.waitForExistence(timeout: 20)
        pause(4)
        checkpoint("07-bubble-sent")
        XCTAssertTrue(sawBubble, "the live recap bubble did not appear in the transcript")
        if sawBubble {
            let bubbleLabel = bubble.label
            UIArtifacts.note("messages: live bubble label='\(bubbleLabel)'")
            UIArtifacts.note("messages: live bubble notes='\(String(describing: bubble.value))'")
            XCTAssertTrue(
                bubbleLabel.contains("Dinner Club") && bubbleLabel.contains("48,213"),
                "the live bubble should show the recap itself, but it reads '\(bubbleLabel)'"
            )
        }

        // 7. Tap the bubble: the story must really play in the expanded style.
        if sawBubble {
            bubble.tap()
        }
        let status = waitForStory(timeout: 90) { status in
            return self.isPlaying(status) || status.hasPrefix("error")
        }
        UIArtifacts.note("messages: story bridge status after the tap: \(status)")
        pause(2.5)
        checkpoint("08-story-expanded")
        XCTAssertTrue(isPlaying(status), "the story never reported ready inside Messages (last status: \(status))")

        if isPlaying(status) {
            // Tap the right side of the story to move on, as a person would.
            let next = messages.coordinate(withNormalizedOffset: CGVector(dx: 0.86, dy: 0.55))
            var seen: [String] = [status]
            for step in 1...2 {
                next.tap()
                pause(2.2)
                seen.append(waitForStory(timeout: 3) { _ in
                    return true
                })
                checkpoint(step == 1 ? "09-story-next-slide" : "10-story-another-slide")
            }
            UIArtifacts.note("messages: story bridge statuses while tapping: \(seen)")

            // The story's own close control (top right of the page) returns to compact.
            messages.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.151)).tap()
            let backToCompact = messages.buttons["launcher.sendDemo"].waitForExistence(timeout: 12)
            UIArtifacts.note("messages: story close control returned to the compact launcher=\(backToCompact)")
            pause(1.5)
            checkpoint("11-after-close")
        }
    }
}
