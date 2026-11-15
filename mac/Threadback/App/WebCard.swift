import AppKit
import WebKit

/// The share card friends receive: the site's own 1080 x 1350 card (web/js/card.js, bundled
/// unchanged) drawn in an offscreen web view, so the Mac sends exactly what the web maker
/// makes. The page is web/mac-card.html in the app bundle; nothing is fetched.
///
/// WebKit lives on the main thread. `png(statsJSON:)` may be called from any thread: off the
/// main thread it waits for the main thread; on it, it runs the run loop until the card is
/// ready.
final class WebCard: NSObject, WKNavigationDelegate {
    static let shared = WebCard()

    static let size = CGSize(width: 1080, height: 1350)
    private var webView: WKWebView?
    private var loaded = false
    private var waiting: [() -> Void] = []
    private(set) var lastMilliseconds = 0
    /// "" when the footer texts of the last card kept apart (CI fails a card otherwise).
    private(set) var lastFooterProblem = ""

    struct Failure: Error, CustomStringConvertible {
        let description: String
    }

    static var pageURL: URL? {
        Bundle.main.url(forResource: "mac-card", withExtension: "html", subdirectory: "web")
    }

    /// PNG bytes of the card for these (short-name) stats.
    func png(statsJSON: String, timeout: TimeInterval = 20) throws -> Data {
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

    private func prepare(_ then: @escaping () -> Void) {
        if loaded {
            then()
            return
        }
        waiting.append(then)
        if webView != nil { return }
        guard let page = WebCard.pageURL else {
            loaded = true
            flush()
            return
        }
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let view = WKWebView(frame: CGRect(origin: .zero, size: WebCard.size), configuration: configuration)
        view.navigationDelegate = self
        webView = view
        view.loadFileURL(page, allowingReadAccessTo: page.deletingLastPathComponent())
    }

    private func flush() {
        let queued = waiting
        waiting = []
        queued.forEach { $0() }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loaded = true
        flush()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        self.webView = nil
        loaded = true
        flush()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        self.webView = nil
        loaded = true
        flush()
    }

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
