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

    /// The one-time "keeps answering from the menu bar" notice: if it appears within
    /// `timeout`, clicks OK once it can be clicked and checks that it went away. Returns
    /// whether it appeared.
    @discardableResult
    func dismissMenuBarNotice(_ app: XCUIApplication, timeout: TimeInterval, _ label: String) -> Bool {
        // The notice is the only sheet with a "Quit Threadback" button.
        var sheet: XCUIElement?
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            let first = app.sheets.firstMatch
            if first.exists, first.buttons["Quit Threadback"].exists { sheet = first; break }
            usleep(250_000)
        } while Date() < deadline
        guard let sheet else {
            note("menu-bar notice (\(label)): not shown")
            return false
        }
        let ok = sheet.buttons["OK"]
        XCTAssertTrue(ok.waitForExistence(timeout: 5))
        for _ in 0..<20 where !ok.isHittable { usleep(100_000) }
        ok.click()
        let gone = sheet.waitForNonExistence(timeout: 5)
        XCTAssertTrue(gone, "the notice goes away when OK is clicked (\(label))")
        note("menu-bar notice (\(label)): shown, OK clicked, gone \(gone)")
        return true
    }

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

    /// Onboarding with one chat, close, Add a chat, a second chat, close, reopen: how many
    /// menu-bar notices appeared, and what is on the status window at the end.
    func twoChatWalk(_ app: XCUIApplication) -> (notices: Int, sheetsOverStatus: Int, turnedOff: Bool) {
        var notices = 0
        XCTAssertTrue(element(app, "onboarding.continue").waitForExistence(timeout: 30))
        element(app, "onboarding.continue").click()
        element(app, "onboarding.connect").click()
        XCTAssertTrue(element(app, "onboarding.toChats").waitForExistence(timeout: 30))
        element(app, "onboarding.toChats").click()
        turnOnChat(app, 0)
        XCTAssertTrue(element(app, "onboarding.ready").waitForExistence(timeout: 30))
        element(app, "onboarding.done").click()
        if dismissMenuBarNotice(app, timeout: 10, "walk, first close") { notices += 1 }
        sleep(2)
        reopen()
        XCTAssertTrue(element(app, "status.addChat").waitForExistence(timeout: 15))
        if app.sheets.count > 0, dismissMenuBarNotice(app, timeout: 1, "walk, after reopen") { notices += 1 }
        element(app, "status.addChat").click()
        guard element(app, "chat.turnOn.1").waitForExistence(timeout: 15) else { return (notices, app.sheets.count, false) }
        turnOnChat(app, 1)
        XCTAssertTrue(element(app, "onboarding.ready").waitForExistence(timeout: 30))
        sleep(2)
        let beforeDone = app.sheets.count
        element(app, "onboarding.done").click()
        sleep(2)
        reopen()
        _ = element(app, "status.last.1").waitForExistence(timeout: 15)
        sleep(1)
        let over = app.sheets.count
        note("walk: \(notices) notice(s) dismissed; sheets after the second chat's consent \(beforeDone); sheets over the status window \(over)")
        if over > 0 {
            shootWindow(app, "status-9-notice-over-status")
            if dismissMenuBarNotice(app, timeout: 1, "walk, over the status window") { notices += 1 }
        }
        element(app, "status.turnOff.1").click()
        let turnedOff = element(app, "status.turnOffNote").waitForExistence(timeout: 10)
        return (notices, over, turnedOff)
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
        // The first close with a chat on explains the menu bar: once per install, never again.
        XCTAssertTrue(dismissMenuBarNotice(app, timeout: 10, "first close"), "the first close explains the menu bar")
        sleep(2)
        reopen()
        XCTAssertTrue(element(app, "status.addChat").waitForExistence(timeout: 15))
        XCTAssertEqual(app.sheets.count, 0, "nothing is left on the window after the notice")
        element(app, "status.addChat").click()
        XCTAssertTrue(element(app, "chat.isOn.0").waitForExistence(timeout: 15), "the chooser marks the chat that is on")
        turnOnChat(app, 1)
        XCTAssertTrue(element(app, "onboarding.ready").waitForExistence(timeout: 30))
        element(app, "onboarding.done").click()
        XCTAssertFalse(dismissMenuBarNotice(app, timeout: 4, "second close"), "the menu-bar notice appears only once per install")
        sleep(2)
        reopen()
        XCTAssertTrue(element(app, "status.last.1").waitForExistence(timeout: 15), "two chats are listed")
        XCTAssertEqual(app.sheets.count, 0, "no sheet over the status window")
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

    /// Test 8: a second close request while the notice is up (as a double click on Done
    /// sends) still gives one notice, and nothing is left on the window for later.
    func test8_ASecondCloseRequestNeverStacksASecondNotice() throws {
        let app = try setUpFixture(extra: ["-TBDoubleClose", "YES"])
        let walk = twoChatWalk(app)
        XCTAssertEqual(walk.notices, 1, "one notice per install, whatever the close requests")
        XCTAssertEqual(walk.sheetsOverStatus, 0, "no notice over the status window later")
        XCTAssertTrue(walk.turnedOff, "Turn off works after the walk")
        app.terminate()
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
        // The first copy, set up with a chat on.
        let app = try setUpFixture()
        XCTAssertTrue(element(app, "onboarding.continue").waitForExistence(timeout: 30))
        element(app, "onboarding.continue").click()
        element(app, "onboarding.connect").click()
        XCTAssertTrue(element(app, "onboarding.toChats").waitForExistence(timeout: 30))
        element(app, "onboarding.toChats").click()
        turnOnChat(app, 0)
        XCTAssertTrue(element(app, "onboarding.ready").waitForExistence(timeout: 30))

        // A second copy, launched with the flag that would wipe every setting. The copies are
        // followed by process id: XCTest's own handle can switch to the second copy.
        let bundle = "io.github.averyhsu.threadback.mac"
        let running = { NSRunningApplication.runningApplications(withBundleIdentifier: bundle).filter { !$0.isTerminated } }
        let first = try XCTUnwrap(running().first)
        XCTAssertEqual(running().count, 1)
        let url = try XCTUnwrap(first.bundleURL)
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.createsNewApplicationInstance = true
        configuration.arguments = ["-TBResetOnboarding", "YES"]
        var secondPid: pid_t = 0
        let opened = expectation(description: "second copy launched")
        NSWorkspace.shared.openApplication(at: url, configuration: configuration) { second, error in
            if let error { print("WRAPPED_NOTE second copy error: \(error)") }
            secondPid = second?.processIdentifier ?? 0
            opened.fulfill()
        }
        wait(for: [opened], timeout: 30)
        var secondGone = false
        for _ in 0..<40 {
            secondGone = secondPid != 0 && kill(secondPid, 0) != 0
            if secondGone { break }
            usleep(500_000)
        }
        let firstAlive = kill(first.processIdentifier, 0) == 0
        note("single instance: first copy pid \(first.processIdentifier) alive \(firstAlive); second copy pid \(secondPid) quit \(secondGone); copies now \(running().count)")
        XCTAssertTrue(secondGone, "the second copy quit")
        XCTAssertTrue(firstAlive, "the first copy still runs")
        XCTAssertEqual(running().map(\.processIdentifier), [first.processIdentifier], "only the first copy is left")

        // Quit the first copy, then open Threadback again: the chat is still on, so the
        // second copy changed nothing.
        _ = first.terminate()
        for _ in 0..<30 where kill(first.processIdentifier, 0) == 0 { usleep(500_000) }
        if kill(first.processIdentifier, 0) == 0 { _ = first.forceTerminate() }
        let again = try setUpFixture(reset: false)
        let title = element(again, "status.title")
        XCTAssertTrue(title.waitForExistence(timeout: 30))
        XCTAssertEqual(text(of: title), "On.", "the second copy did not reset the settings")
        XCTAssertTrue(element(again, "status.last.0").exists, "the chat is still on")
        note("after a second copy launched with the reset flag: \(text(of: title))")
        again.terminate()
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

/// Diagnostics for run 43710352298 (not part of the pass/fail gate): the menu-bar notice as
/// it was then (-TBNoticeLegacy), with and without a second close request, to show which
/// sequence leaves a notice over the status window after the second chat is turned on.
final class NoticeDiagnosticsUITests: ThreadbackUITestCase {
    private func run(_ extra: [String], _ label: String) throws {
        guard let fixture = env["THREADBACK_FIXTURE"] else { throw XCTSkip("THREADBACK_FIXTURE is not set") }
        let app = launch(["-TBResetOnboarding", "YES", "-TBDatabase", fixture + "/mac/chat.db",
                          "-TBContacts", fixture + "/mac/AddressBook", "-TBMe", "Amara", "-TBNoAutomation", "YES",
                          "-TBTimeZone", "America/Los_Angeles"] + extra)
        let walk = twoChatWalk(app)
        note("diagnostic \(label): notices \(walk.notices), sheets over the status window \(walk.sheetsOverStatus), Turn off worked \(walk.turnedOff)")
        app.terminate()
    }

    func testLegacyNoticeOneCloseRequest() throws { try run(["-TBNoticeLegacy", "YES"], "legacy notice, one close request") }
    func testLegacyNoticeTwoCloseRequests() throws { try run(["-TBNoticeLegacy", "YES", "-TBDoubleClose", "YES"], "legacy notice, two close requests") }
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
