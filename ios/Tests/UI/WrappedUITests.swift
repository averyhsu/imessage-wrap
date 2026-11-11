import UIKit
import XCTest

/// The containing app on the Simulator: home, the story (bundled web page in a WKWebView
/// plus the native bridge), which links it opens, what it keeps, and the debug gallery of
/// the extension's native views.
final class WrappedUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    private func launch(_ arguments: [String]) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing"] + arguments
        app.launch()
        return app
    }

    /// Polls the invisible `story.bridge` label, which mirrors the last embed-bridge event
    /// ("ready 12 (ready in 0.4s)", "slide 2/12 …", "send", "close", "error: …").
    private func waitForBridge(
        _ app: XCUIApplication,
        timeout: TimeInterval,
        until matches: (String) -> Bool
    ) -> String {
        let label = app.staticTexts["story.bridge"]
        let deadline = Date().addingTimeInterval(timeout)
        var last = "(no story.bridge element)"
        while Date() < deadline {
            if label.exists {
                last = label.label
                if matches(last) {
                    return last
                }
            }
            Thread.sleep(forTimeInterval: 0.4)
        }
        return last
    }

    private func isPlaying(_ status: String) -> Bool {
        return status.hasPrefix("ready") || status.hasPrefix("slide")
    }

    private func slideIndex(_ status: String) -> Int? {
        // "slide 2/12 (ready in 0.4s)" → 2
        guard status.hasPrefix("slide ") else {
            return nil
        }
        let rest = status.dropFirst("slide ".count)
        guard let slash = rest.firstIndex(of: "/") else {
            return nil
        }
        return Int(rest[rest.startIndex..<slash])
    }

    func testHomeScreen() throws {
        let app = launch([])
        XCTAssertTrue(app.staticTexts["home.title"].waitForExistence(timeout: 30))
        XCTAssertEqual(app.staticTexts["home.title"].label, "Threadback")
        XCTAssertTrue(app.buttons["home.playSample"].exists)
        XCTAssertTrue(app.buttons["home.paste"].exists)
        UIArtifacts.snap("app-01-home", in: self)

        app.swipeUp()
        XCTAssertTrue(app.staticTexts["home.howTo"].waitForExistence(timeout: 5))
        UIArtifacts.snap("app-02-home-how-to", in: self)
    }

    func testSampleStoryPlaysAndAdvances() throws {
        let app = launch(["--autoplay-demo"])

        let first = waitForBridge(app, timeout: 45) { status in
            return self.isPlaying(status)
        }
        UIArtifacts.note("story bridge after load: \(first)")
        XCTAssertTrue(isPlaying(first), "the story never reported ready over the embed bridge (last status: \(first))")
        Thread.sleep(forTimeInterval: 1.2)
        UIArtifacts.snap("app-03-story-slide-1", in: self)

        // Tap the right side of the screen to move through the story.
        let nextTapPoint = app.coordinate(withNormalizedOffset: CGVector(dx: 0.86, dy: 0.42))
        var seen: [String] = [first]
        var highestIndex = slideIndex(first) ?? 0
        for step in 2...5 {
            nextTapPoint.tap()
            Thread.sleep(forTimeInterval: 1.4)
            let status = waitForBridge(app, timeout: 3) { _ in
                return true
            }
            seen.append(status)
            highestIndex = max(highestIndex, slideIndex(status) ?? 0)
            UIArtifacts.snap("app-0\(step + 2)-story-slide-\(step)", in: self)
        }
        UIArtifacts.note("story bridge statuses while tapping: \(seen)")
        XCTAssertGreaterThanOrEqual(highestIndex, 1, "tapping never advanced the story (statuses: \(seen))")
    }

    /// From the home screen the story's web view has been warmed up, so the story is on
    /// screen almost at once. What shows in between is the recap's own cover, never black.
    func testPlaySampleFromHomeButton() throws {
        let app = launch([])
        let play = app.buttons["home.playSample"]
        XCTAssertTrue(play.waitForExistence(timeout: 30))
        // Give the warm-up a moment, as a person reading the home screen would.
        Thread.sleep(forTimeInterval: 6)
        play.tap()
        // Straight after the tap: the cover or already the story.
        Thread.sleep(forTimeInterval: 0.25)
        UIArtifacts.snap("app-10-just-after-tapping-play", in: self)

        let status = waitForBridge(app, timeout: 45) { status in
            return self.isPlaying(status)
        }
        UIArtifacts.note("story started from the home button: \(status)")
        XCTAssertTrue(isPlaying(status), "the story did not start from the home button (last status: \(status))")
        XCTAssertFalse(app.buttons["home.playSample"].isHittable, "the story should cover the home screen")
    }

    func testOpensARecapLinkPassedAtLaunch() throws {
        let app = launch(["--open-url", "threadback://recap#w1=" + TestRecap.payload])
        let status = waitForBridge(app, timeout: 45) { status in
            return self.isPlaying(status)
        }
        XCTAssertTrue(isPlaying(status), "a valid recap link should start the story (last status: \(status))")
        Thread.sleep(forTimeInterval: 1.2)
        UIArtifacts.snap("app-08-story-opened-from-link", in: self)
    }

    /// The registered custom scheme, routed by the system: iOS may ask "Open in …?" first.
    func testCustomURLSchemeOpensARecap() throws {
        let app = launch([])
        XCTAssertTrue(app.staticTexts["home.title"].waitForExistence(timeout: 30))

        let link = try XCTUnwrap(URL(string: "threadback://recap#w1=" + TestRecap.payload))
        XCUIDevice.shared.system.open(link)

        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let open = springboard.buttons["Open"]
        let asked = open.waitForExistence(timeout: 10)
        UIArtifacts.note("custom URL scheme: the system asked before opening=\(asked)")
        if asked {
            open.tap()
        }

        let status = waitForBridge(app, timeout: 45) { status in
            return self.isPlaying(status)
        }
        XCTAssertTrue(isPlaying(status), "a threadback:// link should open the story (last status: \(status))")
        Thread.sleep(forTimeInterval: 1.2)
        UIArtifacts.snap("app-09-story-opened-by-url-scheme", in: self)
    }

    func testUnreadableLinkStaysOnHomeWithANotice() throws {
        let app = launch(["--open-url", "threadback://recap#w1=not-a-real-payload"])
        XCTAssertTrue(app.staticTexts["home.notice"].waitForExistence(timeout: 30))
        XCTAssertEqual(app.staticTexts["home.notice"].label, "That link does not contain a recap.")
        XCTAssertFalse(app.staticTexts["story.bridge"].exists, "no story should have started")
    }

    /// A perfectly good recap, but on a link the app does not accept (another host, another
    /// part of the app's own scheme): it stays on Home.
    func testLinksFromElsewhereAreNotOpened() throws {
        for link in [
            "https://example.com/imessage-wrap/#w1=" + TestRecap.payload,
            "threadback://settings#w1=" + TestRecap.payload
        ] {
            let app = launch(["--open-url", link])
            XCTAssertTrue(app.staticTexts["home.notice"].waitForExistence(timeout: 30), "expected a notice for \(link.prefix(40))")
            XCTAssertEqual(app.staticTexts["home.notice"].label, "That link does not contain a recap.")
            XCTAssertFalse(app.staticTexts["story.bridge"].exists, "no story should have started for \(link.prefix(40))")
            app.terminate()
        }
    }

    /// Pasting a recap link plays it and keeps it under "Your recaps"; Clear forgets it.
    func testPastedRecapIsKeptAndCanBeCleared() throws {
        UIPasteboard.general.string = TestRecap.link
        let app = launch([])
        let paste = app.buttons["home.paste"]
        XCTAssertTrue(paste.waitForExistence(timeout: 30))
        paste.tap()
        let allowed = PastePermission.allowIfAsked(app: app, in: self)
        UIArtifacts.note("app: iOS asked for permission to paste=\(allowed)")

        let status = waitForBridge(app, timeout: 45) { status in
            return self.isPlaying(status)
        }
        XCTAssertTrue(isPlaying(status), "pasting a recap link should start the story (last status: \(status))")
        Thread.sleep(forTimeInterval: 1.0)

        // Leave the story the way a person can at any time: drag it down.
        let top = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3))
        let bottom = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.85))
        top.press(forDuration: 0.05, thenDragTo: bottom)
        let row = app.buttons["recents.play"]
        let closedByDragging = row.waitForExistence(timeout: 8)
        UIArtifacts.note("app: dragging the story down closed it=\(closedByDragging)")
        if !closedByDragging {
            // The page's own close control (top right).
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.116)).tap()
        }
        XCTAssertTrue(row.waitForExistence(timeout: 15), "the pasted recap should be listed under Your recaps")
        XCTAssertTrue(closedByDragging, "dragging the story down should close it")
        XCTAssertTrue(row.label.contains(TestRecap.chatName), "unexpected row: \(row.label)")
        Thread.sleep(forTimeInterval: 0.8)
        app.swipeUp()
        Thread.sleep(forTimeInterval: 0.8)
        UIArtifacts.snap("app-11-home-your-recaps", in: self)

        // It is still there after a relaunch, and Clear forgets it.
        app.terminate()
        let again = launch([])
        XCTAssertTrue(again.buttons["recents.play"].waitForExistence(timeout: 30), "kept across launches")
        again.swipeUp()
        let clear = again.buttons["recents.clear"]
        XCTAssertTrue(clear.waitForExistence(timeout: 5))
        clear.tap()
        Thread.sleep(forTimeInterval: 1.0)
        XCTAssertFalse(again.buttons["recents.play"].exists, "Clear should forget the recap")
        again.terminate()
        let afterClear = launch([])
        XCTAssertTrue(afterClear.buttons["home.paste"].waitForExistence(timeout: 30))
        XCTAssertFalse(afterClear.buttons["recents.play"].exists, "nothing comes back after Clear")
        UIPasteboard.general.string = ""
    }

    func testDebugGalleryOfExtensionViews() throws {
        let app = launch(["--gallery"])
        XCTAssertTrue(app.staticTexts["gallery.title"].waitForExistence(timeout: 30))
        XCTAssertTrue(app.buttons["launcher.paste"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["launcher.seeSample"].exists)
        UIArtifacts.snap("gallery-01-card-and-launcher-NOT-MESSAGES", in: self)
    }
}
