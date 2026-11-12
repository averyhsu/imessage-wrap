import AppKit
import XCTest

/// UI tests on the macOS runner: the onboarding screenshots (fixture data) and the
/// permission experiments (the real ~/Library/Messages, the system prompts).
class ThreadbackUITestCase: XCTestCase {
    var env: [String: String] { ProcessInfo.processInfo.environment }
    var reportDir: String { env["THREADBACK_REPORTS"] ?? NSTemporaryDirectory() + "threadback-probe" }

    override func setUp() {
        continueAfterFailure = true
    }

    func note(_ text: String) {
        print("WRAPPED_NOTE \(text.replacingOccurrences(of: "\n", with: " | "))")
    }

    /// Saves a screenshot to THREADBACK_SHOTS (published by CI) and to the result bundle.
    func save(_ shot: XCUIScreenshot, _ name: String) {
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let dir = env["THREADBACK_SHOTS"] {
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            try? shot.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
        }
    }

    func shootWindow(_ app: XCUIApplication, _ name: String) {
        let window = app.windows.firstMatch
        save(window.exists ? window.screenshot() : XCUIScreen.main.screenshot(), name)
    }

    func shootScreen(_ name: String) {
        save(XCUIScreen.main.screenshot(), name)
    }

    func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        return app.descendants(matching: .any).matching(identifier: id).firstMatch
    }

    func text(of element: XCUIElement) -> String {
        if let value = element.value as? String, !value.isEmpty { return value }
        return element.label
    }

    func launch(_ arguments: [String]) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-TBReportDir", reportDir] + arguments
        app.launch()
        return app
    }

    /// Looks for a system prompt in the processes macOS uses to show them, describes what it
    /// sees, and clicks the first of `allow` it finds. Returns the description.
    @discardableResult
    func answerSystemPrompt(_ allow: [String], app: XCUIApplication) -> String {
        var seen: [String] = []
        // Only bundle ids that exist: XCUIApplication asserts on an unknown one.
        let hosts = ["com.apple.UserNotificationCenter", "com.apple.coreservices.uiagent", "com.apple.SecurityAgent"]
        var targets: [(String, XCUIApplication)] = hosts.map { ($0, XCUIApplication(bundleIdentifier: $0)) }
        targets.append(("app under test", app))
        for (name, host) in targets {
            if name != "app under test" && host.state == .notRunning { continue }
            let dialogs = host.dialogs.count + host.alerts.count + host.sheets.count
            let labels = host.buttons.allElementsBoundByIndex.prefix(12).map { $0.label }.filter { !$0.isEmpty }
            let texts = host.staticTexts.allElementsBoundByIndex.prefix(6).map { text(of: $0) }.filter { !$0.isEmpty }
            seen.append("\(name) [state \(host.state.rawValue), \(dialogs) dialogs/alerts/sheets] buttons=\(labels) texts=\(texts.map { String($0.prefix(90)) })")
            // Each prompt is its own dialog: read it, then answer it inside that dialog.
            let windows = host.dialogs.allElementsBoundByIndex + host.alerts.allElementsBoundByIndex
            var clicked = false
            for (index, dialog) in windows.enumerated() {
                let words = dialog.staticTexts.allElementsBoundByIndex.prefix(6).map { text(of: $0) }.filter { !$0.isEmpty }
                let choices = dialog.buttons.allElementsBoundByIndex.prefix(6).map { $0.title.isEmpty ? $0.label : $0.title }
                seen.append("\(name) dialog \(index): texts=\(words.map { String($0.prefix(160)) }) buttons=\(choices)")
                for label in allow {
                    let button = dialog.buttons[label].firstMatch
                    if button.exists {
                        button.click()
                        seen.append("CLICKED \"\(label)\" in \(name) dialog \(index)")
                        clicked = true
                        break
                    }
                }
            }
            if clicked { return seen.joined(separator: " ;; ") }
        }
        return seen.isEmpty ? "no system prompt host is running" : seen.joined(separator: " ;; ")
    }
}

final class OnboardingUITests: ThreadbackUITestCase {
    /// Proof 5: the three onboarding screens with the invented fixture database.
    func testOnboardingWalkthroughWithFixture() throws {
        guard let fixture = env["THREADBACK_FIXTURE"] else { throw XCTSkip("THREADBACK_FIXTURE is not set") }
        let app = launch(["-TBResetOnboarding", "YES", "-TBDatabase", fixture + "/mac/chat.db",
                          "-TBContacts", fixture + "/mac/AddressBook", "-TBMe", "Amara", "-TBNoAutomation", "YES",
                          "-TBTimeZone", "America/Los_Angeles"])
        let next = element(app, "onboarding.continue")
        XCTAssertTrue(next.waitForExistence(timeout: 30), "the first-run window opens on launch")
        shootWindow(app, "onboarding-1-welcome")
        next.click()

        let connect = element(app, "onboarding.connect")
        XCTAssertTrue(connect.waitForExistence(timeout: 10))
        shootWindow(app, "onboarding-2-connect")
        connect.click()
        let connected = element(app, "onboarding.connected")
        XCTAssertTrue(connected.waitForExistence(timeout: 30))
        note("onboarding: \(text(of: connected))")
        shootWindow(app, "onboarding-2b-connected")
        element(app, "onboarding.toChats").click()

        let turnOn = element(app, "chat.turnOn.0")
        XCTAssertTrue(turnOn.waitForExistence(timeout: 10))
        shootWindow(app, "onboarding-3-choose-chat")
        turnOn.click()
        let ready = element(app, "onboarding.ready")
        XCTAssertTrue(ready.waitForExistence(timeout: 30))
        sleep(1)
        shootWindow(app, "onboarding-3b-on")

        // "Copy test report": what the owner pastes back. No names, chats or numbers in it.
        let copy = element(app, "onboarding.copyReport")
        XCTAssertTrue(copy.exists)
        NSPasteboard.general.clearContents()
        copy.click()
        sleep(1)
        let report = NSPasteboard.general.string(forType: .string) ?? ""
        note("test report copied by the app: \(report)")
        XCTAssertTrue(report.hasPrefix("Threadback test report"))
        for word in ["Amara", "Taco", "Book Club", "Ines", "Bram", "555", "chat1000"] {
            XCTAssertFalse(report.contains(word), "the copied report contains \(word)")
        }
        element(app, "onboarding.done").click()
        sleep(1)

        // The menu-bar item (best effort: status items are outside the app's windows).
        let item = app.statusItems.matching(NSPredicate(format: "label CONTAINS[c] 'Threadback' OR title CONTAINS[c] 'Threadback' OR identifier CONTAINS[c] 'Threadback'")).firstMatch
        note("status items seen by XCUITest: \(app.statusItems.allElementsBoundByIndex.prefix(8).map { "\($0.identifier)|\($0.label)|\($0.title)" })")
        if item.waitForExistence(timeout: 5) {
            item.click()
            sleep(1)
            shootScreen("onboarding-4-menu-bar")
            note("menu bar item found; menu items: \(app.menuItems.allElementsBoundByIndex.prefix(10).map { $0.title })")
            app.typeKey(.escape, modifierFlags: [])
        } else {
            note("menu bar item not found by XCUITest")
        }
    }
}

/// Proof 6: the Open panel instead of Full Disk Access, on the runner's real home folder.
final class AccessUITests: ThreadbackUITestCase {
    func test1_FolderGrantThroughOpenPanel() throws {
        let app = launch(["-TBResetOnboarding", "YES", "-TBMe", "Amara"])
        let next = element(app, "onboarding.continue")
        XCTAssertTrue(next.waitForExistence(timeout: 30))
        next.click()
        let connect = element(app, "onboarding.connect")
        XCTAssertTrue(connect.waitForExistence(timeout: 10))
        connect.click()

        let sheet = app.sheets.firstMatch
        let dialog = app.dialogs.firstMatch
        let appeared = sheet.waitForExistence(timeout: 15) || dialog.waitForExistence(timeout: 5)
        note("open panel appeared: \(appeared) (sheets \(app.sheets.count), dialogs \(app.dialogs.count))")
        sleep(2)
        shootScreen("access-1-open-panel-preset")
        let panel = sheet.exists ? sheet : dialog
        note("panel buttons: \(panel.buttons.allElementsBoundByIndex.prefix(12).map { $0.label })")

        // Go to the folder by hand as well (Command-Shift-G, the path, Return), in case the
        // preset location was not honoured.
        app.typeKey("g", modifierFlags: [.command, .shift])
        sleep(2)
        shootScreen("access-2-go-to-folder")
        app.typeText("~/Library/Messages")
        sleep(1)
        app.typeKey(.return, modifierFlags: [])
        sleep(2)
        shootScreen("access-3-in-messages-folder")

        let grant = panel.buttons["Grant Access"]
        if grant.exists && grant.isEnabled {
            grant.click()
            note("clicked Grant Access")
        } else {
            note("Grant Access button exists=\(grant.exists) enabled=\(grant.exists && grant.isEnabled); pressing Return")
            app.typeKey(.return, modifierFlags: [])
        }
        let connected = element(app, "onboarding.connected")
        let failed = element(app, "onboarding.connectError")
        var outcome = "neither"
        for _ in 0..<30 {
            if connected.exists { outcome = "CONNECTED: " + text(of: connected); break }
            if failed.exists { outcome = "FAILED: " + text(of: failed); break }
            sleep(1)
        }
        note("after the Open panel: \(outcome)")
        shootWindow(app, "access-4-after-grant")

        // Optional names: the Contacts prompt, if the connection worked.
        let contacts = element(app, "onboarding.contacts")
        if contacts.exists {
            contacts.click()
            sleep(3)
            shootScreen("access-5-contacts-prompt")
            note("contacts prompt: " + answerSystemPrompt(["Allow", "OK", "Allow Full Access"], app: app))
            sleep(3)
            shootWindow(app, "access-6-after-contacts")
        }
        app.terminate()
    }

    func test2_BookmarkRestoresAccessAfterRelaunch() throws {
        let app = launch(["-TBProbe", "bookmark", "-TBProbeTag", "relaunch"])
        let label = element(app, "experiment.note")
        if label.waitForExistence(timeout: 20) {
            note("bookmark probe: " + text(of: label))
            shootWindow(app, "access-7-relaunch-bookmark")
        }
        _ = app.wait(for: .notRunning, timeout: 30)
    }
}

/// Proofs 7 and 8: the Automation prompt and the login item, observed on the runner.
final class SystemPromptUITests: ThreadbackUITestCase {
    func testAutomationPrompt() throws {
        let app = launch(["-TBAutomationProbe", "YES", "-TBProbeTag", "ui"])
        let label = element(app, "experiment.note")
        XCTAssertTrue(label.waitForExistence(timeout: 30))
        var answered = ""
        for round in 1...25 {
            sleep(3)
            if round <= 3 { shootScreen("automation-\(round)-screen") }
            let now = text(of: label)
            if now.contains("AUTOMATION DONE") {
                note("automation finished after ~\(round * 3) s: \(now)")
                break
            }
            if !answered.contains("CLICKED") || round % 2 == 0 {
                let seen = answerSystemPrompt(["OK", "Allow"], app: app)
                note("automation round \(round): \(seen)")
                if seen.contains("CLICKED") { answered = seen }
            }
        }
        shootWindow(app, "automation-4-result")
        note("automation final: " + text(of: label))
        app.terminate()
    }

    func testContactsPrompt() throws {
        let app = launch(["-TBContactsProbe", "YES", "-TBProbeTag", "ui"])
        let label = element(app, "experiment.note")
        XCTAssertTrue(label.waitForExistence(timeout: 30))
        sleep(3)
        shootScreen("contacts-1-screen")
        note("contacts prompt: " + answerSystemPrompt(["OK", "Allow", "Allow Full Access"], app: app))
        for _ in 0..<10 where !text(of: label).contains("CONTACTS DONE") { sleep(2) }
        note("contacts final: " + text(of: label))
        app.terminate()
    }

    func testLoginItem() throws {
        let app = launch(["-TBLoginItemProbe", "YES", "-TBProbeTag", "ui"])
        let label = element(app, "experiment.note")
        XCTAssertTrue(label.waitForExistence(timeout: 30))
        sleep(3)
        shootScreen("login-item-1-screen")
        note("login item after register: " + text(of: label))
        for _ in 0..<15 where !text(of: label).contains("LOGIN ITEM DONE") { sleep(2) }
        note("login item final: " + text(of: label))
        app.terminate()
    }
}
