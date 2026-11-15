# Threadback for Mac

The main way to use Threadback. One person in a group chat installs this small Mac app and
turns it on for that chat. After that, anyone in the chat types `/wrapped` and that Mac
answers in the thread.

- **Get it:** https://averyhsu.github.io/imessage-wrap/mac/ (a page that walks through the
  download and the first open).
- **Direct download:**
  [Threadback-for-Mac.dmg](https://github.com/averyhsu/imessage-wrap/releases/latest/download/Threadback-for-Mac.dmg),
  from the [Releases page](https://github.com/averyhsu/imessage-wrap/releases).
- **Needs:** macOS 14 or later, signed in to Messages. Apple and Intel chips.

This page is the summary. The evidence is in
[research note 07](research/07-mac-app-permission-floor.md) (permissions),
[note 08](research/08-mac-one-click-distribution.md) (ways to ship it), the code in
[`mac/`](../mac/) and the pictures in [`screenshots/mac/`](screenshots/mac/).

![The app on a macOS 26 runner: the welcome screen, the Messages folder window with its Grant Access button, the sheet that says what a reply will be before a chat is turned on, and the last screen showing the picture, text and link everyone gets](media/mac-app-setup.jpg)

All chats in these pictures are invented.

## What a reply is

Three messages, sent from the owner's Apple ID into the chat where `/wrapped` was typed:

1. a picture: the chat's year on one card;
2. a short text: messages, active days, the chat's personality, top senders, awards,
   tapbacks, the busiest day;
3. a link that opens the full tap-through story in any browser, for everyone in the chat.

The link is the recap. It holds the chat's name, first names and the counts, packed into the
part after `#`, which browsers never send to a website. It never holds the words of a
message. Anyone the link is passed on to can open it. When Messages shows a link it may load
the site's preview picture; that request does not include the recap.

## Setup, click by click

No typing, no Terminal, no Full Disk Access.

| # | What the person does | Who asks |
|---|----------------------|----------|
| 1 | Click **Download** on the guide page | us |
| 2 | Open the download; drag Threadback to Applications | macOS |
| 3 | Double-click Threadback. macOS says "“Threadback” Not Opened". Click **Done** | macOS |
| 4 | System Settings → Privacy & Security → **Open Anyway**, then confirm | macOS |
| 5 | Click **Continue** on the welcome screen | us |
| 6 | Click **Grant Access** in a file window that already shows the Messages folder | macOS |
| 7 | Click **Allow** so people show by first name (optional) | macOS |
| 8 | Click **Turn on** next to one group chat, read what a reply will be, click **Turn on** again | us |
| 9 | Click **Allow** when macOS asks whether Threadback may control Messages | macOS |

Steps 3 and 4 exist only because the app is not signed through Apple's paid developer
program. With it they become one click on **Open**.

**Why there is no Full Disk Access step.** When a person picks the Messages folder in the
standard Open window, macOS treats that as consent for that one folder. Full Disk Access
stays as a fallback only.

## The rules it follows

- It answers only in chats that were turned on, and it identifies a chat by its internal
  id, never by its name. A renamed chat, or another chat with the same name, gets nothing.
- Only a message that is exactly the command counts: `/wrapped` (or `/recap`) for this year
  so far, `/wrapped 2025` for a past year, `/wrapped all` for everything. A sentence that
  mentions the command, a tapback, an edit, a sticker or one of its own messages never does.
- At most one reply per chat every two minutes. Nothing typed before the chat was turned
  on, or more than ten minutes ago, is answered.
- **Before a chat is turned on, the app says what a reply will be**, and the owner confirms.
  If a later version changes what a reply carries, that chat is not answered until the
  owner confirms again.
- **Pause all** and **Turn off** take effect at once, even in the middle of a reply. A pause
  is remembered when the app is reopened, and nothing typed during a pause is answered
  afterwards.
- At most 20 replies per chat in 24 hours. After three replies in an hour the wait between
  replies grows from two minutes to ten.
- Only one copy of the app runs at a time, so a command is never answered twice.
- It looks for its own message in the Messages database after each send and reports what it
  finds: delivered, sent, or written but not yet sent. When it cannot find it, it offers the
  reply for the owner to send by hand.
- It has no network code. The only thing it sends is the reply, through Messages.
- It cannot send anything in CI, by design.

## What has been seen working

**In CI, on a macOS 26 runner, with invented chats:**

- A normal double-clickable app of about 3 MB.
- It runs the same counting code as the browser maker. On five invented chats its numbers
  are byte-for-byte the same as the command-line tool's, and its text reply is identical.
- The link it builds decodes back to the same recap, and the story plays from it in the
  app's own window.
- The setup screens above are real and photographed, including the Messages folder window
  with its "Grant Access" button and macOS's own "control Messages" prompt.
- The download is fetched the way a browser would and opened the way a double-click would.

**On the owner's own Mac (macOS 26.7.1, Apple silicon, 2026-11-15, build `9872b81`):**

- **The folder pick replaces Full Disk Access.** Before the pick, reading the Messages
  database failed with "Operation not permitted", so macOS really was guarding it. After one
  click on **Grant Access** the app read the database and its write-ahead log.
- **A reply arrives in a real group chat.** `/wrapped` typed from a phone was answered with
  the picture and the text. The app then found both in the Messages database with no error.
- The disk image, the "Open Anyway" detour and the "control Messages" prompt were all got
  through by clicking.

That build did not send the link yet, because the site was not live then.

## What is not proven

1. **The link in a real chat**: that it arrives, and how Messages shows it.
2. **Staying connected** after quitting the app, restarting the Mac, or installing a newer
   build. The owner's report came from the same launch as the grant.
3. **Updates.** An app that is not signed through Apple's program looks like a new app to
   macOS each time it changes. Expect to pick the Messages folder again and to allow control
   of Messages again after every update. This is documented macOS behaviour; nobody has
   watched it happen with this app.
4. **Other Macs and versions.** One Mac on 26.7.1 is one data point. Sending to group chats
   from a script is reported as unreliable on some versions of macOS 26 and 27, which is why
   "send by hand" exists.
5. **Delivery.** What Messages records about a message is all the app can see. "Delivered"
   there is Messages' own word; the app cannot check each phone in the chat.
6. **Names.** Contacts access was declined in the owner's test, so people showed as `…1234`.
7. **The "Open Anyway" row.** The "Not Opened" window was photographed on the owner's Mac;
   the row in System Settings was not, so the guide page's wording for it is marked as
   approximate.

8. **One failed test run with no proven cause.** In one CI run the one-time message
   "Threadback keeps answering from the menu bar" appeared a second time and blocked the
   test's clicks. It did not happen again in the runs that followed, which repeat that
   sequence seven times each, and four likely causes were ruled out. The message now counts
   as shown the moment it appears, a second one cannot start while one is up, and settings
   are saved before the app quits. Test builds record every window event, so a repeat would
   name its cause. The worst case on a real Mac is seeing that message twice.

The checks for these are in [`STATUS.md`](../STATUS.md), "Your checks".

## An independent review

After the owner's test, a reviewer who had not seen the app being written was asked to break
it. The findings that mattered, all fixed and now covered by tests:

- **Pause did not pause.** The window said "Paused" while a `/wrapped` was still answered.
- **Two open copies both answered**, so a chat could get every reply twice.
- **Turning a chat off did not stop a reply already on its way**, and could lead to a second
  reply inside the two-minute wait.
- **What a reply contains was shown after the click that turned it on**, and a chat turned
  on when replies had no link would have started getting one without being asked again.
- **Two chats with similar names could have received each other's picture**, because the
  picture's file name was built from the chat's name.
- "Delivered" could be claimed on the strength of a different message in the same chat.
- A chat member typing `/wrapped` every two minutes could make the owner's Apple ID post
  all day.
- The picture could stop working for good after a crash in the part that draws it.
- The job that builds the app could also publish it; now a separate, smaller job does.

What the reviewer checked and could not break: a chat is approved by its internal id, the
command rule, one reply per command, the way text is handed to Messages (never pasted into
a script), read-only access to the database, the absence of any network code, and the
masking of numbers and addresses in the picture, the text and the link.

The merge of this version into `main` was held until these were fixed, so the public
download never pointed at the build with the pause fault. The full list is in
[DECISIONS](DECISIONS.md), D17.

## How it is built and released

- Swift and SwiftUI; the Xcode project is generated by XcodeGen from
  [`mac/project.yml`](../mac/project.yml). The counting code is the browser maker's
  JavaScript engine, run unchanged inside the app, so the conformance suite covers it.
- Every push that touches the app builds and tests it on a macOS runner
  ([workflow](../.github/workflows/mac-app.yml)).
- A build from `main` becomes the public download on the Releases page. A build from the
  working branch becomes a rolling test build marked "pre-release".
- The app is signed ad hoc, not by Apple. That is why macOS blocks the first open.

## Decisions

- **No Apple Developer Program for now** (owner, 2026-11-12). It costs $99 a year. It would
  remove the first-open detour, keep permissions across updates, and put the iPhone app on
  TestFlight. The owner's legal name would appear as the developer.
- **The Mac app is the main way to use Threadback** (owner, 2026-11-12), and its builds are
  public on the Releases page (owner, 2026-11-15).
- Not possible at any price: the Mac App Store (Apple rarely approves apps that control
  Messages), and any route with nothing to install.

## Not built yet

- Automatic updates. A new version is a new download.
- Message text in a reply. The command-line helper can include the most-reacted messages if
  asked; the app never does.
