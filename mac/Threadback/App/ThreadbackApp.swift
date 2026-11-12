import AppKit
import SwiftUI

@main
enum Entry {
    static func main() {
        #if DEBUG
        // Command-line modes used by CI (stats parity, dry run, the AppleScript text).
        if let code = DebugCLI.run(CommandLine.arguments) {
            exit(code)
        }
        #endif
        ThreadbackApp.main()
    }
}

struct ThreadbackApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        MenuBarExtra("Threadback", systemImage: "text.bubble.fill") {
            MenuContent(model: delegate.model)
        }
        .menuBarExtraStyle(.menu)
    }
}

struct MenuContent: View {
    @ObservedObject var model: AppModel

    var body: some View {
        Text(model.status)
        if model.accessLost {
            Button(model.access) { model.reconnect() }
        } else {
            Text(model.access)
        }
        if let title = model.lastReplyTitle, let last = model.replies.last {
            Divider()
            Text(title)
            if last.parts.isEmpty {
                Text("could not build the reply")
            }
            ForEach(Array(last.parts.enumerated()), id: \.offset) { _, part in
                Text("\(part.part.capitalized): \(part.status)" + (part.errorNumber.map { " (error \($0))" } ?? ""))
            }
        }
        Divider()
        if !model.approved.isEmpty {
            Button("Preview a reply…") { model.previewInFinder() }
            Button(model.paused ? "Resume" : "Pause") { model.togglePause() }
        }
        if let outcome = model.lastUnconfirmed {
            Button("Reply in \(outcome.chat.name) not confirmed: send by hand…") { model.sendByHand() }
        }
        Toggle("Open at login", isOn: Binding(get: { model.loginItemOn }, set: { model.setLoginItem($0) }))
        Button("Copy test report") { model.copyTestReport() }
        Button("Set up…") { NotificationCenter.default.post(name: .showOnboarding, object: nil) }
        Divider()
        Button("Quit Threadback") { NSApp.terminate(nil) }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    let model = AppModel()
    private var window: NSWindow?
    private var observer: NSObjectProtocol?

    func applicationDidFinishLaunching(_ notification: Notification) {
        observer = NotificationCenter.default.addObserver(forName: .showOnboarding, object: nil, queue: .main) { [weak self] _ in
            self?.showOnboarding()
        }
        #if DEBUG
        if Experiments.runIfAsked(model: model, show: { [weak self] model in _ = self?.show(ExperimentView(model: model), title: "Threadback experiment") }) {
            return
        }
        #endif
        if model.onboarded && !model.approved.isEmpty {
            if !model.isFixture { model.restoreFolder() }
            model.checkAccess()
            model.startAgent()
        } else {
            showOnboarding()
        }
    }

    func showOnboarding() {
        let window = show(OnboardingView(model: model), title: "Threadback")
        model.window = window
    }

    @discardableResult
    func show<V: View>(_ view: V, title: String) -> NSWindow {
        if let window {
            window.contentView = NSHostingView(rootView: view)
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return window
        }
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 720, height: 640),
                              styleMask: [.titled, .closable, .fullSizeContentView], backing: .buffered, defer: false)
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.title = title
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = MacPalette.night
        window.contentView = NSHostingView(rootView: view)
        window.center()
        window.identifier = NSUserInterfaceItemIdentifier("threadback.main")
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        self.window = window
        return window
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return false
    }
}
