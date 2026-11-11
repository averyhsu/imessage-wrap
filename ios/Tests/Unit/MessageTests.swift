import Messages
import UIKit
import XCTest
@testable import Wrapped

/// What `MSMessage` does to our link and layout. These run in the Simulator, in the
/// containing app's process: they prove what the Messages framework objects keep in
/// memory (and through NSCoding), NOT what survives a real iMessage delivery between
/// devices. That last part needs two iPhones (see ios/README.md).
final class MessageTests: XCTestCase {
    func testFragmentLinkSurvivesMSMessageWithASession() throws {
        let recap = DemoRecap.recap
        let link = try XCTUnwrap(RecapLink.storyURL(payload: recap.payload, form: .fragment))

        let message = MSMessage(session: MSSession())
        message.url = link

        let stored = try XCTUnwrap(message.url, "MSMessage dropped the URL")
        print("WRAPPED_NOTE MSMessage(session:) url round trip: in=\(link.absoluteString.count) chars, out=\(stored.absoluteString.count) chars, identical=\(stored.absoluteString == link.absoluteString)")
        XCTAssertEqual(stored.absoluteString, link.absoluteString)

        let components = try XCTUnwrap(URLComponents(url: stored, resolvingAgainstBaseURL: false))
        XCTAssertEqual(components.fragment, "w1=" + recap.payload, "the #fragment must survive MSMessage + URLComponents")
        XCTAssertEqual(RecapLink.payload(from: stored), recap.payload)
        XCTAssertEqual(RecapLink.recap(from: stored), recap)
    }

    func testQueryLinkSurvivesMSMessage() throws {
        let recap = DemoRecap.recap
        let link = try XCTUnwrap(RecapLink.storyURL(payload: recap.payload, form: .query))
        let message = MSMessage()
        message.url = link
        let stored = try XCTUnwrap(message.url)
        XCTAssertEqual(stored.absoluteString, link.absoluteString)
        XCTAssertEqual(RecapLink.payload(from: stored), recap.payload)
    }

    func testFragmentLinkSurvivesCopyingTheMessage() throws {
        let recap = DemoRecap.recap
        let message = try RecapMessageComposer.message(for: recap)
        let copy = try XCTUnwrap(message.copy() as? MSMessage)
        XCTAssertEqual(RecapLink.payload(from: try XCTUnwrap(copy.url)), recap.payload)
    }

    /// NSCoding is the closest thing to "transport" that can be exercised without a
    /// second device. If Messages refuses to archive the object outside its own process,
    /// that is reported as a skip, not a failure.
    func testFragmentLinkSurvivesArchivingTheMessage() throws {
        let recap = DemoRecap.recap
        let message = MSMessage(session: MSSession())
        message.url = try XCTUnwrap(RecapLink.storyURL(payload: recap.payload, form: .fragment))

        let data: Data
        do {
            data = try NSKeyedArchiver.archivedData(withRootObject: message, requiringSecureCoding: true)
        } catch {
            print("WRAPPED_NOTE MSMessage archive: could not archive (\(error))")
            throw XCTSkip("MSMessage could not be archived here: \(error)")
        }
        guard let restored = try? NSKeyedUnarchiver.unarchivedObject(ofClass: MSMessage.self, from: data) else {
            print("WRAPPED_NOTE MSMessage archive: could not unarchive")
            throw XCTSkip("MSMessage could not be unarchived here")
        }
        let restoredPayload = restored.url.flatMap { RecapLink.payload(from: $0) }
        print("WRAPPED_NOTE MSMessage archive round trip: url kept=\(restored.url != nil), fragment payload kept=\(restoredPayload == recap.payload)")
        XCTAssertEqual(restoredPayload, recap.payload)
    }

    /// An invented recap that is not the built-in sample.
    private func ownRecap() throws -> Recap {
        let text = "{\"v\":1,\"chat\":{\"name\":\"Sunday Hikers\",\"members\":5},\"period\":{\"label\":\"2026\"},"
            + "\"totals\":{\"messages\":13018},\"senders\":[{\"name\":\"Noor\",\"messages\":3197}]}"
        return try Recap(statsJSON: Data(text.utf8))
    }

    /// What ships: a template card (image, caption, subcaption) that every member sees.
    func testAMessageIsATemplateCardByDefault() throws {
        XCTAssertFalse(WrappedConfig.useLiveLayout, "the live layout is experimental and off")
        let recap = try ownRecap()
        XCTAssertFalse(recap.isDemo)
        let message = try RecapMessageComposer.message(for: recap)

        let template = try XCTUnwrap(message.layout as? MSMessageTemplateLayout)
        XCTAssertFalse(message.layout is MSMessageLiveLayout)
        XCTAssertEqual(template.caption, "Sunday Hikers · 2026 in review")
        XCTAssertEqual(template.subcaption, "13,018 messages · Tap to play")
        let image = try XCTUnwrap(template.image, "the card needs its image")
        XCTAssertGreaterThan(image.size.width, 0)

        XCTAssertEqual(message.summaryText, "Sunday Hikers · 2026 in review")
        let url = try XCTUnwrap(message.url)
        XCTAssertEqual(url.scheme, "https")
        XCTAssertEqual(url.host, "averyhsu.github.io")
        XCTAssertLessThanOrEqual(url.absoluteString.count, 5000, "MSMessage.url rejects longer URLs")
        XCTAssertTrue(RecapLink.isRecapLink(url))
        XCTAssertEqual(RecapMessageComposer.recap(from: message), recap)
    }

    /// The built-in sample says "Sample" wherever it is sent.
    func testTheSampleIsLabelledWhenItIsSent() throws {
        let sample = DemoRecap.recap
        XCTAssertTrue(sample.isDemo)
        XCTAssertEqual(sample.caption, "Sample · Dinner Club 🍝 · 2026 in review")
        XCTAssertEqual(sample.eyebrow, "SAMPLE · 2026 IN REVIEW")
        let message = try RecapMessageComposer.message(for: sample)
        let template = try XCTUnwrap(message.layout as? MSMessageTemplateLayout)
        XCTAssertEqual(template.caption, "Sample · Dinner Club 🍝 · 2026 in review")
        XCTAssertEqual(message.summaryText, "Sample · Dinner Club 🍝 · 2026 in review")
        XCTAssertEqual(RecapMessageComposer.recap(from: message), sample)

        let own = try ownRecap()
        XCTAssertEqual(own.caption, "Sunday Hikers · 2026 in review")
        XCTAssertEqual(own.eyebrow, "2026 IN REVIEW")
    }

    /// Experimental and off by default: a live layout, with the template card as the
    /// alternate layout everyone else sees.
    func testExperimentalLiveLayoutKeepsTheCardAsItsAlternate() throws {
        let recap = try ownRecap()
        let message = try RecapMessageComposer.message(for: recap, live: true)
        let live = try XCTUnwrap(message.layout as? MSMessageLiveLayout)
        XCTAssertEqual(live.alternateLayout.caption, "Sunday Hikers · 2026 in review")
        XCTAssertNotNil(live.alternateLayout.image)
        XCTAssertEqual(RecapMessageComposer.recap(from: message), recap)

        let card = try RecapMessageComposer.message(for: recap, live: false)
        XCTAssertTrue(card.layout is MSMessageTemplateLayout)
    }

    func testOversizedRecapIsTrimmedBeforeItBecomesAMessage() throws {
        let payload = try RecapPayload.encode(object: LargeRecap.stats())
        let recap = try Recap(payload: payload)
        let message = try RecapMessageComposer.message(for: recap)
        let url = try XCTUnwrap(message.url)
        XCTAssertLessThanOrEqual(url.absoluteString.count, WrappedConfig.maxLinkLength)
        let carried = try XCTUnwrap(RecapMessageComposer.recap(from: message))
        XCTAssertEqual(carried.summary.chatName, recap.summary.chatName)
        XCTAssertEqual(carried.summary.totalMessages, recap.summary.totalMessages)
    }

    func testMessagesWithoutARecapAreIgnored() throws {
        XCTAssertNil(RecapMessageComposer.recap(from: nil))
        let message = MSMessage()
        XCTAssertNil(RecapMessageComposer.recap(from: message))
        message.url = URL(string: "https://example.com/?game=1")
        XCTAssertNil(RecapMessageComposer.recap(from: message))
        // Another app's message that carries a recap payload on its own site is not ours.
        message.url = URL(string: "https://example.com/imessage-wrap/#w1=" + DemoRecap.payload)
        XCTAssertNil(RecapMessageComposer.recap(from: message))
    }

    // MARK: Native rendering (offscreen; these are not screenshots of Messages)

    func testShareCardRendersAtFullResolution() throws {
        let own = try ownRecap()
        let image = RecapCardRenderer.image(for: own)
        XCTAssertEqual(image.size, RecapCardRenderer.pointSize)
        XCTAssertEqual(image.scale, 3)
        let cgImage = try XCTUnwrap(image.cgImage)
        XCTAssertEqual(cgImage.width, 1080)
        XCTAssertEqual(cgImage.height, 810)
        TestArtifacts.save(image, named: "render-share-card", in: self)
        TestArtifacts.save(RecapCardRenderer.image(for: DemoRecap.recap), named: "render-share-card-sample", in: self)

        let long = RecapSummary(
            chatName: "The Extremely Long Group Chat Name That Keeps On Going 🎉🎉",
            periodLabel: "2025–2026",
            totalMessages: 1234567
        )
        TestArtifacts.save(RecapCardRenderer.image(for: long), named: "render-share-card-long-name", in: self)
    }

    func testExperimentalLiveBubbleLaysOutWithinTheOfferedSize() throws {
        XCTAssertEqual(RecapBubbleView.preferredSize(fitting: CGSize(width: 1000, height: 1000)), CGSize(width: 300, height: 188))
        XCTAssertEqual(RecapBubbleView.preferredSize(fitting: CGSize(width: 240, height: 150)), CGSize(width: 240, height: 150))

        let size = RecapBubbleView.preferredSize(fitting: CGSize(width: 280, height: 400))
        let bubble = RecapBubbleView(frame: CGRect(origin: .zero, size: size))
        bubble.configure(with: DemoRecap.recap.summary)
        bubble.layoutIfNeeded()

        let format = UIGraphicsImageRendererFormat()
        format.scale = 3
        let renderer = UIGraphicsImageRenderer(size: size, format: format)
        let image = renderer.image { (context: UIGraphicsImageRendererContext) in
            bubble.layer.render(in: context.cgContext)
        }
        TestArtifacts.save(image, named: "experimental-render-live-bubble", in: self)

        var tapped = false
        bubble.onTap = {
            tapped = true
        }
        XCTAssertFalse(tapped)
        XCTAssertEqual(bubble.accessibilityIdentifier, "bubble.recap")
    }
}
