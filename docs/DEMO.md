# Demo: a 40-second screen recording

The goal of the clip: someone who has never heard of this understands it in the first five
seconds and wants to try it by the end. No voice-over needed; captions carry it.

Three ways to record it, from "needs nothing" to "the full thing":

- **Version A** runs in a browser on your computer today. Nothing is sent anywhere.
- **Version B** is the real thing on your phone: a link in a real chat. It needs the public
  site switched on and the people in that chat to be fine with it.
- **Add-ons** (the `/wrapped` Mac helper, the Messages app) go in only after you have seen
  them work on your own devices. [`STATUS.md`](../STATUS.md) has the checks.

## Before you record

- **Use invented or consenting content.** The built-in demo chat ("Dinner Club 🍝") is all
  invented. If you record a real chat, ask the people in it first.
- **Quotes are off by default.** A real recap shows who wrote the message of the year and
  its tapbacks, not the words, unless you switch quotes on in the maker. Only do that for
  the recording if the author agrees. The demo chat shows invented quotes.
- iPhone: Settings → Control Center → add **Screen Recording**. Turn on Do Not Disturb.
- Record vertical, export 1080 × 1920. LinkedIn autoplays muted, so every beat needs a caption.
- The story has 12 slides and takes about 80 seconds if left alone. **Tap through it**: a tap
  on the right side skips to the next slide. The tables below say how many taps each beat
  takes.

The 12 slides, in order: cover, total messages, 24-hour clock, personality, after midnight,
the week, the year, top senders, message of the year, tapbacks, awards, summary card.

## Version A: in a browser, today

```sh
git clone -b claude/imessage-wrapped-build-84gdoo https://github.com/averyhsu/imessage-wrap
cd imessage-wrap && npm ci && npm run serve
```

Open `http://127.0.0.1:4173/?demo=1` in a browser window sized like a phone (or use the
browser's device toolbar) and record the window.

| Time | On screen | Taps | Caption |
|------|-----------|------|---------|
| 0:00–0:05 | Cover, then the big number counts up. | 1 (cover → total) | "What if your group chat got a year in review?" |
| 0:05–0:10 | The 24-hour clock, then **The Night Owls**. | 2 | "It knows what kind of chat you are." |
| 0:10–0:16 | **Who carried the chat**: the crown lands on the top sender. | 4 (quick: after midnight, the week, the year flash by) | "Who carried." |
| 0:16–0:21 | **Message of the year** with its tapbacks. | 1 | "The message of the year, by tapbacks." |
| 0:21–0:26 | **And the winners are…** | 2 (tapbacks flashes by) | "And the awards nobody asked for." |
| 0:26–0:30 | Summary card; press **Share card**. | 1 | "One card to share." |
| 0:30–0:38 | `http://127.0.0.1:4173/make/`: press **Try it with sample data**, scroll to the playing preview and the link. | – | "Made on your own device. Nothing is uploaded." |
| 0:38–0:42 | End card: **Threadback** + the link. | – | "Make one for your chat. Link below." |

A ready-made, frame-perfect recording of the demo story is in the repo for b-roll:
[`docs/media/demo-story.mp4`](media/demo-story.mp4) (the whole story at its real pace) and a
short looping GIF next to it. `npm run record` rebuilds both.

## Version B: on your phone, in a real chat

Needs: the public site on, a recap you made for a real chat on the maker page, and the
chat's blessing.

| Time | On screen | Caption |
|------|-----------|---------|
| 0:00–0:04 | The group chat in Messages. Paste the recap link, send. | "Our group chat sent [N] messages this year." |
| 0:04–0:08 | The link lands in the thread. Hold on it for a beat. | "So I made it a year in review." |
| 0:08–0:30 | Tap the link, then the same beats and taps as Version A. | Same captions. |
| 0:30–0:38 | Cut to the maker page on a laptop: drop `chat.db` in, the chat list appears, pick the chat, the link comes out. | "Made on your own device. Nothing is uploaded." |
| 0:38–0:42 | End card. | "Make one for your chat. Link below." |

Whether the link shows a preview card in the thread (it should, with a short looping
video) is one of the things only a real phone can confirm. If it does, hold on it a second
longer; if it shows as a plain link, cut straight to the tap.

## Add-ons, once they are proven on your devices

- **`/wrapped`.** With the Mac helper running for that chat
  (`threadback agent --chat "…" --keep-awake`, see [`MAC.md`](MAC.md)), replace 0:00–0:08 of
  Version B: someone types `/wrapped`, and the card, a short text recap and the link arrive
  as replies. Caption: "Type /wrapped, get this."
- **The Messages app.** After 0:30, three seconds of the app in the Messages drawer: tap +,
  choose Threadback, the recap card goes into the chat, a tap plays it inside Messages.
  Until you have it on a real phone, the Simulator recording in
  [`docs/screenshots/ios/`](screenshots/ios/) can stand in, labelled as a simulator.

## Shot checklist

- [ ] First frame is the chat (or the cover), not a title card.
- [ ] The big number is on screen by second 5.
- [ ] No real phone numbers, names or messages visible unless everyone agreed.
- [ ] Captions readable on a phone with the sound off.
- [ ] Ends on the name and the link.
