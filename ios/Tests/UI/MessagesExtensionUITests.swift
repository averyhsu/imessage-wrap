import XCTest

/// Stage 3 (stretch): drive the REAL extension inside the Simulator's Messages app.
///
/// Apple documents no automation for this, so the test explores: it screenshots and
/// dumps the accessibility hierarchy at every step and keeps going as far as it can.
/// CI runs it in its own step that is allowed to fail; the main test run skips it.
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
        pause(3)
        checkpoint("01-launched")
        dismissInterruptions()
        pause(1)
        checkpoint("02-conversation-list")

        // 1. Open a conversation (the Simulator ships a simulated one).
        var inConversation = false
        let firstCell = messages.cells.firstMatch
        if firstCell.waitForExistence(timeout: 6) {
            UIArtifacts.note("messages: first cell label='\(firstCell.label)' id='\(firstCell.identifier)' count=\(messages.cells.count)")
            firstCell.tap()
            inConversation = true
        } else {
            UIArtifacts.note("messages: no conversation cells; trying the compose button")
            inConversation = tapFirst("compose", [
                messages.buttons["composeButton"],
                messages.buttons["Compose"],
                messages.buttons["New Message"],
                anyElement(labelContaining: "compose")
            ])
        }
        pause(2.5)
        dismissInterruptions()
        checkpoint("03-conversation")

        // 2. Open the app drawer ("+" next to the text field on iOS 17 and later).
        // On iOS 26 it is a button labelled "add" inside the element "MessageEntryView".
        let openedDrawer = tapFirst("app drawer", [
            messages.buttons["add"],
            messages.otherElements["MessageEntryView"].buttons.firstMatch,
            messages.buttons["Apps"],
            messages.buttons["Add"],
            messages.buttons["browserButton"]
        ])
        pause(2.5)
        checkpoint("04-app-drawer")

        // 3. Find our app. Third-party apps can sit behind "More" or further down the list.
        var ours = anyElement(labelContaining: productName)
        if !ours.waitForExistence(timeout: 3) {
            UIArtifacts.note("messages: '\(productName)' not visible yet; trying More / swipe")
            _ = tapFirst("more", [
                messages.buttons["More"],
                messages.staticTexts["More"],
                messages.cells["More"],
                anyElement(labelContaining: "More")
            ], timeout: 2)
            pause(1.5)
            checkpoint("05-more")
            ours = anyElement(labelContaining: productName)
            if !ours.waitForExistence(timeout: 2) {
                messages.swipeUp()
                pause(1.5)
                checkpoint("05b-after-swipe")
                ours = anyElement(labelContaining: productName)
            }
        }
        var launchedExtension = false
        if ours.waitForExistence(timeout: 2) {
            UIArtifacts.note("messages: found our app element type=\(ours.elementType.rawValue) id='\(ours.identifier)' label='\(ours.label)' hittable=\(ours.isHittable)")
            if ours.isHittable {
                ours.tap()
            } else {
                ours.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
            }
            launchedExtension = true
        } else {
            UIArtifacts.note("messages: '\(productName)' was not found in the app drawer")
        }
        pause(4)
        checkpoint("06-extension-compact")

        // 4. Our launcher: "Send the demo recap" stages a bubble in the input field.
        let sendDemo = messages.buttons["launcher.sendDemo"]
        let sawLauncher = sendDemo.waitForExistence(timeout: 8)
        UIArtifacts.note("messages: launcher visible=\(sawLauncher)")
        var staged = false
        if sawLauncher {
            sendDemo.tap()
            staged = true
        } else {
            staged = tapFirst("send demo (by label)", [anyElement(labelContaining: "Send the demo recap")], timeout: 3)
        }
        pause(3)
        checkpoint("07-bubble-staged")

        // 5. Send it.
        let sent = tapFirst("send", [
            messages.buttons["sendButton"],
            messages.buttons["Send"],
            anyElement(labelContaining: "Send")
        ])
        pause(4)
        checkpoint("08-bubble-sent")

        // 6. Tap the bubble to play the story in the expanded style.
        let tappedBubble = tapFirst("recap bubble", [
            messages.otherElements["bubble.recap"],
            messages.buttons["bubble.recap"],
            anyElement(labelContaining: "in review"),
            anyElement(labelContaining: "Tap to play")
        ], timeout: 6)
        pause(6)
        checkpoint("09-story-expanded")

        UIArtifacts.note("messages: summary inConversation=\(inConversation) openedDrawer=\(openedDrawer) launchedExtension=\(launchedExtension) sawLauncher=\(sawLauncher) staged=\(staged) sent=\(sent) tappedBubble=\(tappedBubble)")
        XCTAssertTrue(inConversation, "could not open a conversation in Messages")
        XCTAssertTrue(openedDrawer, "could not open the Messages app drawer")
        XCTAssertTrue(launchedExtension, "could not find our extension in the app drawer")
        XCTAssertTrue(sawLauncher, "our launcher did not appear inside Messages")
        XCTAssertTrue(sent, "could not send the staged bubble")
        XCTAssertTrue(tappedBubble, "could not tap the recap bubble")
    }
}
