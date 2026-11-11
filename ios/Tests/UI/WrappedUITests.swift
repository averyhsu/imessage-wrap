import XCTest

final class WrappedUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testLaunchShowsHome() throws {
        let app = XCUIApplication()
        app.launchArguments += ["--ui-testing"]
        app.launch()

        XCTAssertTrue(app.staticTexts["home.title"].waitForExistence(timeout: 30))

        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = "home"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
