# Threadback

**Your group chat's year in review.** Like Spotify Wrapped, for iMessage group chats: one
person makes the recap, drops a link in the chat, and everyone taps through the same story.

<p align="center">
  <img src="docs/media/demo-story.gif" width="300" alt="The recap playing: a cover, the message count, the 24-hour clock, the chat's personality, the busiest month, the message of the year and the awards">
</p>

![Twelve slides of the story: total messages, the 24-hour clock, the chat's personality, top senders, message of the year, awards and the share card](docs/screenshots/web/overview.png)

Every name, number and message in this repository is invented. The full recording is
[docs/media/demo-story.mp4](docs/media/demo-story.mp4).

## What you get

A tap-through story, in the style of Instagram or Spotify stories, built from one group chat:

- how many messages, words and photos, and the longest streak
- activity by hour, weekday and month, and the busiest single day
- the chat's **personality**, from when it is most alive ("The Night Owls")
- who was up after midnight
- who carried the conversation
- the **message of the year**, picked by tapbacks
- **chat awards** (The Yapper, The Lurker, The Hype Machine…)
- a summary card to save or share

## Try it

| | What | Needs |
|---|------|-------|
| **Watch the demo** | The full story with an invented chat. | A browser. |
| **Make your own in the browser** | Drop in your Messages database (from a Mac, or from an iPhone backup on a Mac or PC), pick a chat, get a link to send. | A computer that has your messages. Nothing is installed or uploaded. |
| **Mac helper** | Anyone in the chat types `/wrapped`; the recap card, a short summary and the link appear in the thread. | A Mac signed in to Messages. [Guide](docs/MAC.md) |
| **iPhone app** | Threadback in the Messages app drawer: send a recap as a bubble, play it full screen. | Xcode today; TestFlight later. [Guide](ios/README.md) |

The public site is not switched on yet (see [STATUS.md](STATUS.md)). Until it is, run the
same pages locally:

```sh
git clone https://github.com/averyhsu/imessage-wrap && cd imessage-wrap
npm ci && npm run serve
# demo story:     http://127.0.0.1:4173/?demo=1
# make your own:  http://127.0.0.1:4173/make/
```

Everyone *else* in the chat needs nothing at all. The link opens in any phone's browser.

With the iPhone app, the recap also lives in the Messages app drawer. These are from the
real Messages app in the iOS Simulator, driven by the test suite
([all screenshots and a recording](docs/screenshots/ios/)):

![Threadback in the Messages app drawer, a recap card delivered in a conversation, and the story playing inside Messages](docs/media/messages-extension.jpg)

## Where your messages go: nowhere

- **Counted on your device.** The browser page, the Mac helper and the command-line tool all
  read your history locally. There is no server and no account; the site is a folder of
  static files.
- **The link is the recap.** The numbers are compressed into the part of the link after the
  `#`, which browsers never send to any website.
- **What a link contains:** counts, the names in the chat, and nothing else, unless you
  switch on quotes. People who are not in your contacts appear as `…1234`, never as a full
  phone number. The words of the three most-reacted messages are added only if you ask.
- **No tracking.** No analytics, cookies or third-party scripts. A content security policy
  stops the pages from contacting anything but their own files.
- Anyone holding a link can read that recap, so share it the way you would share a screenshot.

## Why it works this way

Apple gives apps no way to read your message history on an iPhone, and an app inside
Messages can only see the one message you tapped. So no single app can do the whole job.
Threadback splits it:

1. **One person computes the recap** where the history can be read: on a Mac
   (`~/Library/Messages/chat.db`), or from an iPhone backup, in the browser or with the
   command-line tool. An iPhone-only route through the Shortcuts app is written up as an
   [experiment](docs/SHORTCUT.md).
2. **The recap travels as a link.** No backend, nothing to keep running.
3. **Everyone watches the same story**, in the browser, or natively in the Messages app
   drawer with the iPhone app.

Eleven possible routes were researched and scored before this one was chosen. The reasoning
is in [docs/DECISIONS.md](docs/DECISIONS.md) and the notes behind it in
[docs/research/](docs/research/).

## What is proven and what is not

Everything was built and tested without a real iPhone or Mac at hand: on Linux, and on
GitHub's macOS runners for the Apple parts. [STATUS.md](STATUS.md) lists exactly what has
been seen working, what has only been tested against invented data, and a two-minute
checklist for the things only a real device can confirm (above all: sending into a real
group chat).

## For developers

```
web/            the story player and landing page (plain HTML/CSS/JS, no build step)
web/make/       the in-browser maker: SQLite in WebAssembly + the JavaScript stats engine
wrapped/        the Python stats engine and command-line tool
wrapped/mac/    the Mac helper (/wrapped): card image, text recap, AppleScript sending
ios/            the iPhone app and its Messages extension (Swift; project made by XcodeGen)
tests/          unit, conformance and end-to-end tests; invented fixtures built at test time
docs/           the shared contract (SCHEMA.md), decisions, research, guides, screenshots
```

Two engines (Python and JavaScript) compute the stats and must agree byte for byte; the
contract they both follow is [docs/SCHEMA.md](docs/SCHEMA.md).

```sh
npm ci
npm test                                   # story unit tests
node --test tests/engine-js/*.test.js      # JavaScript engine
python3 -m pytest tests/python tests/conformance tests/mac -q
npm run test:e2e                           # the story in a real browser (Playwright)
npm run test:make                          # the maker page, end to end
```

The command-line tool, on a Mac:

```sh
pip install .            # or: curl -fsSL …/install.sh | bash   (see docs/MAC.md)
wrapped chats            # list your group chats
wrapped link "Dinner Club" --year 2026     # print the recap link; add --quotes to include message text
```

CI runs on every push: the web story and maker on Linux, both engines on Linux and macOS
(including a check against text archived by Apple's own code), the Mac helper on macOS, and
the iPhone app in the iOS Simulator.

## Names and trademarks

Threadback is an independent project and its source is public here. No licence has been
chosen yet (see [STATUS.md](STATUS.md)). It is not affiliated with, sponsored by
or endorsed by Apple or Spotify. iMessage is a trademark of Apple Inc.; Spotify Wrapped is a
trademark of Spotify AB. They are mentioned only to describe what this project works with
and what it resembles.
