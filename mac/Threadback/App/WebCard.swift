import AppKit
import WebKit

/// The share card friends receive: the site's own 1080 x 1350 card (web/js/card.js, bundled
/// unchanged) drawn in an offscreen web view, so the Mac sends exactly what the web maker
/// makes. The page is web/mac-card.html in the app bundle; nothing is fetched.
///
/// WebKit lives on the main thread. `png(statsJSON:)` may be called from any thread: off the
/// main thread it waits for the main thread; on it, it runs the run loop until the card is
/// ready.
///
/// It recovers by itself: if macOS ends the web view's process, or the page does not load
/// within `loadTimeout`, the view is thrown away and the next card loads a fresh one.
/// `cardOrNative(statsJSON:)` falls back to the small native card when the page fails.
final class WebCard: NSObject, WKNavigationDelegate {
    static let shared = WebCard()

    static let size = CGSize(width: 1080, height: 1350)
    var loadTimeout: TimeInterval = 10
    private var webView: WKWebView?
    private var loaded = false
    private var loadGeneration = 0
    private var waiting: [() -> Void] = []
    /// How many times the page was thrown away and loaded again (for the test report).
    private(set) var reloads = 0
    private(set) var lastMilliseconds = 0
    /// "" when the footer texts of the last card kept apart (CI fails a card otherwise).
    private(set) var lastFooterProblem = ""

    struct Failure: Error, CustomStringConvertible {
        let description: String
    }

    static var pageURL: URL? {
        Bundle.main.url(forResource: "mac-card", withExtension: "html", subdirectory: "web")
    }

    /// The site's card, or the native card when the page cannot draw it right now (a WebKit
    /// crash, a page that does not load): a reply always has a picture.
    func cardOrNative(statsJSON: String) throws -> Data {
        do {
            return try png(statsJSON: statsJSON)
        } catch {
            usedNative += 1
            guard let png = MacCardRenderer.pngData(for: try RecapSummary.decode(json: Data(statsJSON.utf8))) else {
                throw Failure(description: "neither card could be drawn (\(error))")
            }
            return png
        }
    }

    /// How many cards fell back to the native renderer (for the test report).
    private(set) var usedNative = 0

    /// PNG bytes of the card for these (short-name) stats.
    func png(statsJSON: String, timeout: TimeInterval = 15) throws -> Data {
        var result: Result<Data, Error> = .failure(Failure(description: "the card did not finish in \(Int(timeout)) s"))
        var finished = false
        let start = Date()
        let begin = { [self] in
            self.render(statsJSON) { outcome in
                result = outcome
                finished = true
            }
        }
        if Thread.isMainThread {
            begin()
            let deadline = Date().addingTimeInterval(timeout)
            while !finished && Date() < deadline {
                RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
            }
        } else {
            let done = DispatchSemaphore(value: 0)
            DispatchQueue.main.async {
                self.render(statsJSON) { outcome in
                    result = outcome
                    finished = true
                    done.signal()
                }
            }
            _ = done.wait(timeout: .now() + timeout)
        }
        lastMilliseconds = Int(Date().timeIntervalSince(start) * 1000)
        return try result.get()
    }

    // MARK: Main thread

    private func render(_ statsJSON: String, _ done: @escaping (Result<Data, Error>) -> Void) {
        prepare { [self] in
            guard let webView = self.webView else {
                done(.failure(Failure(description: "the card page is missing from the app")))
                return
            }
            webView.callAsyncJavaScript(
                "const url = await window.ThreadbackCard.render(stats, live); return [url, window.ThreadbackCard.footerProblem()];",
                arguments: ["stats": statsJSON, "live": MacConfig.storySiteIsLive],
                in: nil, in: .page
            ) { result in
                switch result {
                case .success(let value):
                    let pair = value as? [Any]
                    self.lastFooterProblem = pair?.count == 2 ? (pair?[1] as? String ?? "") : "the card page gave no footer check"
                    guard let url = pair?.first as? String, let comma = url.firstIndex(of: ","),
                          let data = Data(base64Encoded: String(url[url.index(after: comma)...])),
                          !data.isEmpty else {
                        done(.failure(Failure(description: "the card page returned no image")))
                        return
                    }
                    done(.success(data))
                case .failure(let error):
                    done(.failure(Failure(description: "the card page failed: \(error.localizedDescription)")))
                }
            }
        }
    }

    /// Runs `then` once the page is loaded, or at once with no view when it cannot load (the
    /// caller then fails, and the next card tries a fresh view).
    private func prepare(_ then: @escaping () -> Void) {
        if loaded && webView != nil {
            then()
            return
        }
        waiting.append(then)
        if webView != nil { return }
        guard let page = WebCard.pageURL else {
            flush()
            return
        }
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let view = WKWebView(frame: CGRect(origin: .zero, size: WebCard.size), configuration: configuration)
        view.navigationDelegate = self
        webView = view
        loaded = false
        loadGeneration += 1
        let generation = loadGeneration
        view.loadFileURL(page, allowingReadAccessTo: page.deletingLastPathComponent())
        DispatchQueue.main.asyncAfter(deadline: .now() + loadTimeout) { [weak self] in
            guard let self, self.loadGeneration == generation, !self.loaded else { return }
            self.discard()   // the page did not load in time
        }
    }

    private func flush() {
        let queued = waiting
        waiting = []
        queued.forEach { $0() }
    }

    /// Throws the view away; whoever waits gets a failure, and the next card loads a new one.
    private func discard() {
        webView?.navigationDelegate = nil
        webView = nil
        loaded = false
        reloads += 1
        flush()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard webView === self.webView else { return }
        loaded = true
        flush()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        guard webView === self.webView else { return }
        discard()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        guard webView === self.webView else { return }
        discard()
    }

    /// macOS ended the web view's process (memory pressure, a crash): start again next time.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        guard webView === self.webView else { return }
        discard()
    }

    #if DEBUG
    /// CI: ends the web content process, as macOS may, to check that the next card recovers.
    func simulateCrash() {
        guard let webView else { return }
        webViewWebContentProcessDidTerminate(webView)
    }
    #endif

    /// Only the card page itself may load; nothing else, ever.
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url
        decisionHandler(url?.isFileURL == true && url?.lastPathComponent == "mac-card.html" ? .allow : .cancel)
    }

    /// Checks a PNG: the right size and not one flat colour.
    static func check(_ png: Data) -> String? {
        guard let rep = NSBitmapImageRep(data: png) else { return "not a PNG" }
        guard rep.pixelsWide == Int(size.width), rep.pixelsHigh == Int(size.height) else {
            return "wrong size \(rep.pixelsWide)x\(rep.pixelsHigh)"
        }
        var colours = Set<UInt32>()
        for y in stride(from: 10, to: rep.pixelsHigh, by: 97) {
            for x in stride(from: 10, to: rep.pixelsWide, by: 89) {
                guard let c = rep.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { continue }
                let key = (UInt32(c.redComponent * 255) << 16) | (UInt32(c.greenComponent * 255) << 8) | UInt32(c.blueComponent * 255)
                colours.insert(key)
            }
        }
        return colours.count < 8 ? "looks blank (\(colours.count) colours)" : nil
    }
}
