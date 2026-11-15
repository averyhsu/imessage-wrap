import AppKit
import Contacts
import CoreServices
import Security
import ServiceManagement

/// The three things macOS has to agree to, each asked for on purpose from onboarding.
enum Permissions {
    static let messagesBundleID = "com.apple.MobileSMS"

    // MARK: Messages folder (Open panel, no Full Disk Access)

    static var defaultMessagesFolder: URL {
        // Not sandboxed, so this is the real home folder.
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Messages", isDirectory: true)
    }

    /// An Open panel already inside ~/Library/Messages, folders only, "Grant Access".
    static func messagesPanel() -> NSOpenPanel {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = false
        panel.showsHiddenFiles = false
        panel.directoryURL = defaultMessagesFolder
        panel.prompt = "Grant Access"
        panel.message = "The Messages folder is already selected. Click Grant Access so Threadback can read your group chats on this Mac."
        panel.identifier = NSUserInterfaceItemIdentifier("threadback.messagesPanel")
        return panel
    }

    struct Bookmark {
        let data: Data
        let securityScoped: Bool
        let note: String
    }

    /// A bookmark for the chosen folder: security-scoped if macOS gives one to this
    /// (non-sandboxed) app, else a plain one. The note says which and why.
    static func bookmark(for url: URL) -> Bookmark? {
        do {
            let data = try url.bookmarkData(options: [.withSecurityScope], includingResourceValuesForKeys: nil, relativeTo: nil)
            return Bookmark(data: data, securityScoped: true, note: "security-scoped bookmark created (\(data.count) bytes)")
        } catch {
            let first = AccessProbe.describe(error)
            do {
                let data = try url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
                return Bookmark(data: data, securityScoped: false, note: "security-scoped bookmark failed (\(first)); plain bookmark created (\(data.count) bytes)")
            } catch {
                return nil
            }
        }
    }

    /// Resolves a stored bookmark and starts access. Returns the URL and a note.
    static func resolve(_ data: Data, securityScoped: Bool) -> (URL?, String) {
        var stale = false
        do {
            let url = try URL(resolvingBookmarkData: data, options: securityScoped ? [.withSecurityScope] : [],
                              relativeTo: nil, bookmarkDataIsStale: &stale)
            let started = securityScoped ? url.startAccessingSecurityScopedResource() : false
            return (url, "resolved to \(url.path); stale=\(stale); startAccessingSecurityScopedResource=\(securityScoped ? String(started) : "not called (plain bookmark)")")
        } catch {
            return (nil, "could not resolve the bookmark: \(AccessProbe.describe(error))")
        }
    }

    static func openFullDiskAccessSettings() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles") {
            NSWorkspace.shared.open(url)
        }
    }

    // MARK: Contacts (optional: first names instead of "…1234")

    static var contactsAuthorized: Bool {
        CNContactStore.authorizationStatus(for: .contacts) == .authorized
    }

    static func contactsStatusText() -> String {
        switch CNContactStore.authorizationStatus(for: .contacts) {
        case .authorized: return "authorized"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "notDetermined"
        default: return "other (\(CNContactStore.authorizationStatus(for: .contacts).rawValue))"
        }
    }

    static func requestContacts(_ done: @escaping (Bool, String) -> Void) {
        CNContactStore().requestAccess(for: .contacts) { granted, error in
            DispatchQueue.main.async { done(granted, error.map { AccessProbe.describe($0) } ?? "") }
        }
    }

    /// [[phone or e-mail, label]] for the engine; labels go through the engine's own rule.
    static func contactPairs(engine: ThreadbackEngine) -> [[String]] {
        guard contactsAuthorized else { return [] }
        let keys: [CNKeyDescriptor] = [
            CNContactGivenNameKey, CNContactFamilyNameKey, CNContactNicknameKey, CNContactOrganizationNameKey,
            CNContactPhoneNumbersKey, CNContactEmailAddressesKey,
        ].map { $0 as CNKeyDescriptor }
        var pairs: [[String]] = []
        let request = CNContactFetchRequest(keysToFetch: keys)
        try? CNContactStore().enumerateContacts(with: request) { contact, _ in
            let label = engine.contactLabel(first: contact.givenName, last: contact.familyName,
                                            nickname: contact.nickname, organization: contact.organizationName)
            guard !label.isEmpty else { return }
            for phone in contact.phoneNumbers { pairs.append([phone.value.stringValue, label]) }
            for mail in contact.emailAddresses { pairs.append([mail.value as String, label]) }
        }
        return pairs
    }

    // MARK: Automation (control Messages)

    struct AutomationResult {
        let before: OSStatus
        let after: OSStatus
        let seconds: Double
        let messagesRunning: Bool
        var harmlessEvent = ""

        static func describe(_ status: OSStatus) -> String {
            switch status {
            case 0: return "0 (allowed)"
            case -1743: return "-1743 errAEEventNotPermitted (denied)"
            case -1744: return "-1744 errAEEventWouldRequireUserConsent (not asked yet)"
            case -600: return "-600 procNotFound (Messages not running)"
            default: return "\(status)"
            }
        }
    }

    /// Makes sure Messages is running (hidden), then asks macOS whether this app may send it
    /// Apple Events, prompting if needed. Runs off the main thread; calls back on main.
    static func requestAutomation(askUser: Bool = true, _ done: @escaping (AutomationResult) -> Void) {
        launchMessagesHidden { running in
            DispatchQueue.global(qos: .userInitiated).async {
                let target = NSAppleEventDescriptor(bundleIdentifier: messagesBundleID)
                let wildcard: DescType = 0x2A2A_2A2A // '****' typeWildCard
                let before = AEDeterminePermissionToAutomateTarget(target.aeDesc, wildcard, wildcard, false)
                let start = Date()
                let after = askUser ? AEDeterminePermissionToAutomateTarget(target.aeDesc, wildcard, wildcard, true) : before
                var result = AutomationResult(before: before, after: after, seconds: Date().timeIntervalSince(start), messagesRunning: running)
                if after == 0 {
                    // A harmless event: how many chats Messages has. Never a send.
                    var error: NSDictionary?
                    let value = NSAppleScript(source: "tell application \"Messages\" to return count of chats")?.executeAndReturnError(&error)
                    if let error {
                        result.harmlessEvent = "count of chats failed: \(error[NSAppleScript.errorNumber] ?? "?") \(error[NSAppleScript.errorMessage] ?? "")"
                    } else {
                        result.harmlessEvent = "count of chats = \(value?.int32Value ?? -1)"
                    }
                }
                DispatchQueue.main.async { done(result) }
            }
        }
    }

    static func launchMessagesHidden(_ done: @escaping (Bool) -> Void) {
        if !NSRunningApplication.runningApplications(withBundleIdentifier: messagesBundleID).isEmpty {
            done(true)
            return
        }
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: messagesBundleID) else {
            done(false)
            return
        }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = false
        configuration.hides = true
        NSWorkspace.shared.openApplication(at: url, configuration: configuration) { app, _ in
            DispatchQueue.main.async {
                // Give it a moment to start answering events.
                DispatchQueue.main.asyncAfter(deadline: .now() + 2) { done(app != nil) }
            }
        }
    }

    // MARK: Code signature (for the test report)

    /// "ad-hoc, hardened runtime" / "Developer ID TEAMID" / "unsigned" / "unknown".
    static func signatureKind() -> String {
        var code: SecCode?
        guard SecCodeCopySelf(SecCSFlags(), &code) == errSecSuccess, let code else { return "unknown" }
        var staticCode: SecStaticCode?
        guard SecCodeCopyStaticCode(code, SecCSFlags(), &staticCode) == errSecSuccess, let staticCode else { return "unknown" }
        var info: CFDictionary?
        let signingInformation = SecCSFlags(rawValue: 1 << 1) // kSecCSSigningInformation
        guard SecCodeCopySigningInformation(staticCode, signingInformation, &info) == errSecSuccess,
              let dict = info as? [String: Any] else { return "unknown" }
        let flags = (dict[kSecCodeInfoFlags as String] as? NSNumber)?.uint32Value ?? 0
        let team = dict[kSecCodeInfoTeamIdentifier as String] as? String
        var parts: [String] = []
        if flags & 0x2 != 0 {
            parts.append("ad-hoc")
        } else if let team {
            parts.append("team \(team)")
        } else {
            parts.append(dict[kSecCodeInfoIdentifier as String] == nil ? "unsigned" : "signed, no team")
        }
        if flags & 0x10000 != 0 { parts.append("hardened runtime") }
        return parts.joined(separator: ", ")
    }

    // MARK: Login item

    static func loginItemStatus() -> String {
        switch SMAppService.mainApp.status {
        case .notRegistered: return "notRegistered"
        case .enabled: return "enabled"
        case .requiresApproval: return "requiresApproval"
        case .notFound: return "notFound"
        @unknown default: return "unknown"
        }
    }

    /// Returns a note with the status before and after, and any error.
    static func setLoginItem(_ on: Bool) -> String {
        let before = loginItemStatus()
        var note = ""
        do {
            if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
            note = "ok"
        } catch {
            note = "error: \(AccessProbe.describe(error))"
        }
        return "\(on ? "register" : "unregister"): \(note); status \(before) -> \(loginItemStatus())"
    }
}
