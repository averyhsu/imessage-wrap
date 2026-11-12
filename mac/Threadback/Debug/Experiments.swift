#if DEBUG
import AppKit

/// CI experiments, started by launch arguments (Debug builds only). Each writes a JSON
/// report into -TBReportDir and shows what it found in a small window.
///
///   -TBProbe direct     read ~/Library/Messages with no grant, then quit
///   -TBProbe bookmark   resolve the stored folder bookmark, read through it, then quit
///   -TBAutomationProbe YES   ask macOS whether the app may control Messages (prompting)
///   -TBLoginItemProbe YES    SMAppService.mainApp register, wait, unregister
enum Experiments {
    static func runIfAsked(model: AppModel, show: @escaping (AppModel) -> Void) -> Bool {
        let folder = DebugOptions.reportFolder
        let tag = DebugOptions.string("TBProbeTag") ?? "run"
        if let probe = DebugOptions.string("TBProbe") {
            var report: [String: String]
            switch probe {
            case "bookmark":
                let note = model.restoreFolder()
                let url = URL(fileURLWithPath: model.databasePath).deletingLastPathComponent()
                report = AccessProbe.run(folder: url, label: "after relaunch, through the stored bookmark")
                report["bookmark"] = note
            default:
                report = AccessProbe.run(folder: Permissions.defaultMessagesFolder, label: "direct, nothing granted to the app")
            }
            report["launched.by"] = "pid \(getppid()) is the parent"
            AccessProbe.write(report, to: folder, name: "probe-\(probe)-\(tag).json")
            model.experimentNote = report.sorted { $0.key < $1.key }.map { "\($0.key): \($0.value)" }.joined(separator: "\n")
            show(model)
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { NSApp.terminate(nil) }
            return true
        }
        if DebugOptions.flag("TBAutomationProbe") {
            model.experimentNote = "Asking macOS whether Threadback may control Messages…"
            show(model)
            Permissions.requestAutomation { result in
                let report: [String: String] = [
                    "messages.running": String(result.messagesRunning),
                    "status.before.ask": Permissions.AutomationResult.describe(result.before),
                    "status.after.ask": Permissions.AutomationResult.describe(result.after),
                    "seconds.waiting.for.answer": String(format: "%.1f", result.seconds),
                    "harmless.event": result.harmlessEvent,
                ]
                AccessProbe.write(report, to: folder, name: "automation-\(tag).json")
                model.experimentNote = "AUTOMATION DONE\n" + report.sorted { $0.key < $1.key }.map { "\($0.key): \($0.value)" }.joined(separator: "\n")
            }
            return true
        }
        if DebugOptions.flag("TBLoginItemProbe") {
            var report: [String: String] = ["status.at.launch": Permissions.loginItemStatus()]
            report["register"] = Permissions.setLoginItem(true)
            model.experimentNote = "LOGIN ITEM REGISTERED\n" + (report["register"] ?? "")
            show(model)
            DispatchQueue.main.asyncAfter(deadline: .now() + 10) {
                report["status.after.10s"] = Permissions.loginItemStatus()
                report["unregister"] = Permissions.setLoginItem(false)
                AccessProbe.write(report, to: folder, name: "login-item-\(tag).json")
                model.experimentNote = "LOGIN ITEM DONE\n" + report.sorted { $0.key < $1.key }.map { "\($0.key): \($0.value)" }.joined(separator: "\n")
            }
            return true
        }
        if DebugOptions.flag("TBContactsProbe") {
            let before = Permissions.contactsStatusText()
            model.experimentNote = "Asking for Contacts access…"
            show(model)
            Permissions.requestContacts { granted, error in
                let report = ["status.before": before, "granted": String(granted), "error": error, "status.after": Permissions.contactsStatusText()]
                AccessProbe.write(report, to: folder, name: "contacts-\(tag).json")
                model.experimentNote = "CONTACTS DONE\n" + report.sorted { $0.key < $1.key }.map { "\($0.key): \($0.value)" }.joined(separator: "\n")
            }
            return true
        }
        return false
    }
}
#endif
