import XCTest

/// The containing app on the Simulator: home, the story (bundled web page in a WKWebView
/// plus the native bridge), and the debug gallery of the extension's native views.
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
    /// ("ready 5", "slide 2/5", "send", "close", "error: …").
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

    private func slideIndex(_ status: String) -> Int? {
        // "slide 2/5" → 2
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
        XCTAssertTrue(app.buttons["home.playDemo"].exists)
        XCTAssertTrue(app.buttons["home.paste"].exists)
        UIArtifacts.snap("app-01-home", in: self)

        app.swipeUp()
        XCTAssertTrue(app.staticTexts["home.howTo"].waitForExistence(timeout: 5))
        UIArtifacts.snap("app-02-home-how-to", in: self)
    }

    func testDemoStoryPlaysAndAdvances() throws {
        let app = launch(["--autoplay-demo"])

        let first = waitForBridge(app, timeout: 45) { status in
            return status.hasPrefix("ready") || status.hasPrefix("slide")
        }
        UIArtifacts.note("story bridge after load: \(first)")
        XCTAssertTrue(
            first.hasPrefix("ready") || first.hasPrefix("slide"),
            "the story never reported ready over the embed bridge (last status: \(first))"
        )
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

    func testPlayDemoFromHomeButton() throws {
        let app = launch([])
        let play = app.buttons["home.playDemo"]
        XCTAssertTrue(play.waitForExistence(timeout: 30))
        play.tap()
        let status = waitForBridge(app, timeout: 45) { status in
            return status.hasPrefix("ready") || status.hasPrefix("slide")
        }
        XCTAssertTrue(
            status.hasPrefix("ready") || status.hasPrefix("slide"),
            "the story did not start from the home button (last status: \(status))"
        )
        XCTAssertFalse(app.buttons["home.playDemo"].isHittable, "the story should cover the home screen")
    }

    /// An invented recap ("Link Test", 4,242 messages) encoded per docs/SCHEMA.md §5.
    private static let linkTestPayload = "VY_BCsIwEER_Jew5SBurQm4qeBK89CYeUrva4CYpTVRK6b-bFCz0tvAeM7MDfEDmHO6NCiAHsMogSDhr-2Il-gAcDJoKOw9yPXJosdOuTiapCimqIhNbiCS4oMgnYtB79cR4F6IQEXm09ZRwnQv2tZqi_6bIsmzkMz64Bc03C3rsF3QXS27TNO-sIh36tCLoQEkuG2TTOydH5L5pB4eK3l0V4aVFizV7dM4wxShqKxjHHw"

    func testOpensARecapLinkPassedAtLaunch() throws {
        let app = launch(["--open-url", "imessagewrapped://recap#w1=" + WrappedUITests.linkTestPayload])
        let status = waitForBridge(app, timeout: 45) { status in
            return status.hasPrefix("ready") || status.hasPrefix("slide")
        }
        XCTAssertTrue(
            status.hasPrefix("ready") || status.hasPrefix("slide"),
            "a valid recap link should start the story (last status: \(status))"
        )
        Thread.sleep(forTimeInterval: 1.2)
        UIArtifacts.snap("app-08-story-opened-from-link", in: self)
    }

    /// The registered custom scheme, routed by the system: iOS asks "Open in …?" first.
    func testCustomURLSchemeOpensARecap() throws {
        let app = launch([])
        XCTAssertTrue(app.staticTexts["home.title"].waitForExistence(timeout: 30))

        let link = try XCTUnwrap(URL(string: "imessagewrapped://recap#w1=" + WrappedUITests.linkTestPayload))
        XCUIDevice.shared.system.open(link)

        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let open = springboard.buttons["Open"]
        let asked = open.waitForExistence(timeout: 10)
        UIArtifacts.note("custom URL scheme: the system asked before opening=\(asked)")
        if asked {
            open.tap()
        }

        let status = waitForBridge(app, timeout: 45) { status in
            return status.hasPrefix("ready") || status.hasPrefix("slide")
        }
        XCTAssertTrue(
            status.hasPrefix("ready") || status.hasPrefix("slide"),
            "an imessagewrapped:// link should open the story (last status: \(status))"
        )
        Thread.sleep(forTimeInterval: 1.2)
        UIArtifacts.snap("app-09-story-opened-by-url-scheme", in: self)
    }

    func testUnreadableLinkStaysOnHomeWithANotice() throws {
        let app = launch(["--open-url", "imessagewrapped://recap#w1=not-a-real-payload"])
        XCTAssertTrue(app.staticTexts["home.notice"].waitForExistence(timeout: 30))
        XCTAssertEqual(app.staticTexts["home.notice"].label, "That link does not contain a recap.")
    }

    func testDebugGalleryOfExtensionViews() throws {
        let app = launch(["--gallery"])
        XCTAssertTrue(app.staticTexts["gallery.title"].waitForExistence(timeout: 30))
        XCTAssertTrue(app.buttons["launcher.sendDemo"].waitForExistence(timeout: 5) || app.otherElements["gallery.bubble"].exists)
        UIArtifacts.snap("gallery-01-card-and-bubble-NOT-MESSAGES", in: self)
        app.swipeUp()
        Thread.sleep(forTimeInterval: 0.6)
        UIArtifacts.snap("gallery-02-launcher-NOT-MESSAGES", in: self)
    }
}
