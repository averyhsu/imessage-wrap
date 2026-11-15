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
        // One copy per user: a second one (another copy, or a second launch) shows the
        // running copy's window and leaves, so a /wrapped is never answered twice.
        if !SingleInstance.isExperiment && !SingleInstance.claim() {
            Trace.note("second copy: another copy holds the lock; showed it and quit without touching settings")
            exit(0)
        }
        Trace.note("launch: lock \(SingleInstance.lock.isHeld ? "held" : "not taken (experiment)")")
        ThreadbackApp.main()
    }
}

/// Debug builds only: one line per lifecycle event in the unified log ("TBTRACE"), which CI
/// prints after the lifecycle tests. Release builds log nothing.
enum Trace {
    static func note(_ text: @autoclosure () -> String) {
        #if DEBUG
        NSLog("TBTRACE pid %d: %@", getpid(), text())
        #endif
    }
}

/// The single-instance rule around `InstanceLock`.
enum SingleInstance {
    static let lock = InstanceLock()

    /// CI's permission probes (Debug builds only) never answer anything: no lock for them.
    static var isExperiment: Bool {
        #if DEBUG
        return ["TBProbe", "TBAutomationProbe", "TBLoginItemProbe", "TBContactsProbe"].contains {
            UserDefaults.standard.object(forKey: $0) != nil
        }
        #else
        return false
        #endif
    }

    /// Takes the lock (waiting a moment for a copy that is handing over). When another copy
    /// holds it, opens that copy again (it shows its window) and returns false.
    static func claim() -> Bool {
        if lock.acquire(retryFor: 3) { return true }
        let me = ProcessInfo.processInfo.processIdentifier
        let others = NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier ?? "")
            .filter { $0.processIdentifier != me }
        if let other = others.first, let url = other.bundleURL {
            let configuration = NSWorkspace.OpenConfiguration()
            configuration.activates = true
            let finished = Flag()
            NSWorkspace.shared.openApplication(at: url, configuration: configuration) { _, _ in finished.set() }
            let deadline = Date().addingTimeInterval(5)
            while !finished.value && Date() < deadline {
                RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
            }
            other.activate()
        }
        return false
    }

    private final class Flag {
        private let lock = NSLock()
        private var done = false
        var value: Bool { lock.withLock { done } }
        func set() { lock.withLock { done = true } }
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
        if let line = model.limitLine {
            Text(line)
        }
        if !model.needsReconsent.isEmpty {
            Button("Replies changed: confirm \(model.needsReconsent.count == 1 ? "1 chat" : "\(model.needsReconsent.count) chats")\u{2026}") {
                NotificationCenter.default.post(name: .showStatus, object: nil)
            }
        }
        if !model.approved.isEmpty {
            Button("Preview a reply…") { model.previewInFinder() }
            Button(model.paused ? "Resume" : "Pause all") { model.togglePause() }
        }
        if let outcome = model.lastUnconfirmed {
            Button("Reply in \(outcome.chat.name) not confirmed: send by hand…") { model.sendByHand() }
        }
        if model.chatIsOn {
            Toggle("Open at login", isOn: Binding(get: { model.loginItemOn }, set: { model.setLoginItem($0) }))
        }
        Button("Copy test report") { model.copyTestReport() }
        Button("Open Threadback window") { NotificationCenter.default.post(name: .showStatus, object: nil) }
        Button("Set up…") { NotificationCenter.default.post(name: .showOnboarding, object: nil) }
        Divider()
        Button("Quit Threadback") { NSApp.terminate(nil) }
    }
}

/// The app's lifecycle. Rules (so Threadback is never running invisibly by surprise):
/// - while a Threadback window is open it is a normal app: Dock icon, app menu, Command-Q;
/// - until a chat is turned on, closing the window quits the app;
/// - with a chat on, closing the window keeps it answering from the menu bar (the window says
///   so the first time) and the Dock icon goes away;
/// - opening Threadback again while it runs (Applications, Spotlight, Launchpad) always shows
///   a window with its status and Turn off / Quit Threadback.
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    let model = AppModel()
    private var window: NSWindow?
    private var observers: [NSObjectProtocol] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        #if DEBUG
        for (name, what) in [(NSWindow.willBeginSheetNotification, "begins"), (NSWindow.didEndSheetNotification, "ended")] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { note in
                let window = note.object as? NSWindow
                Trace.note("a sheet \(what) on \(window?.identifier?.rawValue ?? "a window"); sheets now \(window?.sheets.count ?? -1)")
            })
        }
        #endif
        Trace.note("finished launching: chat on \(model.chatIsOn), told about the menu bar \(UserDefaults.standard.bool(forKey: toldKey))")
        observers.append(NotificationCenter.default.addObserver(forName: .showOnboarding, object: nil, queue: .main) { [weak self] _ in
            self?.showOnboarding()
        })
        observers.append(NotificationCenter.default.addObserver(forName: .showStatus, object: nil, queue: .main) { [weak self] _ in
            self?.showStatus()
        })
        #if DEBUG
        if Experiments.runIfAsked(model: model, show: { [weak self] model in _ = self?.show(ExperimentView(model: model), title: "Threadback experiment") }) {
            return
        }
        #endif
        // A later launch: reconnect through the stored bookmark and say whether it worked
        // ("Messages: Connected" or "Messages: Lost access \u{00B7} Reconnect").
        if !model.isFixture && model.hasConnection {
            model.restoreFolder()
            model.checkAccess()
        }
        if model.chatIsOn {
            if model.isFixture { model.checkAccess() }
            model.startAgent()
            showStatus()
        } else {
            showOnboarding()
        }
    }

    /// Opened again while running (Finder, Spotlight, Launchpad, Dock): always a window.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        Trace.note("reopen: visible windows \(flag), sheets on the window \(window?.sheets.count ?? 0)")
        if model.chatIsOn { showStatus() } else { showOnboarding() }
        return true
    }

    func showOnboarding() {
        let window = show(OnboardingView(model: model), title: "Threadback")
        model.window = window
    }

    func showStatus() {
        let window = show(StatusView(model: model), title: "Threadback")
        model.window = window
        // A chat turned on when replies carried less: ask before anything is sent there.
        DispatchQueue.main.async { [weak self] in self?.model.askReconsentIfNeeded(window) }
    }

    @discardableResult
    func show<V: View>(_ view: V, title: String) -> NSWindow {
        NSApp.setActivationPolicy(.regular)
        installMainMenu()
        if let window {
            window.contentView = NSHostingView(rootView: view)
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return window
        }
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 720, height: 640),
                              styleMask: [.titled, .closable, .miniaturizable, .fullSizeContentView], backing: .buffered, defer: false)
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.title = title
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = MacPalette.night
        window.contentView = NSHostingView(rootView: view)
        window.center()
        window.identifier = NSUserInterfaceItemIdentifier("threadback.main")
        window.delegate = self
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        self.window = window
        return window
    }

    /// The menu of a normal app: About, Hide, Quit (Command-Q), Close (Command-W).
    private func installMainMenu() {
        let quit = #selector(NSApplication.terminate(_:))
        if let first = NSApp.mainMenu?.items.first?.submenu, first.items.contains(where: { $0.action == quit }) { return }
        let main = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu(title: "Threadback")
        appMenu.addItem(withTitle: "About Threadback", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Threadback", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Threadback", action: quit, keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)
        let windowItem = NSMenuItem()
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowItem.submenu = windowMenu
        main.addItem(windowItem)
        NSApp.mainMenu = main
    }

    // MARK: Closing the window

    private let toldKey = "toldAboutMenuBar"
    /// The menu-bar notice is on screen or waiting to be: a second close request must not add
    /// another one (AppKit queues sheets, and a queued one appears later, over whatever the
    /// window shows then).
    private var noticePending = false

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        let told = UserDefaults.standard.bool(forKey: toldKey)
        Trace.note("close asked: chat on \(model.chatIsOn), told \(told), notice pending \(noticePending), sheets on the window \(sender.sheets.count)")
        if DebugOptions.flag("TBNoticeLegacy") { return legacyShouldClose(sender, told: told) }
        if noticePending { return false }          // the notice is up: its buttons decide
        guard model.chatIsOn, !told else { return true }
        // The first time with a chat on: say where Threadback goes before the window closes.
        // Once per install: it counts as told as soon as it is shown.
        UserDefaults.standard.set(true, forKey: toldKey)
        noticePending = true
        let alert = NSAlert()
        alert.messageText = "Threadback keeps answering from the menu bar."
        alert.informativeText = "To stop it, open Threadback again (from Applications) and click Turn off or Quit Threadback."
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Quit Threadback")
        alert.beginSheetModal(for: sender) { response in
            self.noticePending = false
            Trace.note("menu-bar notice answered: \(response == .alertSecondButtonReturn ? "Quit" : "OK")")
            if response == .alertSecondButtonReturn {
                NSApp.terminate(nil)
            } else {
                sender.close()
            }
        }
        return false
    }

    /// CI diagnostics only (-TBNoticeLegacy): the notice as it was before run 43710352298,
    /// told only once OK is clicked and with nothing against a second one, to show how a
    /// second close request stacks a second notice.
    private func legacyShouldClose(_ sender: NSWindow, told: Bool) -> Bool {
        guard model.chatIsOn, !told else { return true }
        let alert = NSAlert()
        alert.messageText = "Threadback keeps answering from the menu bar."
        alert.informativeText = "To stop it, open Threadback again (from Applications) and click Turn off or Quit Threadback."
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Quit Threadback")
        alert.beginSheetModal(for: sender) { response in
            UserDefaults.standard.set(true, forKey: self.toldKey)
            Trace.note("menu-bar notice (legacy) answered: \(response == .alertSecondButtonReturn ? "Quit" : "OK")")
            if response == .alertSecondButtonReturn {
                NSApp.terminate(nil)
            } else {
                sender.close()
            }
        }
        return false
    }

    func windowWillClose(_ notification: Notification) {
        Trace.note("window closes: chat on \(model.chatIsOn)")
        if model.chatIsOn {
            NSApp.setActivationPolicy(.accessory)  // the menu-bar item stays, the Dock icon goes
        } else {
            NSApp.terminate(nil)                   // nothing to do in the background: quit
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return false
    }
}
