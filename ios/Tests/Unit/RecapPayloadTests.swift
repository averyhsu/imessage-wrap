import Messages
import UIKit
import XCTest
@testable import Wrapped

/// The link payload codec against the cross-language vector (docs/SCHEMA.md §5).
final class RecapPayloadTests: XCTestCase {
    func testDecodesTheSharedVectorToExactlyItsStats() throws {
        let vector = try PayloadVector.load()
        let decoded = try RecapPayload.decodeObject(vector.payload)
        XCTAssertEqual(decoded as NSDictionary, vector.stats)
    }

    func testEncodeThenDecodeReturnsTheSameBytes() throws {
        let vector = try PayloadVector.load()
        let payload = try RecapPayload.encode(json: vector.statsJSON)
        XCTAssertEqual(try RecapPayload.decode(payload), vector.statsJSON)
    }

    func testEncodedPayloadIsUnpaddedBase64URL() throws {
        let vector = try PayloadVector.load()
        let payload = try RecapPayload.encode(json: vector.statsJSON)
        XCTAssertFalse(payload.isEmpty)
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
        XCTAssertNil(payload.rangeOfCharacter(from: allowed.inverted), "payload must only use the base64url alphabet")
    }

    func testReencodingTheObjectKeepsEveryValue() throws {
        let vector = try PayloadVector.load()
        let stats = try RecapPayload.decodeObject(vector.payload)
        let payload = try RecapPayload.encode(object: stats)
        let again = try RecapPayload.decodeObject(payload)
        XCTAssertEqual(again as NSDictionary, vector.stats)
        // Re-encoding must not bloat the link (for example by writing 0.2456 as 0.24560000000000001).
        XCTAssertLessThanOrEqual(payload.count, vector.payload.count + 200)
    }

    func testBase64URLHelpersRoundTrip() {
        let bytes = Data([0xfb, 0xff, 0xfe, 0x00, 0x01])
        let encoded = RecapPayload.base64URLEncode(bytes)
        XCTAssertEqual(encoded, "-__-AAE")
        XCTAssertEqual(RecapPayload.base64URLDecode(encoded), bytes)
        XCTAssertEqual(RecapPayload.base64URLDecode("-__-AAE="), bytes, "padding is tolerated")
        XCTAssertNil(RecapPayload.base64URLDecode("a"), "a single leftover character is never valid")
        XCTAssertNil(RecapPayload.base64URLDecode("ab!d"))
    }

    func testSummaryOfTheVector() throws {
        let vector = try PayloadVector.load()
        let recap = try Recap(payload: vector.payload)
        XCTAssertEqual(recap.summary.version, 1)
        XCTAssertEqual(recap.summary.chatName, "Dinner Club 🍝")
        XCTAssertEqual(recap.summary.memberCount, 7)
        XCTAssertEqual(recap.summary.periodLabel, "2026")
        XCTAssertEqual(recap.summary.totalMessages, 48213)
        XCTAssertEqual(recap.summary.personalityTitle, "The Night Owls")
        XCTAssertEqual(recap.summary.topSenders.count, 3)
        XCTAssertEqual(recap.summary.topSenders.first, RecapSummary.Sender(name: "Maya", messages: 11842))
        XCTAssertEqual(recap.summary.caption, "Dinner Club 🍝 · 2026 in review")
        XCTAssertEqual(recap.summary.reviewLabel, "2026 in review")
        XCTAssertTrue(recap.summary.subcaption.hasSuffix("messages · Tap to play"))
    }

    /// The bundled sample is the site's demo (`web/js/demo-data.js`): the same chat as the
    /// vector, with the personality the current rules give it. That its payload is the
    /// site's demo, byte for byte, is checked by `tests/python/test_ios_demo.py`.
    func testBundledDemoIsTheSiteDemo() throws {
        let vector = try PayloadVector.load()
        let old = try Recap(payload: vector.payload).summary
        let demo = DemoRecap.recap.summary
        XCTAssertEqual(demo.chatName, old.chatName)
        XCTAssertEqual(demo.periodLabel, old.periodLabel)
        XCTAssertEqual(demo.totalMessages, 48213)
        XCTAssertEqual(demo.topSenders, old.topSenders)
        XCTAssertEqual(demo.personalityTitle, "The Firehose")
        XCTAssertTrue(DemoRecap.recap.isDemo)
    }

    func testSummaryToleratesMissingAndUnknownKeys() throws {
        let json = Data("{\"v\":1,\"chat\":{\"name\":\"  Book Club  \"},\"future\":{\"a\":[1,2,{\"b\":null}]}}".utf8)
        let summary = try RecapSummary.decode(json: json)
        XCTAssertEqual(summary.chatName, "Book Club")
        XCTAssertNil(summary.memberCount)
        XCTAssertEqual(summary.periodLabel, "")
        XCTAssertEqual(summary.reviewLabel, "In review")
        XCTAssertEqual(summary.totalMessages, 0)
        XCTAssertTrue(summary.topSenders.isEmpty)
        XCTAssertNil(summary.personalityTitle)
    }

    func testSummaryToleratesOddValues() throws {
        let text = "{\"chat\":{\"name\":42},\"period\":{\"label\":2026},\"totals\":{\"messages\":\"1200\"},"
            + "\"senders\":[{\"name\":\"A\",\"messages\":\"12\"},7,{\"messages\":3},{\"name\":\"B\",\"messages\":4.0},"
            + "{\"name\":\"C\"},{\"name\":\"D\",\"messages\":1}],\"personality\":\"nope\"}"
        let summary = try RecapSummary.decode(json: Data(text.utf8))
        XCTAssertEqual(summary.chatName, "42")
        XCTAssertEqual(summary.periodLabel, "2026")
        XCTAssertEqual(summary.totalMessages, 1200)
        XCTAssertEqual(summary.topSenders, [
            RecapSummary.Sender(name: "A", messages: 12),
            RecapSummary.Sender(name: "B", messages: 4),
            RecapSummary.Sender(name: "C", messages: 0)
        ])
        XCTAssertNil(summary.personalityTitle)
    }

    func testSummaryCodableRoundTrip() throws {
        let original = DemoRecap.recap.summary
        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(RecapSummary.self, from: data)
        XCTAssertEqual(decoded, original)
    }

    func testRejectsThingsThatAreNotRecaps() throws {
        XCTAssertThrowsError(try Recap(payload: "")) { error in
            XCTAssertEqual(error as? RecapPayloadError, .invalidBase64URL)
        }
        XCTAssertThrowsError(try Recap(payload: "not base64url!")) { error in
            XCTAssertEqual(error as? RecapPayloadError, .invalidBase64URL)
        }
        // Valid base64url, but not a DEFLATE stream of a stats object.
        XCTAssertThrowsError(try Recap(payload: "AAAAAAAAAAAAAAAAAAAAAAAA"))

        let array = try RecapPayload.encode(json: Data("[1,2,3]".utf8))
        XCTAssertThrowsError(try Recap(payload: array)) { error in
            XCTAssertEqual(error as? RecapPayloadError, .notAStatsObject)
        }
        let unrelated = try RecapPayload.encode(json: Data("{\"hello\":\"world\"}".utf8))
        XCTAssertThrowsError(try Recap(payload: unrelated)) { error in
            XCTAssertEqual(error as? RecapPayloadError, .notAStatsObject)
        }
    }

    // MARK: Hostile input

    func testRefusesOverlongPayloadsBeforeDecodingThem() throws {
        let limit = RecapPayload.maxPayloadCharacters
        XCTAssertEqual(limit, 8000)
        let tooLong = String(repeating: "A", count: limit + 1)
        XCTAssertThrowsError(try RecapPayload.decode(tooLong)) { error in
            XCTAssertEqual(error as? RecapPayloadError, .payloadTooLong(length: limit + 1, limit: limit))
        }
        XCTAssertThrowsError(try Recap(payload: tooLong)) { error in
            XCTAssertEqual(error as? RecapPayloadError, .payloadTooLong(length: limit + 1, limit: limit))
        }
        let link = try XCTUnwrap(RecapLink.storyURL(payload: tooLong))
        XCTAssertNil(RecapLink.recap(from: link))
        XCTAssertNil(RecapLink.recap(inText: link.absoluteString))

        // Exactly at the limit is still looked at (and fails for what it is, not its length).
        let atLimit = String(repeating: "A", count: limit)
        XCTAssertThrowsError(try RecapPayload.decode(atLimit)) { error in
            XCTAssertNotEqual(error as? RecapPayloadError, .payloadTooLong(length: limit, limit: limit))
        }
    }

    /// A "deflate bomb": 1,378 characters that inflate to a megabyte of zeros (packed with
    /// zlib at level 9 as raw DEFLATE). Inflating stops at the cap instead.
    func testInflatingStopsAtTheOutputCap() throws {
        let bomb = "7cExAQAAAMKg9U9tCF-g" + String(repeating: "A", count: 1355) + "-Aw"
        XCTAssertEqual(bomb.count, 1378)
        XCTAssertLessThanOrEqual(bomb.count, RecapPayload.maxPayloadCharacters)

        XCTAssertThrowsError(try RecapPayload.decode(bomb)) { error in
            XCTAssertEqual(error as? RecapPayloadError, .inflatedTooLarge(limit: RecapPayload.maxInflatedBytes))
        }
        XCTAssertThrowsError(try Recap(payload: bomb))
        XCTAssertNil(RecapLink.recap(from: try XCTUnwrap(RecapLink.storyURL(payload: bomb))))

        // With the cap lifted it really is a megabyte, so the cap is what stops it.
        let packed = try XCTUnwrap(RecapPayload.base64URLDecode(bomb))
        XCTAssertEqual(try RecapPayload.inflateRaw(packed, limit: 2 * 1024 * 1024).count, 1024 * 1024)

        // The same with a stream packed on this device.
        let own = try XCTUnwrap(RecapPayload.base64URLDecode(try RecapPayload.encode(json: Data(count: 2 * 1024 * 1024))))
        print("WRAPPED_NOTE deflate bomb: 2 MB of zeros packed here into \(own.count) bytes; inflating stops at \(RecapPayload.maxInflatedBytes) bytes")
        XCTAssertThrowsError(try RecapPayload.inflateRaw(own, limit: RecapPayload.maxInflatedBytes)) { error in
            XCTAssertEqual(error as? RecapPayloadError, .inflatedTooLarge(limit: RecapPayload.maxInflatedBytes))
        }
    }

    func testInflateCapIsExact() throws {
        let json = Data(String(repeating: "{\"a\":1}", count: 1000).utf8)
        XCTAssertEqual(json.count, 7000)
        let packed = try XCTUnwrap(RecapPayload.base64URLDecode(try RecapPayload.encode(json: json)))
        XCTAssertEqual(try RecapPayload.inflateRaw(packed, limit: 7000), json)
        XCTAssertThrowsError(try RecapPayload.inflateRaw(packed, limit: 6999)) { error in
            XCTAssertEqual(error as? RecapPayloadError, .inflatedTooLarge(limit: 6999))
        }
        XCTAssertThrowsError(try RecapPayload.inflateRaw(Data(), limit: 7000)) { error in
            XCTAssertEqual(error as? RecapPayloadError, .inflateFailed)
        }
    }

    /// Larger than one internal chunk, and still well under the cap: decodes completely.
    func testInflatesOutputLargerThanOneChunk() throws {
        var text = SeededText(seed: 7)
        var words: [String] = []
        for _ in 0..<15_000 {
            words.append(text.word())
        }
        let filler = words.joined(separator: " ")
        let json = Data("{\"chat\":{\"name\":\"Big\"},\"totals\":{\"messages\":5},\"pad\":\"\(filler)\"}".utf8)
        XCTAssertGreaterThan(json.count, 80_000)
        XCTAssertLessThan(json.count, RecapPayload.maxInflatedBytes)
        let packed = try XCTUnwrap(RecapPayload.base64URLDecode(try RecapPayload.encode(json: json)))
        XCTAssertEqual(try RecapPayload.inflateRaw(packed, limit: RecapPayload.maxInflatedBytes), json)
    }

    func testTruncatedDeflateIsRefused() throws {
        let vector = try PayloadVector.load()
        let full = try XCTUnwrap(RecapPayload.base64URLDecode(vector.payload))
        for keep in [1, 2, 10, full.count / 2, full.count - 1] {
            let cut = RecapPayload.base64URLEncode(Data(full.prefix(keep)))
            XCTAssertThrowsError(try RecapPayload.decode(cut), "cut to \(keep) of \(full.count) bytes")
            XCTAssertThrowsError(try Recap(payload: cut), "cut to \(keep) of \(full.count) bytes")
        }
        // Damage in the middle of the stream is refused or, at worst, decodes to something
        // that is not the recap; it never crashes and never passes as the original.
        var damaged = full
        damaged[full.count / 2] = damaged[full.count / 2] ^ 0xFF
        let recap = try? Recap(payload: RecapPayload.base64URLEncode(damaged))
        XCTAssertNotEqual(recap?.summary, try Recap(payload: vector.payload).summary)
    }

    /// Contract update: senders without a contact name arrive as "…0001" (never a full
    /// number), and message text is opt-in, so `most_reacted[].text` is usually "".
    func testHandlesMaskedSenderNamesAndEmptyQuotes() throws {
        let text = "{\"v\":1,\"chat\":{\"name\":\"Flat 4B\",\"members\":3},\"period\":{\"label\":\"2026\"},"
            + "\"totals\":{\"messages\":900},"
            + "\"senders\":[{\"name\":\"…0001\",\"messages\":500},{\"name\":\"Ana\",\"messages\":300},{\"name\":\"…0002\",\"messages\":100}],"
            + "\"most_reacted\":[{\"sender\":\"…0001\",\"reactions\":9,\"date\":\"2026-03-01\",\"text\":\"\"}]}"
        let recap = try Recap(statsJSON: Data(text.utf8))
        XCTAssertEqual(recap.summary.topSenders.map { $0.name }, ["…0001", "Ana", "…0002"])
        XCTAssertEqual(try Recap(payload: recap.payload).summary, recap.summary)

        var stats = try RecapPayload.decodeObject(recap.payload)
        RecapLinkBuilder.applyTrimStep(2, to: &stats)
        let entries = try XCTUnwrap(stats["most_reacted"] as? [[String: Any]])
        XCTAssertEqual(entries.first?["text"] as? String, "", "an empty quote stays empty")

        let message = try RecapMessageComposer.message(for: recap)
        XCTAssertEqual(RecapMessageComposer.recap(from: message), recap)
        XCTAssertEqual(RecapCardRenderer.image(for: recap.summary).size, RecapCardRenderer.pointSize)
    }

    func testJustComposedRecapIsRememberedBriefly() throws {
        let suite = "wrapped.tests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer {
            defaults.removePersistentDomain(forName: suite)
        }
        let store = RecapStore(defaults: defaults)
        XCTAssertNil(store.lastComposed())

        let now = Date()
        store.setLastComposed(DemoRecap.recap, now: now)
        let composed = try XCTUnwrap(store.lastComposed(now: now.addingTimeInterval(5)))
        XCTAssertEqual(composed.recap, DemoRecap.recap)
        XCTAssertEqual(composed.date.timeIntervalSince1970, now.timeIntervalSince1970, accuracy: 0.01)
        XCTAssertNil(store.lastComposed(now: now.addingTimeInterval(120)), "it expires")
    }

    func testRecentsStoreKeepsNewestFirstAndSkipsTheDemo() throws {
        let suite = "wrapped.tests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer {
            defaults.removePersistentDomain(forName: suite)
        }
        let store = RecapStore(defaults: defaults)
        let first = try Recap(statsJSON: Data("{\"chat\":{\"name\":\"One\"},\"totals\":{\"messages\":1}}".utf8))
        let second = try Recap(statsJSON: Data("{\"chat\":{\"name\":\"Two\"},\"totals\":{\"messages\":2}}".utf8))

        store.remember(DemoRecap.recap)
        XCTAssertTrue(store.recents().isEmpty, "the demo is never stored")

        store.remember(first)
        store.remember(second)
        store.remember(first)
        XCTAssertEqual(store.recents().map { $0.summary.chatName }, ["One", "Two"])

        let now = Date()
        store.setPendingPlay(second, now: now)
        XCTAssertEqual(store.takePendingPlay(now: now.addingTimeInterval(5)), second)
        XCTAssertNil(store.takePendingPlay(now: now.addingTimeInterval(6)), "a hand-off is taken once")
        store.setPendingPlay(second, now: now)
        XCTAssertNil(store.takePendingPlay(now: now.addingTimeInterval(120)), "a stale hand-off is ignored")
    }

    func testClearForgetsEverything() throws {
        let suite = "wrapped.tests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer {
            defaults.removePersistentDomain(forName: suite)
        }
        let store = RecapStore(defaults: defaults)
        let recap = try Recap(statsJSON: Data("{\"chat\":{\"name\":\"One\"},\"totals\":{\"messages\":1}}".utf8))
        store.remember(recap)
        store.setLastComposed(recap)
        store.setPendingPlay(recap)
        XCTAssertEqual(store.recents(), [recap])

        store.clear()
        XCTAssertTrue(store.recents().isEmpty)
        XCTAssertNil(store.lastComposed())
        XCTAssertNil(store.takePendingPlay())
        XCTAssertNil(defaults.persistentDomain(forName: suite)?.keys.first { $0.hasPrefix("wrapped.") })
    }
}
