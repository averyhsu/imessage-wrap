import UIKit
import XCTest
@testable import Wrapped

/// What the containing app plays and what it keeps: only recap links are opened, and only
/// a recap the person pasted themselves is kept under "Your recaps".
final class AppModelTests: XCTestCase {
    /// An invented recap that is not the built-in sample.
    private func ownRecap() throws -> Recap {
        let text = "{\"v\":1,\"chat\":{\"name\":\"Sunday Hikers\",\"members\":5},\"period\":{\"label\":\"2026\"},"
            + "\"totals\":{\"messages\":13018},\"senders\":[{\"name\":\"Noor\",\"messages\":3197}]}"
        return try Recap(statsJSON: Data(text.utf8))
    }

    override func setUp() {
        super.setUp()
        RecapStore.shared.clear()
    }

    override func tearDown() {
        RecapStore.shared.clear()
        UIPasteboard.general.string = ""
        super.tearDown()
    }

    func testOpensOnlyRecapLinks() throws {
        let recap = try ownRecap()
        let model = AppModel(arguments: [])
        XCTAssertNil(model.playing)

        let appLink = try XCTUnwrap(RecapLink.appURL(payload: recap.payload))
        XCTAssertEqual(appLink.scheme, "threadback")
        XCTAssertTrue(model.open(appLink))
        XCTAssertEqual(model.playing, recap)
        XCTAssertNil(model.notice)

        model.playing = nil
        let webLink = try XCTUnwrap(RecapLink.storyURL(payload: recap.payload))
        XCTAssertTrue(model.open(webLink))
        XCTAssertEqual(model.playing, recap)

        let refused = [
            "threadback://settings#w1=" + recap.payload,
            "threadback://recap/more#w1=" + recap.payload,
            "https://example.com/#w1=" + recap.payload,
            "http://averyhsu.github.io/imessage-wrap/#w1=" + recap.payload,
            "https://averyhsu.github.io/somewhere-else/#w1=" + recap.payload,
            "threadback://recap#w1=not-a-recap",
            "threadback://recap"
        ]
        for text in refused {
            model.playing = nil
            model.notice = nil
            let url = try XCTUnwrap(URL(string: text))
            XCTAssertFalse(model.open(url), text)
            XCTAssertNil(model.playing, text)
            XCTAssertEqual(model.notice, "That link does not contain a recap.", text)
        }
    }

    /// A recap that was merely opened (a link someone sent, say) is played, not kept.
    func testAnOpenedRecapIsNotKept() throws {
        let recap = try ownRecap()
        let model = AppModel(arguments: [])
        XCTAssertTrue(model.open(try XCTUnwrap(RecapLink.appURL(payload: recap.payload))))
        XCTAssertEqual(model.playing, recap)
        XCTAssertTrue(model.recents.isEmpty)
        XCTAssertTrue(RecapStore.shared.recents().isEmpty)

        model.playSample()
        XCTAssertEqual(model.playing, DemoRecap.recap)
        XCTAssertTrue(RecapStore.shared.recents().isEmpty, "the sample is never kept")
    }

    /// A recap the person pasted is kept, shown under "Your recaps", and Clear forgets it.
    func testAPastedRecapIsKeptUntilCleared() throws {
        let recap = try ownRecap()
        let link = try XCTUnwrap(RecapLink.storyURL(payload: recap.payload))
        let model = AppModel(arguments: [])

        UIPasteboard.general.string = "have a look: \(link.absoluteString)"
        model.pasteLink()
        XCTAssertEqual(model.playing, recap)
        XCTAssertNil(model.notice)
        XCTAssertEqual(model.recents, [recap])
        XCTAssertEqual(RecapStore.shared.recents(), [recap])
        XCTAssertEqual(AppModel(arguments: []).recents, [recap], "kept across launches")

        model.clearRecents()
        XCTAssertTrue(model.recents.isEmpty)
        XCTAssertTrue(RecapStore.shared.recents().isEmpty)
        XCTAssertTrue(AppModel(arguments: []).recents.isEmpty)
    }

    func testPastingSomethingElseSaysSo() throws {
        let model = AppModel(arguments: [])
        UIPasteboard.general.string = "https://example.com/#w1=" + DemoRecap.payload
        model.pasteLink()
        XCTAssertNil(model.playing)
        XCTAssertNotNil(model.notice)
        XCTAssertTrue(model.recents.isEmpty)
    }

    /// The launch arguments used by CI and UI tests exist in debug builds only; either way
    /// they go through the same link check.
    func testLaunchArgumentsGoThroughTheSameLinkCheck() throws {
        let recap = try ownRecap()
        let good = try XCTUnwrap(RecapLink.appURL(payload: recap.payload)).absoluteString
        #if DEBUG
        XCTAssertEqual(AppModel(arguments: ["Wrapped", "--open-url", good]).playing, recap)
        XCTAssertNil(AppModel(arguments: ["Wrapped", "--open-url", "https://example.com/#w1=" + recap.payload]).playing)
        XCTAssertEqual(AppModel(arguments: ["Wrapped", "--autoplay-demo"]).playing, DemoRecap.recap)
        #else
        XCTAssertNil(AppModel(arguments: ["Wrapped", "--open-url", good]).playing)
        XCTAssertNil(AppModel(arguments: ["Wrapped", "--autoplay-demo"]).playing)
        #endif
    }
}
