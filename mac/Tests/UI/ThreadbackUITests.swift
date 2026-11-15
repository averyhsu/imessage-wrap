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

    /// Clicks Turn on for a chat in the chooser, then Turn on in the sheet that says what it
    /// means (nothing is turned on before that click). Returns the sheet's words.
    @discardableResult
    func turnOnChat(_ app: XCUIApplication, _ index: Int, shot: String? = nil) -> String {
        let button = element(app, "chat.turnOn.\(index)")
        XCTAssertTrue(button.waitForExistence(timeout: 10))
        button.click()
        let sheet = app.sheets.firstMatch
        XCTAssertTrue(sheet.waitForExistence(timeout: 10), "Turn on first says what it means")
        let words = sheet.staticTexts.allElementsBoundByIndex.map { text(of: $0) }.joined(separator: " | ")
        if let shot { shootWindow(app, shot) }
        XCTAssertFalse(element(app, "onboarding.ready").exists, "nothing is on before the click")
        sheet.buttons["Turn on"].click()
        return words
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

        XCTAssertTrue(element(app, "chat.turnOn.0").waitForExistence(timeout: 10))
        shootWindow(app, "onboarding-3-choose-chat")
        let consent = turnOnChat(app, 0, shot: "onboarding-3a-consent")
        note("consent sheet: \(consent)")
        for words in ["three messages", "Apple ID", "once every 2 minutes", "forwarded"] {
            XCTAssertTrue(consent.contains(words), "the consent sheet says \(words)")
        }
        let ready = element(app, "onboarding.ready")
        XCTAssertTrue(ready.waitForExistence(timeout: 30))
        // The real card (the site's 1080 x 1350 card) appears in the preview.
        XCTAssertTrue(element(app, "onboarding.card").waitForExistence(timeout: 40), "the preview shows the card")
        sleep(1)
        shootWindow(app, "onboarding-3b-on")
        note("preview text: \(text(of: element(app, "onboarding.text")))")

        // Play the story: the bundled web story in its own window, on this Mac only.
        element(app, "onboarding.playStory").click()
        let story = app.windows.matching(identifier: "threadback.story").firstMatch
        XCTAssertTrue(story.waitForExistence(timeout: 20), "the story window opens")
        var title = ""
        for _ in 0..<30 {
            title = story.title
            if title.contains("slide") { break }
            sleep(1)
        }
        note("story window after loading: \(title)")
        XCTAssertTrue(title.contains("slide 1 of"), "the story reports ready")
        sleep(2)
        shootWindow(app, "story-1-playing")
        app.typeKey(.rightArrow, modifierFlags: [])
        sleep(2)
        let after = story.title
        note("story window after the right arrow: \(after)")
        XCTAssertTrue(after.contains("slide 2 of"), "the right arrow advances the story")
        shootWindow(app, "story-2-next")
        story.buttons[XCUIIdentifierCloseWindow].click()
        sleep(1)

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
        // The first close with a chat on says where Threadback goes.
        let sheet = app.sheets.firstMatch
        if sheet.waitForExistence(timeout: 5) {
            shootWindow(app, "onboarding-4-keeps-answering")
            note("closing the window says: \(sheet.staticTexts.allElementsBoundByIndex.map { text(of: $0) })")
            sheet.buttons["OK"].click()
        }
        sleep(1)
        app.terminate()
    }
}

/// The lifecycle: never running invisibly by surprise.
final class LifecycleUITests: ThreadbackUITestCase {
    /// Opens the running app again the way Finder, Spotlight or Launchpad do (a reopen).
    func reopen() {
        let running = NSRunningApplication.runningApplications(withBundleIdentifier: "io.github.averyhsu.threadback.mac").first
        guard let url = running?.bundleURL else { return }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        let done = expectation(description: "opened")
        NSWorkspace.shared.openApplication(at: url, configuration: configuration) { _, error in
            if let error { print("WRAPPED_NOTE reopen error: \(error)") }
            done.fulfill()
        }
        wait(for: [done], timeout: 20)
    }

    /// More than one chat: Add a chat, two rows, turn one off, Pause all.
    func test5_TwoChatsAddTurnOffPause() throws {
        let app = try setUpFixture()
        XCTAssertTrue(element(app, "onboarding.continue").waitForExistence(timeout: 30))
        element(app, "onboarding.continue").click()
        element(app, "onboarding.connect").click()
        XCTAssertTrue(element(app, "onboarding.toChats").waitForExistence(timeout: 30))
        element(app, "onboarding.toChats").click()
        turnOnChat(app, 0)
        XCTAssertTrue(element(app, "onboarding.ready").waitForExistence(timeout: 30))
        element(app, "onboarding.done").click()
        let sheet = app.sheets.firstMatch
        if sheet.waitForExistence(timeout: 10) { sheet.buttons["OK"].click() }
        sleep(2)
        reopen()
        XCTAssertTrue(element(app, "status.addChat").waitForExistence(timeout: 15))
        element(app, "status.addChat").click()
        XCTAssertTrue(element(app, "chat.isOn.0").waitForExistence(timeout: 15), "the chooser marks the chat that is on")
        turnOnChat(app, 1)
        XCTAssertTrue(element(app, "onboarding.ready").waitForExistence(timeout: 30))
        element(app, "onboarding.done").click()
        sleep(2)
        reopen()
        XCTAssertTrue(element(app, "status.last.1").waitForExistence(timeout: 15), "two chats are listed")
        shootWindow(app, "status-1-two-chats")
        note("status with two chats: \(text(of: element(app, "status.access"))) | \(text(of: element(app, "status.last.0"))) | \(text(of: element(app, "status.about")))")
        element(app, "status.turnOff.1").click()
        XCTAssertTrue(element(app, "status.turnOffNote").waitForExistence(timeout: 10))
        XCTAssertFalse(element(app, "status.last.1").exists, "one chat is left")
        element(app, "status.pause").click()
        sleep(1)
        XCTAssertEqual(text(of: element(app, "status.title")), "Paused.")
        shootWindow(app, "status-2-one-off-paused")
        element(app, "status.quit").click()
        XCTAssertTrue(app.wait(for: .notRunning, timeout: 15))
    }

    private func setUpFixture(reset: Bool = true, extra: [String] = []) throws -> XCUIApplication {
        guard let fixture = env["THREADBACK_FIXTURE"] else { throw XCTSkip("THREADBACK_FIXTURE is not set") }
        return launch((reset ? ["-TBResetOnboarding", "YES"] : []) + ["-TBDatabase", fixture + "/mac/chat.db",
                       "-TBContacts", fixture + "/mac/AddressBook", "-TBMe", "Amara", "-TBNoAutomation", "YES",
                       "-TBTimeZone", "America/Los_Angeles"] + extra)
    }

    /// Test 1 (the app): Pause all lasts across a relaunch, and the menu bar says the same.
    /// Then a chat whose stored approval is for what replies used to carry is not answered
    /// until the owner clicks Keep on in the sheet that says what changed.
    func test6_PauseLastsAcrossARelaunchAndAChangedReplyAsksAgain() throws {
        let app = try setUpFixture()
        XCTAssertTrue(element(app, "onboarding.continue").waitForExistence(timeout: 30))
        element(app, "onboarding.continue").click()
        element(app, "onboarding.connect").click()
        XCTAssertTrue(element(app, "onboarding.toChats").waitForExistence(timeout: 30))
        element(app, "onboarding.toChats").click()
        turnOnChat(app, 0)
        XCTAssertTrue(element(app, "onboarding.ready").waitForExistence(timeout: 30))
        element(app, "onboarding.done").click()
        let told = app.sheets.firstMatch
        if told.waitForExistence(timeout: 10) { told.buttons["OK"].click() }
        sleep(2)
        reopen()
        XCTAssertTrue(element(app, "status.pause").waitForExistence(timeout: 15))
        element(app, "status.pause").click()
        sleep(1)
        XCTAssertEqual(text(of: element(app, "status.title")), "Paused.")
        app.terminate()

        let again = try setUpFixture(reset: false)
        let title = element(again, "status.title")
        XCTAssertTrue(title.waitForExistence(timeout: 30))
        XCTAssertEqual(text(of: title), "Paused.", "still paused after a relaunch")
        XCTAssertEqual(text(of: element(again, "status.pause")), "Resume")
        note("after a relaunch: \(text(of: title))")
        again.terminate()

        let third = try setUpFixture(reset: false, extra: ["-TBForgetSignatures", "YES"])
        let sheet = third.sheets.firstMatch
        XCTAssertTrue(sheet.waitForExistence(timeout: 30), "a changed reply asks again")
        let words = sheet.staticTexts.allElementsBoundByIndex.map { text(of: $0) }.joined(separator: " | ")
        note("replies-changed sheet: \(words)")
        XCTAssertTrue(words.contains("now include a link"))
        XCTAssertTrue(words.contains("Nothing is sent in this chat until you choose"))
        XCTAssertTrue(text(of: element(third, "status.last.0")).contains("Not answering"), "the chat waits for the click")
        shootWindow(third, "status-3-replies-changed")
        sheet.buttons["Keep on"].click()
        sleep(1)
        XCTAssertFalse(text(of: element(third, "status.last.0")).contains("Not answering"))
        third.terminate()
    }

    /// Test 2 (the app): a second copy does not run alongside the first. It brings the first
    /// one's window forward and quits, so a /wrapped is answered once.
    func test7_ASecondCopyShowsTheFirstAndQuits() throws {
        let app = launch(["-TBResetOnboarding", "YES"])
        XCTAssertTrue(element(app, "onboarding.continue").waitForExistence(timeout: 30))
        let bundle = "io.github.averyhsu.threadback.mac"
        let url = try XCTUnwrap(NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first?.bundleURL)
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.createsNewApplicationInstance = true
        let opened = expectation(description: "second copy launched")
        NSWorkspace.shared.openApplication(at: url, configuration: configuration) { _, error in
            if let error { print("WRAPPED_NOTE second copy error: \(error)") }
            opened.fulfill()
        }
        wait(for: [opened], timeout: 30)
        var copies = 0
        var most = 0
        for _ in 0..<20 {
            copies = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).filter { !$0.isTerminated }.count
            most = max(most, copies)
            if copies == 1 && most == 2 { break }
            sleep(1)
        }
        note("single instance: at most \(most) copies running, \(copies) after the second launch")
        XCTAssertEqual(copies, 1, "the second copy quit")
        XCTAssertNotEqual(app.state, .notRunning, "the first copy still runs")
        XCTAssertTrue(element(app, "onboarding.continue").exists, "with its window")
        app.terminate()
    }

    func test1_ClosingTheWindowBeforeSetupQuits() throws {
        let app = launch(["-TBResetOnboarding", "YES"])
        XCTAssertTrue(element(app, "onboarding.continue").waitForExistence(timeout: 30))
        app.typeKey("w", modifierFlags: .command)
        XCTAssertTrue(app.wait(for: .notRunning, timeout: 15), "closing the window before a chat is on quits Threadback")
        note("lifecycle: window closed before setup -> state \(app.state.rawValue) (1 = not running)")
    }

    func test2_QuitButtonQuits() throws {
        let app = launch(["-TBResetOnboarding", "YES"])
        let quit = element(app, "onboarding.quit")
        XCTAssertTrue(quit.waitForExistence(timeout: 30))
        quit.click()
        XCTAssertTrue(app.wait(for: .notRunning, timeout: 15), "the Quit button quits")
    }

    func test3_CommandQQuits() throws {
        let app = launch(["-TBResetOnboarding", "YES"])
        XCTAssertTrue(element(app, "onboarding.continue").waitForExistence(timeout: 30))
        shootScreen("lifecycle-0-dock-and-menu")
        app.typeKey("q", modifierFlags: .command)
        XCTAssertTrue(app.wait(for: .notRunning, timeout: 15), "Command-Q quits")
    }

    func test4_WithAChatOnItKeepsRunningAndOpeningAgainShowsTheWindow() throws {
        let app = try setUpFixture()
        XCTAssertTrue(element(app, "onboarding.continue").waitForExistence(timeout: 30))
        element(app, "onboarding.continue").click()
        element(app, "onboarding.connect").click()
        XCTAssertTrue(element(app, "onboarding.toChats").waitForExistence(timeout: 30))
        element(app, "onboarding.toChats").click()
        turnOnChat(app, 0)
        XCTAssertTrue(element(app, "onboarding.ready").waitForExistence(timeout: 30))
        element(app, "onboarding.done").click()
        let sheet = app.sheets.firstMatch
        XCTAssertTrue(sheet.waitForExistence(timeout: 10), "the first close explains the menu bar")
        sheet.buttons["OK"].click()
        sleep(3)
        XCTAssertNotEqual(app.state, .notRunning, "with a chat on, closing the window keeps Threadback running")
        XCTAssertFalse(element(app, "onboarding.ready").exists, "the window is gone")
        shootScreen("lifecycle-1-window-closed")
        note("lifecycle: with a chat on, after closing the window: state \(app.state.rawValue), windows \(app.windows.count)")

        reopen()
        let title = element(app, "status.title")
        XCTAssertTrue(title.waitForExistence(timeout: 15), "opening Threadback again shows its window")
        shootWindow(app, "lifecycle-2-opened-again")
        note("lifecycle: opened again -> \(text(of: title)); uninstall line present: \(element(app, "status.uninstall").exists)")
        element(app, "status.quit").click()
        XCTAssertTrue(app.wait(for: .notRunning, timeout: 15), "Quit Threadback in the window quits")
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
