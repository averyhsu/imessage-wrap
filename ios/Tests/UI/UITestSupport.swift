import XCTest

/// Screenshots and notes from UI tests.
///
/// Each screenshot is attached to the test report and, when `WRAPPED_ARTIFACTS_DIR` is set
/// (CI passes it as `TEST_RUNNER_WRAPPED_ARTIFACTS_DIR`), written there as a PNG so the
/// workflow can upload and publish it.
enum UIArtifacts {
    static var directory: URL? {
        guard let path = ProcessInfo.processInfo.environment["WRAPPED_ARTIFACTS_DIR"], !path.isEmpty else {
            return nil
        }
        return URL(fileURLWithPath: path, isDirectory: true)
    }

    static func snap(_ name: String, in testCase: XCTestCase) {
        let screenshot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        testCase.add(attachment)

        guard let directory = directory else {
            return
        }
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try? screenshot.pngRepresentation.write(to: directory.appendingPathComponent(name + ".png"))
    }

    /// Prints a line the CI wrapper echoes into the job log.
    static func note(_ text: String) {
        print("WRAPPED_NOTE \(text)")
    }

    /// Writes an app's accessibility hierarchy to `<artifacts>/debug/<name>.txt`, so a
    /// system app's UI can be explored from CI without seeing the screen.
    static func dumpToFile(_ app: XCUIApplication, name: String) {
        let text = app.debugDescription
        let lineCount = text.split(separator: "\n", omittingEmptySubsequences: true).count
        note("hierarchy dump \(name): \(lineCount) lines")
        guard let directory = directory else {
            return
        }
        let folder = directory.appendingPathComponent("debug", isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try? text.write(to: folder.appendingPathComponent(name + ".txt"), atomically: true, encoding: .utf8)
    }
}

extension XCUIElement {
    /// Taps the element if it shows up in time. Returns whether it was tapped.
    @discardableResult
    func tapIfExists(timeout: TimeInterval = 2) -> Bool {
        if waitForExistence(timeout: timeout), isHittable {
            tap()
            return true
        }
        return false
    }
}
