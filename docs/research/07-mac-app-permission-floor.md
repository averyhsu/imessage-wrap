# 07 — The permission floor for a one-click Mac helper

_Researched 2026-11-12. Current releases: macOS 15 Sequoia, 26 Tahoe (autumn 2025), 27 (2026-09-14). Apple developer documentation and forum threads were read directly; GitHub source was read through raw.githubusercontent.com and the code and issue search APIs. eclecticlight.co, mjtsai.com, macstories.net, macmost.com, privacyguides.org, docs.rs, support.apple.com and docs.bluebubbles.app were unreachable from this sandbox, so anything resting on them is a search snippet and says so. Labels: **(Apple)** documented or stated by an Apple engineer; **(observed: X)** reported or shipped by a named third party; **(inference)** my reasoning. Anything not checked is **UNVERIFIED**._

## Bottom line

- **Full Disk Access is not needed.** Picking `~/Library/Messages` once in the standard Open panel gives the app lasting read access to `chat.db` and its write-ahead log. Two shipping apps use this (AutoSpoto on the Mac App Store, iMCP), and a probe confirmed it on macOS 27.
- **The floor is four macOS-imposed clicks and no visit to System Settings:** *Open* (first launch), *Grant Access* (folder), *Allow* (Contacts, for names) and *Allow* ("wants to control Messages"). Choosing the chat adds one more. From the download to "on" is about 9 clicks, with no typing.
- **Sending is now the risk, not permissions.** On macOS 26, AppleScript sends to group chats sometimes report success and deliver nothing. No public route sends to a group with no click per message. Prove the group send on the owner's Mac before building anything.
- **Use Full Disk Access only as the fallback.** It costs a System Settings visit, a password, maybe a relaunch and about 4 more clicks. On 2026-10-02 Apple said it will soon demand "very explicit user action" for it.

## 1. Reading chat.db without the Full Disk Access detour

### Does the Open panel grant access?

- **Apple's rule.** An Open-panel selection extends the app's access to that item, and MAC (the layer behind Full Disk Access) protects some folders separately. "If the user grants you access to `~/Library`, that does not give you access to `~/Library/Mail` because the latter is protected by MAC" (Quinn, [On File System Permissions](https://developer.apple.com/forums/thread/678819), revised 2026-09-18) **(Apple)**. Selecting the protected folder *itself* is what works.
  - A developer reports that `~/Library/Mail` opened without errors "only when selecting these folders explicitly in an open panel"; Apple's accepted answer explains the difference with MAC ([thread 799832](https://developer.apple.com/forums/thread/799832), September 2025) **(Apple + observed)**.
  - For non-sandboxed apps: "When a user selects a 'protected' file or folder in an NSOpenPanel in a non-sandboxed app … consent is inferred and the app can access it." The grant appears to live in a `com.apple.macl` extended attribute on the item ([Quinn, thread 124121](https://developer.apple.com/forums/thread/124121), 2019) **(Apple, Catalina era)**.
- **Sandboxed apps, in production.**
  - [**AutoSpoto**](https://github.com/martinmaly21/AutoSpoto) (Mac App Store since 2024, sandboxed) onboards with "1. Grant AutoSpoto Access to Messages … Click 'Open' when the dialogue appears". Its code opens an `NSOpenPanel` at `~/Library/Messages` and stores a security-scoped bookmark ([source](https://github.com/martinmaly21/AutoSpoto/blob/main/AutoSpoto/View/Onboarding/PermissionsRequestView/AutoSpotoDiskAccessRequestCell.swift)). Its entitlements hold only `files.user-selected.read-write` and `files.bookmarks.app-scope` ([entitlements](https://github.com/martinmaly21/AutoSpoto/blob/main/AutoSpoto/AutoSpoto.entitlements)) **(observed)**.
  - [**iMCP**](https://github.com/mattt/iMCP) (notarized, macOS 15.3+, sandboxed) says: "you'll be prompted to select your `~/Library/Messages` folder through the standard file picker. When you do, macOS adds that folder to the app's sandbox." It also carries a sandbox exception for `/Users/*/Library/Messages/` ([entitlements](https://github.com/mattt/iMCP/blob/main/App/App.entitlements)), so for iMCP the panel supplies the privacy consent, not the sandbox path **(observed, 2026-09/10)**.
- **Non-sandboxed apps, measured on macOS 27.** Backspacer's [probe](https://github.com/anton-g-kulikov/backspacer/blob/main/_meta/fda-panel-probe.swift), "answered on macOS 27, 2026-10-20, for ~/Library/Messages and ~/Library/Safari", found the folder readable after the pick, readable by a **child process**, still readable in a **later run**, and still denied to unrelated programs: "the grant is per app identity and per folder, inherited by children and kept across runs." One caveat: the probe ran as a script, so the identity tested was its host process, not a packaged app **(observed)**.
- **No one has published a packaged-app result on macOS 15 or 26.** Read Receipts, another iMessage-history app, wrote a probe for exactly this question and still tells users to grant Full Disk Access ([README](https://github.com/arkhivespace/readreceipts/blob/main/README.md), [probe](https://github.com/arkhivespace/readreceipts/blob/main/Sources/ReadReceiptsTCCProbe/main.swift)). Its probe notes that a `swift run` binary is attributed to the terminal, so only a packaged app answers the question **(observed)**.

### Folder, not file

- **Pick the folder.** A grant on `chat.db` alone "cannot reach the write-ahead log next to it, where Messages keeps everything since its last checkpoint, so the newest messages stay invisible for hours". iMCP switched to the folder on 2026-09-17 ([#198](https://github.com/mattt/iMCP/blob/main/App/Services/Messages.swift)) and now opens the database live under the folder grant **(observed)**. A file-only grant would break `/wrapped` detection.
- **`Attachments/` is walled off** from the folder grant and needs its own pick (iMCP README). Threadback does not read attachments, so this does not matter.
- **Contacts are not covered.** The folder grant does not reach `~/Library/Application Support/AddressBook`. First names need the Contacts permission (`NSContactsUsageDescription`, one system "Allow") or a second folder pick (inference from note 03 §4: only Full Disk Access covers the AddressBook files).

### Keeping it

- **Sandboxed:** "These dynamic sandbox extensions … go away when your process terminates. To maintain persistent access to an item, use a security-scoped bookmark" (Quinn, 678819) **(Apple)**. AutoSpoto and iMCP both do this, and iMCP renews stale bookmarks ([#297](https://github.com/mattt/iMCP)). Persistence across launches is therefore shipped behaviour **(observed)**. Persistence across reboots is implied by shipping apps but untested here: **UNVERIFIED**.
- **Non-sandboxed:** the `macl` grant persisted across runs on macOS 27 (Backspacer). Howard Oakley (April 2026, snippet only) reasons that it "should also be reset after a restart" because the app UUIDs change, while Michael Tsai's relay of the same work says it "persists until you run tccutil reset All and restart". **UNVERIFIED across a reboot.** Store a bookmark anyway, and re-ask (one click) if a read fails.
- **What breaks it** **(inference from 678819)**: TCC relies on "a stable code signing identity", so ad-hoc or unsigned builds will lose grants on each update. Moving the app to a new path should not matter, since bookmarks follow the file. A Developer ID update with the same team and bundle ID should keep the grant. **UNVERIFIED** for the `macl` path. `tccutil` does not reliably reset `macl` grants (snippet, Tsai comment).
- **Drag-and-drop** of the folder onto the app: not found in any source. **UNVERIFIED**. Do not design around it.

### Who uses Full Disk Access instead

| App | How it gets chat.db | Source |
|---|---|---|
| imsg (CLI) | FDA for the terminal; "quit and relaunch the parent process. macOS only re-reads Full Disk Access on launch" | [permissions.md](https://github.com/openclaw/imsg/blob/main/docs/permissions.md) |
| Read Receipts (app) | FDA; "Quit and reopen it — the grant does not apply to a running process" | [README](https://github.com/arkhivespace/readreceipts/blob/main/README.md) |
| MiMessage (Electron) | "your IDE or your terminal must have full disk access" | [README](https://github.com/jonluca/mimessage) |
| AutoSpoto's background updater | FDA for the separate helper, although the main app uses the folder pick | [strings](https://github.com/martinmaly21/AutoSpoto/blob/main/AutoSpoto/Supporting%20FIles/AutoSpotoConstants/AutoSpotoConstants%2BStrings.swift) |
| AutoSpoto main app, iMCP | Folder pick | above |
| Left on Read, BlueBubbles, iMazing, Messages Wrapped | Not checked: their docs sites were unreachable | — |

The AutoSpoto row is the lesson: **its separate background helper could not use the main app's folder grant and fell back to Full Disk Access** (my reading of its onboarding strings, **inference**). Keep reading and sending in one app process, launched at login as the main app (`SMAppService.mainApp`), not a separate agent.

### If Full Disk Access is used anyway

- **No API asks for it or tests it.** Apple, August 2026: the answer to "is there an API to detect FDA" "remains 'no'"; probe the real files instead ([thread 841091](https://developer.apple.com/forums/thread/841091)) **(Apple)**. Reading `TCC.db` to check stopped working on macOS 27 (same thread). FDA "raises no prompt to answer" and "there is no API for an app to add itself to the list" ([Backspacer docs](https://github.com/anton-g-kulikov/backspacer/blob/main/_meta/system-documentation.md)) **(observed)**.
- **Deep link.** `x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles` is used on macOS 27 by Backspacer (above) **(observed)**. The newer form `x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles` comes from a MacScripter snippet. Apple documents neither (the first appears only in a developer's post in [114452](https://developer.apple.com/forums/thread/114452)). Per-version behaviour on 15/26: **UNVERIFIED**.
- **Best pattern** (observed: AutoSpoto, Backspacer): one button opens the pane *and* shows the app icon in a small window to drag into the list ("Drag and drop this icon on to the Full Disk Access window"). Then poll a canary file and continue automatically.
- **Relaunch?** Sources disagree. imsg and Read Receipts say relaunch; Backspacer says it re-checks "whenever the window regains focus, so a grant takes effect without a relaunch"; AutoSpoto hedges ("You may need to restart"). **UNVERIFIED**. Design for both: detect, and offer "Quit & Reopen".
- **It is getting harder.** "We will introduce additional controls to ensure that users who genuinely wish to grant an app this extraordinary level of access can only do so with very explicit user action … For communication apps, this can also compromise the privacy of the people users are communicating with" ([Apple, 2026-10-02](https://developer.apple.com/news/?id=p6zjojqw)) **(Apple)**. No version or date was given.

## 2. Sending into an existing group

| Route | Clicks per reply | One-time cost | Group targeting | Verdict |
|---|---|---|---|---|
| Apple Events (`NSAppleScript` / `osascript`): `send … to chat id` | **0** | One "wants access to control Messages" Allow | `chat id` = `chat.guid` | Only zero-click route; unreliable for groups on 26 |
| Shortcuts "Send Message", run by the app via `shortcuts run` | 0 if "Show When Run" is off (UNCERTAIN) | User installs a shortcut and approves it on first run | By recipients, not chat id | Experiment only |
| `NSSharingService(named: .composeMessage)` | ≥1 (user presses Send) | None | `recipients` = handles ([Apple](https://developer.apple.com/documentation/appkit/nssharingservice/recipients)); hitting the existing named group is UNVERIFIED | Fallback when the owner is at the Mac |
| `sms:`/`imessage:` URL | ≥1 | None | Recipient list; existing thread UNVERIFIED | Same as above |
| UI scripting (System Events) | 0 | **Accessibility** pane in System Settings | Clicks the chat in the UI | Fragile; Settings visit |
| IMCore private bridge (imsg, BlueBubbles) | 0 | Disable SIP | Exact | Not for normal users |

- **The Automation prompt.**
  - It appears the first time the app sends an Apple event to Messages, and only in a GUI session. The app needs [`NSAppleEventsUsageDescription`](https://developer.apple.com/documentation/bundleresources/information-property-list/nsappleeventsusagedescription) and, under the hardened runtime, the [`com.apple.security.automation.apple-events`](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.automation.apple-events) entitlement **(Apple)**.
  - It cannot be pre-granted: "the checkbox only appears in System Settings after the first prompt" ([herald research](https://github.com/ack-ventures/herald/blob/main/docs/research/sending.md), July 2026) **(observed)**. It *can* be pre-explained: show a screen first, then trigger it on purpose. A harmless read (`get name of every chat`, which `threadback doctor --automation` already does) or `AEDeterminePermissionToAutomateTarget` with ask-if-needed (from memory) both work.
  - Denied: `-1743`. Re-enable under System Settings > Privacy & Security > Automation.
- **Sandboxed apps** need a `com.apple.security.temporary-exception.apple-events` entry naming Messages (`com.apple.MobileSMS`). iMCP ships this pattern for Music ([entitlements](https://github.com/mattt/iMCP/blob/main/App/App.entitlements)) **(observed)**. Temporary exceptions are a reason the **Mac App Store is not a realistic route** for the sender; Developer ID is (inference; see note 06).
- **Group sends on macOS 26 and 27: still contested.**
  - [imsg #90](https://github.com/openclaw/imsg/issues/90): on 26.3.1, `any;+;` gave `-1728` and `any;-;` "succeeded" into an unjoined SMS row. The maintainer, closing it on 2026-05-04: "I could not make Tahoe Messages.app deliver group sends via a different `any;+`/`any;-` spelling". imsg now only *detects* the failure. Its current docs say Messages "sometimes" does this ([groups.md](https://github.com/openclaw/imsg/blob/main/docs/groups.md)).
  - Against that, herald's July 2026 research calls `send … to chat id` "CONFIRMED working" on Tahoe, citing BlueBubbles #777, but that quote concerns `any;-;` direct chats. A 26.4 spike (2026-09-29) passed direct sends and did not test groups ([Jarvis #1280](https://github.com/nolanmak/Jarvis/issues/1280)).
  - No report found of a macOS fix in 26.x or 27. Apple Community users say group messaging problems were "NOT resolved in version 26.2" (snippet).
  - **Status: UNVERIFIED per Mac.** The existing `send.py` (verify in `chat.db`, one `;+;`/`;-;` swap on `-1728`) is the right defence. Rewriting `any;` → `iMessage;` ([imessage-rs](https://github.com/jesec/imessage-rs/blob/main/crates/imessage-apple/src/scripts.rs)) is a cheap third spelling to try.
- **Anything new in 26/27?** No public send API on the Mac. `MSMessage` is still not for macOS (note 03).

## 3. Noticing `/wrapped`

- **Polling `chat.db`** needs the read access from §1. With the folder grant this costs nothing extra.
- **Shortcuts automations exist on the Mac from Tahoe**, including a Messages trigger "from a particular sender or with certain body text" and a "Run Immediately" option (MacStories review via search snippet; **UNVERIFIED**). They are worse than polling:
  - the user builds the automation by hand in Shortcuts, and no API creates one (inference);
  - the trigger is keyed to senders and text, and nothing shows it reports *which group* the message came from (**UNVERIFIED**), so the reply cannot be routed.
- **Notifications:** no public API reads other apps' notifications. Not viable (inference).

## 4. Staying on

- **Login item.** [`SMAppService.mainApp`](https://developer.apple.com/documentation/servicemanagement/smappservice/mainapp) `register()` launches the app at each login and needs no approval click ([Apple](https://developer.apple.com/documentation/servicemanagement/smappservice/register())) **(Apple)**. macOS then shows a "Login Item Added" style notification (wording from memory, **UNVERIFIED** on 26/27). The user can switch it off under General > Login Items & Extensions, and [`openSystemSettingsLoginItems()`](https://developer.apple.com/documentation/servicemanagement/smappservice/opensystemsettingsloginitems()) opens that pane.
- **App Nap and idle sleep.** A menu-bar app with no window can be napped (inference). Hold a [`ProcessInfo.beginActivity`](https://developer.apple.com/documentation/foundation/processinfo/beginactivity(options:reason:)) token: `.userInitiatedAllowingIdleSystemSleep` while running, or add `.idleSystemSleepDisabled` (the in-app `caffeinate -i`) if the user ticks "keep this Mac awake".
- **Sleep and lid.** A closed lid sleeps the Mac and nothing answers until it wakes. After waking, catch up from the cursor and ignore stale commands (note 03 §9, already built). Power Nap running the app: **UNVERIFIED** (assume not).
- **What the user must understand, in one sentence:** "Threadback answers only while this Mac is awake and you are logged in; replies come from your own iMessage."

## 5. The honest click count

Assumes a notarized Developer ID build and a DMG. **[macOS]** marks a step no design can remove; **[leaves app]** marks a step that leaves our window.

### Design A: folder pick (recommended)

1. Click **Download** on the website. (Safari may ask once to allow downloads from the site: **[macOS]**, browser.)
2. Click the downloaded `Threadback.dmg`; a Finder window opens. **[leaves app]**
3. Drag the Threadback icon onto Applications.
4. Double-click Threadback.
5. **Open** on "Threadback is an app downloaded from the Internet. Are you sure you want to open it?" **[macOS]**
6. Welcome screen, "Let Threadback see your messages", click **Continue**. (This one-line explanation could be merged into the panel's own message.)
7. The Open panel appears already inside `~/Library/Messages`; click **Grant Access**. **[macOS]** (system panel, in-app)
8. **Allow** on "Threadback would like to access your contacts" (for first names). **[macOS]**; skippable if the card falls back to "…1234".
9. The app lists group chats; click **Turn on** next to one chat. (Consent text: replies come from your Apple ID.)
10. **Allow** on "Threadback wants access to control Messages". **[macOS]** (Trigger it here, on purpose, after a one-line explanation inside step 9.)
11. The app sends nothing and shows "On". Login item registered; macOS posts a notification (no click).

**Total ≈ 10 clicks, 0 keystrokes, 0 visits to System Settings.** macOS-imposed: steps 5, 7, 8, 10. A zip in place of a DMG saves step 3, but the app should then offer "Move to Applications" (one click), because an app run from Downloads is translocated and makes a poor login item (inference).

### Design B: Full Disk Access (fallback if A fails on some macOS)

1–5. As above.
6. Click **Open Settings**; Privacy & Security > Full Disk Access opens, with a small window holding the app icon. **[leaves app]**
7. Drag the icon into the list (or **+**, find Threadback, **Open**).
8. Touch ID or password. **[macOS]** (**UNVERIFIED** whether it is always asked.)
9. Make sure the switch is on.
10. Possibly **Quit & Reopen**. **[macOS]** (**UNVERIFIED**, see §1)
11. Back in the app: **Turn on** for a chat.
12. **Allow** to control Messages. **[macOS]**

**Total ≈ 12 clicks plus a password, one trip into System Settings.** No Contacts prompt, since FDA covers the AddressBook files. Apple has said this flow will get stricter.

### Design C: no automatic sending (fallback if group sends fail)

As A without step 10. On `/wrapped`, the app posts a notification, "Send recap to Dinner Club?". Clicking it opens a Messages compose sheet with the card, and the owner presses **Send** (`NSSharingService`). That is **≈ 9 clicks to set up, then 2 clicks per reply, and only while the owner is at the Mac.** Members' `/wrapped` is no longer self-serve.

### Without notarization

- The first open is refused. The user then goes to System Settings > Privacy & Security, clicks **Open Anyway**, authenticates, and clicks **Open** again ([Apple, 2024-08-06](https://developer.apple.com/news/?id=saqachfa); note 03 §8). That is **+4 clicks, a password and a Settings trip.**
- With an ad-hoc signature the grants do not survive updates ("the system can't tell that version N+1 … is the same", 678819), so steps 7 and 10 come back after every update.

### Imposed by macOS in every design

- The Gatekeeper first-open confirmation.
- One consent act for the Messages data: the panel's Grant Access, or the FDA toggle.
- The Automation Allow for zero-click sending.
- The Contacts Allow, if names come from Contacts.framework.
- Also unavoidable: the Mac must be awake and logged in.

## 6. Scored recommendation (0–5)

| Criterion | A: folder pick | B: Full Disk Access | C: confirm each reply |
|---|---|---|---|
| Setup clicks | 4 (≈10) | 2 (≈12 + password) | 4 (≈9) |
| Never leaves the app | 5 | 1 | 5 |
| Evidence it works on 15/26/27 | 3 (shipping apps; 27 probe; no packaged test on 26) | 4 | 3 |
| Survives updates and reboots | 3 (bookmark; reboot UNVERIFIED) | 4 | 3 |
| Future-proof against Apple's FDA tightening | 4 | 1 | 4 |
| Members can trigger it alone | 4 (if group send works) | 4 | 1 |
| Privacy story | 5 (one folder) | 2 (whole disk) | 5 |
| **Total** | **28** | **18** | **25** |

**Build A, with B as a hidden fallback and C as the automatic fallback when a verified group send fails.**

## UNVERIFIED

- That a packaged, Developer-ID-signed app (sandboxed or not) gets `chat.db` and `chat.db-wal` via the folder pick on **macOS 15 and 26**. Proven only by shipping sandboxed apps of unknown OS coverage and by a script-host probe on 27.
- That the grant survives a **reboot** and an **app update** (both models).
- That drag-and-drop of the folder grants the same access.
- Whether FDA applies without relaunch; whether the FDA toggle always asks for a password; both deep-link forms on 15/26/27.
- Group sends by AppleScript on 26.4+ and 27 for any spelling; the `iMessage;+;` rewrite.
- Sending the card image from a sandboxed app (which folder Messages accepts it from).
- Whether `NSSharingService` / `sms:` recipients land in the existing *named* group thread.
- Exact wording of the login-item notification and Contacts prompt on 26/27; Power Nap behaviour.
- The macOS Shortcuts Messages trigger, its "Run Immediately" option, and what it exposes.

## 7. Experiments for the owner (a few minutes each, on a real Mac)

1. **Folder pick in a shipped app (no build needed).** Install [iMCP](https://github.com/mattt/iMCP) (notarized, free), turn on Messages, pick `~/Library/Messages`. Have a friend send a message, check iMCP sees it within seconds (this checks the WAL), then reboot and check again. Repeat on each macOS version available.
2. **Group send.** `threadback send-test --chat "<small group>" --with-image` on 26.x and 27, and keep the exact result line. If it says `unverified`, try the same chat id with `iMessage;+;` in place of `any;+;` in Script Editor.
3. **Non-sandboxed packaged app.** A 30-line Swift app signed with a development certificate does the following: Open panel at `~/Library/Messages`, read the first 16 bytes of `chat.db` and `chat.db-wal`, read them again from a child `/bin/sh`, quit, relaunch, reboot, read again. Backspacer's probe is the template.
4. **Update survival.** Rebuild that app with the same signing identity and a new version number, then check that access and the Automation grant remain.
5. **FDA relaunch.** In that app, grant FDA while it runs, bring it to the front, and see whether a read succeeds without quitting.
6. **Share-sheet targeting.** `NSSharingService(named: .composeMessage)` with the group's member handles: does the sheet open on the existing named group or a new one?
7. **Sleep.** With the app running, close the lid, send `/wrapped` from a phone, open the lid, and time the reply.

## Implications for the build

- **One process.** Read, detect and send inside the menu-bar app itself, registered with `SMAppService.mainApp`. A separate helper or LaunchAgent loses the folder grant; that is what pushed AutoSpoto back to FDA.
- **Ask for the folder, never the file.** Open the panel *inside* `~/Library/Messages` with directories only and a delegate that enables just that folder, prompt "Grant Access", and store a security-scoped bookmark. On any read failure, show one "Reconnect" button that repeats the pick.
- **Sandbox or not is still open; decide it by experiment 3.**
  - Non-sandboxed keeps the Python engine as a child process (the child inherited the grant on 27) and avoids temporary exceptions.
  - Sandboxed copies iMCP's proven entitlements, but probably means a Swift reader.
- **Trigger the Automation prompt deliberately**, right after the user turns on a chat, with a one-line explanation first. Never trigger it from the first `/wrapped`.
- **Names:** ask for Contacts (one Allow) instead of reading the AddressBook files, which the folder grant does not cover.
- **Keep verify-every-send**, and add design C (notification, then the share sheet) as the automatic fallback when a group send comes back `unverified`.
- **Budget $99/yr for Developer ID.** Without it the click count rises by about four plus a password, and every update re-prompts.

## Sources

Inline above. The answers lean most on:

- Apple: forum threads [678819](https://developer.apple.com/forums/thread/678819), [799832](https://developer.apple.com/forums/thread/799832), [124121](https://developer.apple.com/forums/thread/124121), [114452](https://developer.apple.com/forums/thread/114452), [841091](https://developer.apple.com/forums/thread/841091); [Updates to Full Disk Access](https://developer.apple.com/news/?id=p6zjojqw); the SMAppService, NSSharingService, ProcessInfo and Apple Events documentation pages.
- Source code: [AutoSpoto](https://github.com/martinmaly21/AutoSpoto), [iMCP](https://github.com/mattt/iMCP), [Backspacer](https://github.com/anton-g-kulikov/backspacer), [Read Receipts](https://github.com/arkhivespace/readreceipts), [imsg](https://github.com/openclaw/imsg) and its issues, [herald](https://github.com/ack-ventures/herald/blob/main/docs/research/sending.md), [imessage-rs](https://github.com/jesec/imessage-rs).
- Search snippets only: Eclectic Light (April 2026 privacy series), Michael Tsai, MacStories' Tahoe review, Apple Community threads.
