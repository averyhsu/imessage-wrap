import XCTest
@testable import Wrapped

/// Link parsing (both forms), link building, and the length budget with its trim ladder
/// (docs/SCHEMA.md §5).
final class RecapLinkTests: XCTestCase {
    private let base = "https://averyhsu.github.io/imessage-wrap/"

    // MARK: Parsing

    func testParsesTheVectorURL() throws {
        let vector = try PayloadVector.load()
        let url = try XCTUnwrap(URL(string: vector.url))
        XCTAssertEqual(RecapLink.payload(from: url), vector.payload)
        XCTAssertEqual(RecapLink.recap(from: url)?.summary.totalMessages, 48213)
    }

    func testParsesFragmentForm() throws {
        let url = try XCTUnwrap(URL(string: base + "#w1=abc-_123"))
        XCTAssertEqual(RecapLink.payload(from: url), "abc-_123")
    }

    func testParsesQueryForm() throws {
        let url = try XCTUnwrap(URL(string: base + "?w1=abc-_123"))
        XCTAssertEqual(RecapLink.payload(from: url), "abc-_123")
    }

    func testParsesTheAppScheme() throws {
        let url = try XCTUnwrap(URL(string: "imessagewrapped://recap#w1=abc-_123"))
        XCTAssertEqual(RecapLink.payload(from: url), "abc-_123")
        let query = try XCTUnwrap(URL(string: "imessagewrapped://recap?w1=xyz"))
        XCTAssertEqual(RecapLink.payload(from: query), "xyz")
    }

    func testFragmentWinsOverQuery() throws {
        let url = try XCTUnwrap(URL(string: base + "?w1=fromquery#w1=fromfragment"))
        XCTAssertEqual(RecapLink.payload(from: url), "fromfragment")
    }

    func testParsesAroundOtherParameters() throws {
        let fragment = try XCTUnwrap(URL(string: base + "#utm=1&w1=abc&x=2"))
        XCTAssertEqual(RecapLink.payload(from: fragment), "abc")
        let query = try XCTUnwrap(URL(string: base + "index.html?embed=ios&w1=abc&demo=0"))
        XCTAssertEqual(RecapLink.payload(from: query), "abc")
        let embedded = try XCTUnwrap(URL(string: "file:///tmp/web/index.html?embed=ios#w1=abc"))
        XCTAssertEqual(RecapLink.payload(from: embedded), "abc")
    }

    func testLinksWithoutAPayload() throws {
        XCTAssertNil(RecapLink.payload(from: try XCTUnwrap(URL(string: base))))
        XCTAssertNil(RecapLink.payload(from: try XCTUnwrap(URL(string: base + "?demo=1"))))
        XCTAssertNil(RecapLink.payload(from: try XCTUnwrap(URL(string: base + "#w1="))))
        XCTAssertNil(RecapLink.payload(from: try XCTUnwrap(URL(string: base + "#xw1=abc"))))
        XCTAssertNil(RecapLink.recap(from: try XCTUnwrap(URL(string: base + "#w1=abc"))), "not a decodable recap")
    }

    func testFindsALinkInsidePastedText() throws {
        let vector = try PayloadVector.load()
        XCTAssertEqual(RecapLink.payload(inText: "look at this \(base)#w1=abc-_123 lol"), "abc-_123")
        XCTAssertEqual(RecapLink.payload(inText: "\(base)?x=1&w1=abc"), "abc")
        XCTAssertNil(RecapLink.payload(inText: "no link here, just w1 and = signs"))
        XCTAssertEqual(RecapLink.recap(inText: "Our year: \(vector.url)\nopen it!")?.summary.chatName, "Dinner Club 🍝")
    }

    // MARK: Building

    func testDefaultStoryURLIsTheVectorURL() throws {
        let vector = try PayloadVector.load()
        XCTAssertEqual(WrappedConfig.baseURLString, base)
        XCTAssertEqual(RecapLink.storyURL(payload: vector.payload, form: .fragment)?.absoluteString, vector.url)
    }

    func testQueryFormStoryURL() throws {
        let url = try XCTUnwrap(RecapLink.storyURL(payload: "abc-_123", form: .query))
        XCTAssertEqual(url.absoluteString, base + "?w1=abc-_123")
        XCTAssertEqual(RecapLink.payload(from: url), "abc-_123")
    }

    func testAppURLRoundTrip() throws {
        let url = try XCTUnwrap(RecapLink.appURL(payload: DemoRecap.payload))
        XCTAssertEqual(url.scheme, "imessagewrapped")
        XCTAssertEqual(url.host, "recap")
        XCTAssertEqual(RecapLink.recap(from: url), DemoRecap.recap)
    }

    func testBundledStoryPageExistsAndCarriesThePayload() throws {
        let location = try XCTUnwrap(
            RecapLink.bundledStoryLocation(payload: DemoRecap.payload),
            "web/index.html is missing from the app bundle (run ios/scripts/sync-web.sh before xcodegen)"
        )
        XCTAssertTrue(location.url.isFileURL)
        XCTAssertTrue(FileManager.default.fileExists(atPath: location.directory.appendingPathComponent("index.html").path))
        XCTAssertEqual(location.directory.lastPathComponent, "web")
        let components = try XCTUnwrap(URLComponents(url: location.url, resolvingAgainstBaseURL: false))
        XCTAssertEqual(components.queryItems?.first?.name, "embed")
        XCTAssertEqual(components.queryItems?.first?.value, "ios")
        XCTAssertEqual(components.fragment, "w1=" + DemoRecap.payload)
        XCTAssertEqual(RecapLink.payload(from: location.url), DemoRecap.payload)
    }

    // MARK: Length budget

    func testShortLinksAreNotTouched() throws {
        let vector = try PayloadVector.load()
        let fitted = try RecapLinkBuilder.fit(payload: vector.payload)
        XCTAssertEqual(fitted.trimSteps, 0)
        XCTAssertEqual(fitted.payload, vector.payload)
        XCTAssertEqual(fitted.url.absoluteString, vector.url)
        XCTAssertLessThanOrEqual(fitted.url.absoluteString.count, 4800)
    }

    func testEachTrimStepDoesWhatTheContractSays() throws {
        var stats = LargeRecap.stats()

        RecapLinkBuilder.applyTrimStep(1, to: &stats)
        let awardsAfter1 = try XCTUnwrap(stats["awards"] as? [[String: Any]])
        XCTAssertEqual(awardsAfter1.count, 6)
        XCTAssertTrue(awardsAfter1.allSatisfy { $0["detail"] == nil && $0["title"] != nil })

        RecapLinkBuilder.applyTrimStep(2, to: &stats)
        let reactedAfter2 = try XCTUnwrap(stats["most_reacted"] as? [[String: Any]])
        XCTAssertEqual(reactedAfter2.count, 3)
        for entry in reactedAfter2 {
            let text = try XCTUnwrap(entry["text"] as? String)
            XCTAssertEqual(text.count, 61)
            XCTAssertTrue(text.hasSuffix("…"))
        }

        RecapLinkBuilder.applyTrimStep(3, to: &stats)
        XCTAssertEqual((stats["senders"] as? [Any])?.count, 8)

        RecapLinkBuilder.applyTrimStep(4, to: &stats)
        XCTAssertEqual((stats["most_reacted"] as? [Any])?.count, 1)

        RecapLinkBuilder.applyTrimStep(5, to: &stats)
        XCTAssertNil(stats["awards"])

        RecapLinkBuilder.applyTrimStep(6, to: &stats)
        XCTAssertEqual((stats["senders"] as? [Any])?.count, 5)

        // Everything else is left alone.
        XCTAssertEqual((stats["by_hour"] as? [Any])?.count, 24)
        XCTAssertEqual((stats["totals"] as? [String: Any])?["messages"] as? Int, 123456)
    }

    func testShortQuotesAreNotTruncated() {
        let entry: [String: Any] = ["text": "short and sweet", "reactions": 3]
        var stats: [String: Any] = ["most_reacted": [entry]]
        RecapLinkBuilder.applyTrimStep(2, to: &stats)
        let entries = stats["most_reacted"] as? [[String: Any]]
        XCTAssertEqual(entries?.first?["text"] as? String, "short and sweet")
    }

    func testOversizedRecapIsTrimmedIntoTheBudget() throws {
        let payload = try RecapPayload.encode(object: LargeRecap.stats())
        let untrimmed = try XCTUnwrap(RecapLink.storyURL(payload: payload))
        XCTAssertGreaterThan(untrimmed.absoluteString.count, 4800, "the fixture must start over budget")

        let fitted = try RecapLinkBuilder.fit(payload: payload)
        XCTAssertGreaterThanOrEqual(fitted.trimSteps, 1)
        XCTAssertLessThanOrEqual(fitted.url.absoluteString.count, 4800)
        XCTAssertEqual(RecapLink.payload(from: fitted.url), fitted.payload)

        let recap = try Recap(payload: fitted.payload)
        XCTAssertEqual(recap.summary.chatName, "The Extremely Long Group Chat Name")
        XCTAssertEqual(recap.summary.totalMessages, 123456)
        XCTAssertEqual(recap.summary.topSenders.count, 3)
        print("WRAPPED_NOTE trim: \(untrimmed.absoluteString.count) characters fit in \(fitted.url.absoluteString.count) after \(fitted.trimSteps) step(s)")
    }

    func testLadderStopsAtTheFirstStepThatFits() throws {
        let payload = try RecapPayload.encode(object: LargeRecap.stats())

        // Link length after each cumulative step, computed the same way `fit` does.
        var stats = try RecapPayload.decodeObject(payload)
        var lengths: [Int] = []
        for step in 1...RecapLinkBuilder.trimStepCount {
            RecapLinkBuilder.applyTrimStep(step, to: &stats)
            let trimmed = try RecapPayload.encode(object: stats)
            lengths.append(try XCTUnwrap(RecapLink.storyURL(payload: trimmed)).absoluteString.count)
        }
        print("WRAPPED_NOTE ladder lengths: \(lengths)")

        for (offset, limit) in lengths.enumerated() {
            let expectedStep = (lengths.firstIndex { $0 <= limit } ?? offset) + 1
            let fitted = try RecapLinkBuilder.fit(payload: payload, limit: limit)
            XCTAssertEqual(fitted.trimSteps, expectedStep, "limit \(limit)")
            XCTAssertLessThanOrEqual(fitted.url.absoluteString.count, limit)
        }

        let smallest = try XCTUnwrap(lengths.min())
        XCTAssertThrowsError(try RecapLinkBuilder.fit(payload: payload, limit: smallest - 1)) { error in
            guard case RecapPayloadError.linkTooLong(_, let limit)? = error as? RecapPayloadError else {
                XCTFail("expected linkTooLong, got \(error)")
                return
            }
            XCTAssertEqual(limit, smallest - 1)
        }
    }

    func testQueryFormIsTrimmedToo() throws {
        let payload = try RecapPayload.encode(object: LargeRecap.stats())
        let fitted = try RecapLinkBuilder.fit(payload: payload, form: .query)
        XCTAssertLessThanOrEqual(fitted.url.absoluteString.count, 4800)
        XCTAssertNotNil(fitted.url.query)
        XCTAssertNil(fitted.url.fragment)
    }
}
