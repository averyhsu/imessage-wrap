import UIKit
import WebKit
import XCTest
@testable import Wrapped

/// The web view that plays the story: it is warmed up before a story is asked for, it only
/// listens to the main frame of the bundled page, and it never leaves that page.
/// These run inside the containing app on the Simulator, with a real `WKWebView`.
@MainActor
final class StoryWebViewTests: XCTestCase {
    private final class Recorder: StoryWebViewOwner {
        var messages: [String] = []
        var opened: [URL] = []
        var failures: [String] = []
        var finishedLoading = 0

        func storyWebView(_ story: StoryWebView, didReceive type: String, body: [String: Any]) {
            messages.append(type)
        }

        func storyWebViewDidFinishLoading(_ story: StoryWebView) {
            finishedLoading += 1
        }

        func storyWebView(_ story: StoryWebView, didFailWith reason: String) {
            failures.append(reason)
        }

        func storyWebView(_ story: StoryWebView, wantsToOpen url: URL) {
            opened.append(url)
        }
    }

    /// Lets the main run loop turn (WebKit calls back on it) until `done` or the timeout.
    @discardableResult
    private func spin(_ timeout: TimeInterval, until done: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while !done() {
            if Date() >= deadline {
                return false
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        }
        return true
    }

    private func hostWindow() -> UIWindow? {
        for scene in UIApplication.shared.connectedScenes {
            if let windowScene = scene as? UIWindowScene, let window = windowScene.windows.first {
                return window
            }
        }
        return nil
    }

    /// Evaluates a script that returns a string and waits for the answer.
    private func ask(_ story: StoryWebView, _ script: String) -> String? {
        var answer: String?
        var answered = false
        story.evaluate(script) { (result: Any?, error: Error?) in
            answer = result as? String
            answered = true
        }
        spin(10) { answered }
        return answer
    }

    private func isOnTheStoryPage(_ story: StoryWebView) -> Bool {
        guard let url = story.webView.url else {
            return false
        }
        return url.isFileURL && url.lastPathComponent == "index.html"
    }

    // MARK: Rules (no web view needed beyond construction)

    func testOnlyTheMainFrameOfTheBundledPageIsHeard() throws {
        let story = StoryWebView()
        let page = try XCTUnwrap(RecapLink.bundledStoryLocation(payload: nil)).url
        let playing = try XCTUnwrap(RecapLink.bundledStoryLocation(payload: DemoRecap.payload)).url
        let sibling = page.deletingLastPathComponent().appendingPathComponent("other.html")

        XCTAssertTrue(story.acceptsMessage(fromMainFrame: true, frameURL: page))
        XCTAssertTrue(story.acceptsMessage(fromMainFrame: true, frameURL: playing), "the #fragment does not matter")

        XCTAssertFalse(story.acceptsMessage(fromMainFrame: false, frameURL: page), "a frame, even one showing the page")
        XCTAssertFalse(story.acceptsMessage(fromMainFrame: true, frameURL: sibling), "another file next to the page")
        XCTAssertFalse(story.acceptsMessage(fromMainFrame: true, frameURL: URL(string: "https://averyhsu.github.io/imessage-wrap/index.html")))
        XCTAssertFalse(story.acceptsMessage(fromMainFrame: true, frameURL: URL(string: "https://example.com/web/index.html")))
        XCTAssertFalse(story.acceptsMessage(fromMainFrame: true, frameURL: URL(string: "about:blank")))
        XCTAssertFalse(story.acceptsMessage(fromMainFrame: true, frameURL: URL(string: "data:text/html,hello")))
        XCTAssertFalse(story.acceptsMessage(fromMainFrame: true, frameURL: nil))
    }

    func testNavigationRulesKeepTheWebViewOnTheBundledPage() throws {
        let story = StoryWebView()
        let page = try XCTUnwrap(RecapLink.bundledStoryLocation(payload: nil)).url
        let playing = try XCTUnwrap(RecapLink.bundledStoryLocation(payload: DemoRecap.payload)).url
        let sibling = page.deletingLastPathComponent().appendingPathComponent("css/base.css")

        XCTAssertTrue(story.allowsNavigation(inMainFrame: true, to: page))
        XCTAssertTrue(story.allowsNavigation(inMainFrame: true, to: playing))

        XCTAssertFalse(story.allowsNavigation(inMainFrame: true, to: sibling))
        XCTAssertFalse(story.allowsNavigation(inMainFrame: true, to: URL(string: "https://example.com/")))
        XCTAssertFalse(story.allowsNavigation(inMainFrame: true, to: URL(string: "https://averyhsu.github.io/imessage-wrap/")))
        XCTAssertFalse(story.allowsNavigation(inMainFrame: true, to: URL(string: "file:///etc/passwd")))
        XCTAssertFalse(story.allowsNavigation(inMainFrame: true, to: URL(string: "about:blank")))
        XCTAssertFalse(story.allowsNavigation(inMainFrame: true, to: URL(string: "data:text/html,hello")))
        XCTAssertFalse(story.allowsNavigation(inMainFrame: true, to: URL(string: "tel:5550100")))
        XCTAssertFalse(story.allowsNavigation(inMainFrame: true, to: nil))
        XCTAssertFalse(story.allowsNavigation(inMainFrame: false, to: page), "nothing is loaded into a frame")
        XCTAssertFalse(story.allowsNavigation(inMainFrame: false, to: URL(string: "https://example.com/")))
    }

    // MARK: With the real page

    /// The page is loaded before any story is asked for and waits quietly; handing it a
    /// recap starts the story without loading anything again; taking it back resets it.
    func testWarmWebViewWaitsThenPlaysWhatItIsHanded() throws {
        let story = StoryWebView()
        let recorder = Recorder()
        story.owner = recorder
        XCTAssertFalse(story.isBroken, "the story files are missing from the app bundle")

        let started = Date()
        XCTAssertTrue(spin(60) { story.isPageLoaded }, "the bundled story page never finished loading")
        let loadTime = Date().timeIntervalSince(started)
        spin(1.0) { false }
        XCTAssertEqual(recorder.messages, [], "a page that was handed nothing stays quiet")
        // A mark in the page: if it is still there later, the page was never loaded again.
        XCTAssertEqual(ask(story, "window.__warm = 'yes'; String(window.__warm)"), "yes")

        if let window = hostWindow() {
            story.webView.frame = window.bounds
            window.addSubview(story.webView)
        }
        defer {
            story.webView.removeFromSuperview()
        }

        let asked = Date()
        story.play(payload: DemoRecap.payload)
        XCTAssertTrue(
            spin(30) { recorder.messages.contains("ready") },
            "the story never reported ready (messages: \(recorder.messages), failures: \(recorder.failures))"
        )
        let readyTime = Date().timeIntervalSince(asked)
        print(String(format: "WRAPPED_NOTE warm web view: page loaded in %.2fs ahead of time; story ready %.2fs after it was asked for", loadTime, readyTime))
        XCTAssertTrue(spin(10) { recorder.messages.contains("slide") })
        XCTAssertEqual(ask(story, "String(window.__warm)"), "yes", "handing the recap over must not load the page again")
        XCTAssertEqual(story.ignoredMessages, 0, "messages from the story page itself are all heard")
        XCTAssertTrue(isOnTheStoryPage(story))

        // Recycling returns the page to its waiting state: nothing more is reported.
        story.reset()
        spin(1.0) { false }
        let count = recorder.messages.count
        spin(1.0) { false }
        XCTAssertEqual(recorder.messages.count, count)
        XCTAssertEqual(ask(story, "String(window.location.hash)"), "", "the recap is gone from the page address")

        // And it plays again from there.
        recorder.messages = []
        story.play(payload: DemoRecap.payload)
        XCTAssertTrue(spin(30) { recorder.messages.contains("ready") }, "a recycled web view should play the next story")
        XCTAssertEqual(ask(story, "String(window.__warm)"), "yes")
        XCTAssertEqual(recorder.failures, [])
    }

    /// Whatever script asks the web view to go elsewhere, it stays on the bundled page.
    func testScriptCannotNavigateTheWebViewAway() throws {
        let story = StoryWebView()
        let recorder = Recorder()
        story.owner = recorder
        XCTAssertTrue(spin(60) { story.isPageLoaded }, "the bundled story page never finished loading")
        if let window = hostWindow() {
            story.webView.frame = window.bounds
            window.addSubview(story.webView)
        }
        defer {
            story.webView.removeFromSuperview()
        }
        XCTAssertEqual(story.blockedNavigations, 0)
        XCTAssertEqual(ask(story, "window.__warm = 'yes'; String(window.__warm)"), "yes")

        // A script-driven navigation to the web.
        story.evaluate("window.location.href = 'https://example.com/elsewhere'; true")
        XCTAssertTrue(spin(15) { story.blockedNavigations >= 1 }, "the navigation was not put to the policy check")
        spin(1.5) { false }
        XCTAssertTrue(isOnTheStoryPage(story), "the web view left the story page: \(String(describing: story.webView.url))")
        XCTAssertEqual(ask(story, "String(window.__warm)"), "yes")

        // To another local file.
        story.evaluate("window.location.href = 'file:///etc/hosts'; true")
        spin(1.5) { false }
        XCTAssertTrue(isOnTheStoryPage(story), "the web view left the story page: \(String(describing: story.webView.url))")
        XCTAssertEqual(ask(story, "String(window.__warm)"), "yes")

        // A link, clicked: refused too, and (when WebKit reports it as a link activation)
        // handed to the host to open outside.
        let beforeLink = story.blockedNavigations
        let click = """
        (function () {
          var a = document.createElement('a');
          a.href = 'https://example.com/from-a-link';
          a.textContent = 'x';
          document.body.appendChild(a);
          a.click();
          a.remove();
          return true;
        })()
        """
        story.evaluate(click)
        XCTAssertTrue(spin(15) { story.blockedNavigations > beforeLink }, "the link was not put to the policy check")
        spin(1.5) { false }
        XCTAssertTrue(isOnTheStoryPage(story))
        XCTAssertEqual(ask(story, "String(window.__warm)"), "yes")
        let opened = recorder.opened.map { $0.absoluteString }
        print("WRAPPED_NOTE navigation policy: \(story.blockedNavigations) navigations refused; links handed to the host to open outside: \(opened)")

        // The page still works afterwards.
        story.play(payload: DemoRecap.payload)
        XCTAssertTrue(spin(30) { recorder.messages.contains("ready") }, "the story should still play after refused navigations")
        XCTAssertEqual(ask(story, "String(window.__warm)"), "yes", "the page was never reloaded or replaced")
    }
}
