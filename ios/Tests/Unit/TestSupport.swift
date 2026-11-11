import UIKit
import XCTest
@testable import Wrapped

/// The cross-language payload vector (`tests/vectors/payload-v1.json`), copied into the
/// test bundle by `scripts/sync-web.sh`.
struct PayloadVector {
    let stats: NSDictionary
    let statsJSON: Data
    let payload: String
    let url: String

    static func load(file: StaticString = #filePath, line: UInt = #line) throws -> PayloadVector {
        let bundle = Bundle(for: BundleMarker.self)
        guard let location = bundle.url(forResource: "payload-v1", withExtension: "json") else {
            XCTFail("payload-v1.json is not in the test bundle. Run ios/scripts/sync-web.sh, then xcodegen.", file: file, line: line)
            throw CocoaError(.fileNoSuchFile)
        }
        let data = try Data(contentsOf: location)
        let root = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any], file: file, line: line)
        let stats = try XCTUnwrap(root["stats"] as? [String: Any], file: file, line: line)
        let payload = try XCTUnwrap(root["payload"] as? String, file: file, line: line)
        let url = try XCTUnwrap(root["url"] as? String, file: file, line: line)
        let statsJSON = try JSONSerialization.data(withJSONObject: stats, options: [.sortedKeys])
        return PayloadVector(stats: stats as NSDictionary, statsJSON: statsJSON, payload: payload, url: url)
    }
}

private final class BundleMarker {}

/// Writes images produced by tests to the directory CI collects (`WRAPPED_ARTIFACTS_DIR`,
/// passed to the test runner as `TEST_RUNNER_WRAPPED_ARTIFACTS_DIR`) and attaches them to
/// the test report.
enum TestArtifacts {
    static func save(_ image: UIImage, named name: String, in testCase: XCTestCase) {
        let attachment = XCTAttachment(image: image)
        attachment.name = name
        attachment.lifetime = .keepAlways
        testCase.add(attachment)

        guard let directory = ProcessInfo.processInfo.environment["WRAPPED_ARTIFACTS_DIR"],
              !directory.isEmpty,
              let data = image.pngData() else {
            return
        }
        let folder = URL(fileURLWithPath: directory, isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try? data.write(to: folder.appendingPathComponent(name + ".png"))
    }
}

/// Deterministic pseudo-random text, so "large recap" tests do not depend on a seed.
struct SeededText {
    private var state: UInt64

    init(seed: UInt64) {
        state = seed
    }

    mutating func next() -> UInt64 {
        state = state &* 6364136223846793005 &+ 1442695040888963407
        return state >> 33
    }

    mutating func word() -> String {
        let letters = Array("abcdefghijklmnopqrstuvwxyz")
        let length = 3 + Int(next() % 7)
        var result = ""
        for _ in 0..<length {
            result.append(letters[Int(next() % UInt64(letters.count))])
        }
        return result
    }

    mutating func sentence(characters: Int) -> String {
        var result = ""
        while result.count < characters {
            if !result.isEmpty {
                result += " "
            }
            result += word()
        }
        return String(result.prefix(characters))
    }
}

/// A stats object that is too large for the link budget until it is trimmed.
enum LargeRecap {
    static func stats() -> [String: Any] {
        var text = SeededText(seed: 20261111)
        var senders: [[String: Any]] = []
        for index in 0..<12 {
            senders.append([
                "name": text.sentence(characters: 22),
                "messages": 9000 - index * 500,
                "share": 0.0833,
                "words": 40000 - index * 1000,
                "attachments": 100 + index,
                "late_night": 50 + index,
                "reactions_given": 300 + index,
                "reactions_received": 280 + index
            ])
        }
        var mostReacted: [[String: Any]] = []
        for index in 0..<3 {
            let kinds: [String: Any] = ["laugh": 9, "love": 6, "emphasize": 5 - index]
            mostReacted.append([
                "sender": text.sentence(characters: 18),
                "reactions": 20 - index,
                "date": "2026-03-1\(index)",
                "text": text.sentence(characters: 900),
                "kinds": kinds
            ])
        }
        var awards: [[String: Any]] = []
        for index in 0..<6 {
            awards.append([
                "id": "award_\(index)",
                "emoji": "⭐",
                "title": text.sentence(characters: 24),
                "winner": text.sentence(characters: 18),
                "detail": text.sentence(characters: 700)
            ])
        }
        let chat: [String: Any] = ["name": "The Extremely Long Group Chat Name", "members": 14]
        let period: [String: Any] = ["label": "2026", "start": "2026-01-01", "end": "2026-11-10"]
        let totals: [String: Any] = [
            "messages": 123456,
            "words": 654321,
            "attachments": 4321,
            "reactions": 9876,
            "days_active": 300,
            "longest_streak": 77
        ]
        let personality: [String: Any] = [
            "id": "always_on",
            "title": "The Always-On Group Chat",
            "blurb": "Peak hour: 3 PM. There is no off switch.",
            "peak_hour": 15
        ]
        let meta: [String: Any] = ["generator": "test", "source": "invented", "generated": "2026-11-11"]

        var stats: [String: Any] = [:]
        stats["v"] = 1
        stats["chat"] = chat
        stats["period"] = period
        stats["totals"] = totals
        stats["by_hour"] = Array(repeating: 5144, count: 24)
        stats["by_weekday"] = Array(repeating: 17636, count: 7)
        stats["by_month"] = Array(repeating: 10288, count: 12)
        stats["personality"] = personality
        stats["senders"] = senders
        stats["most_reacted"] = mostReacted
        stats["awards"] = awards
        stats["meta"] = meta
        return stats
    }
}
