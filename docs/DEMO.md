# Demo: a 40-second screen recording

The goal of the clip: someone who has never heard of this understands it in the first five
seconds and wants to try it by the end. No voice-over needed; captions carry it.

Three ways to record it:

- **Version A** is the real thing: someone types `/wrapped` in a real group chat and the
  recap arrives. It needs the Mac app on for that chat and the chat's blessing.
- **Version B** needs nothing but a browser: the built-in demo with an invented chat.
  Nothing is sent anywhere. Use it if you would rather not show a real chat.
- **Version C** is for a chat with no Mac app running: paste a recap link you made in the
  browser.

## Before you record

- **Use invented or consenting content.** The built-in demo chat ("Dinner Club 🍝") is all
  invented. If you record a real chat, ask the people in it first.
- **See it work once before the take.** Version A has been seen on one Mac, with a build
  that sent the picture and the text. The link is newer: run check 2 in
  [`STATUS.md`](../STATUS.md) first, so the recording is not the first time it arrives.
- **Quotes are off by default.** A real recap shows who wrote the message of the year and
  its tapbacks, not the words. The demo chat shows invented quotes.
- **Names.** People who are not in your contacts show as `…1234`. Allow Contacts in the Mac
  app (or name them in the browser maker) before recording, so the story shows first names.
- iPhone: Settings → Control Center → add **Screen Recording**. Turn on Do Not Disturb.
- Record vertical, export 1080 × 1920. LinkedIn autoplays muted, so every beat needs a caption.
- The story has 12 slides and takes about 80 seconds if left alone. **Tap through it**: a tap
  on the right side skips to the next slide. The tables below say how many taps each beat
  takes.

The 12 slides, in order: cover, total messages, 24-hour clock, personality, after midnight,
the week, the year, top senders, message of the year, tapbacks, awards, summary card.

## Version A: `/wrapped` in a real chat

Needs: [Threadback for Mac](https://averyhsu.github.io/imessage-wrap/mac/) turned on for
that chat, the Mac awake, and the chat's blessing. Record on your phone.

| Time | On screen | Taps | Caption |
|------|-----------|------|---------|
| 0:00–0:04 | The group chat in Messages. Type `/wrapped`, send. | – | "Our group chat sent [N] messages this year." |
| 0:04–0:09 | The card, the short text and the link arrive in the thread. Hold for a beat. | – | "Type /wrapped. Get this." |
| 0:09–0:13 | Tap the link. Cover, then the big number counts up. | 1 (cover → total) | "A year in review, for the group chat." |
| 0:13–0:17 | The 24-hour clock, then your chat's personality. | 2 | "It knows what kind of chat you are." |
| 0:17–0:22 | **Who carried the chat**: the crown lands on the top sender. | 4 (quick: after midnight, the week, the year flash by) | "Who carried." |
| 0:22–0:26 | **Message of the year** with its tapbacks. | 1 | "The message of the year, by tapbacks." |
| 0:26–0:30 | **And the winners are…**, then the summary card. | 3 (tapbacks flashes by) | "And the awards nobody asked for." |
| 0:30–0:37 | Cut to the Mac: the Threadback window with the chat switched on. | – | "One Mac in the chat does the counting. Nothing is uploaded." |
| 0:37–0:42 | End card: **Threadback** + the link. | – | "Get it for your chat. Link below." |

Whether the link shows a preview card in the thread is one of the things only a real phone
can confirm. If it does, hold on it a second longer; if it shows as a plain link, cut
straight to the tap.

## Version B: the demo, in a browser

Open **https://averyhsu.github.io/imessage-wrap/?demo=1** in a browser window sized like a
phone (or use the browser's device toolbar), or on your phone, and record it.

| Time | On screen | Taps | Caption |
|------|-----------|------|---------|
| 0:00–0:05 | Cover, then the big number counts up. | 1 (cover → total) | "What if your group chat got a year in review?" |
| 0:05–0:10 | The 24-hour clock, then **The Firehose**. | 2 | "It knows what kind of chat you are." |
| 0:10–0:16 | **Who carried the chat**: the crown lands on the top sender. | 4 (quick: after midnight, the week, the year flash by) | "Who carried." |
| 0:16–0:21 | **Message of the year** with its tapbacks. | 1 | "The message of the year, by tapbacks." |
| 0:21–0:26 | **And the winners are…** | 2 (tapbacks flashes by) | "And the awards nobody asked for." |
| 0:26–0:30 | Summary card; press **Share card**. | 1 | "One card to share." |
| 0:30–0:38 | The site's front page, scrolled to "Type /wrapped. A Mac answers." | – | "Type /wrapped in your own chat. Counted on your Mac, nothing uploaded." |
| 0:38–0:42 | End card: **Threadback** + the link. | – | "Get it for your chat. Link below." |

A ready-made, frame-perfect recording of the demo story is in the repo for b-roll:
[`docs/media/demo-story.mp4`](media/demo-story.mp4) (the whole story at its real pace) and a
short looping GIF next to it. `npm run record` rebuilds both.

## Version C: a pasted link, no Mac app

Make a recap on the [maker page](https://averyhsu.github.io/imessage-wrap/make/) and copy
its link. Then record Version A with one change: at 0:00 paste the link and send it instead
of typing `/wrapped`, and at 0:30 cut to the maker page (drop `chat.db` in, pick the chat,
the link comes out) with the caption "Made on your own device. Nothing is uploaded."

## Add-on: the Messages app

After 0:30, three seconds of the iPhone app in the Messages drawer: tap +, choose
Threadback, the recap card goes into the chat, a tap plays it inside Messages. Nobody else
can install that app until it is on TestFlight, so label it "coming"; until you have it on
a real phone, the Simulator recording in [`docs/screenshots/ios/`](screenshots/ios/) can
stand in, labelled as a simulator.

## Shot checklist

- [ ] First frame is the chat (or the cover), not a title card.
- [ ] The big number is on screen by second 15 (Version A) or 5 (Version B).
- [ ] No real phone numbers, names or messages visible unless everyone agreed.
- [ ] Captions readable on a phone with the sound off.
- [ ] Ends on the name and the link.
