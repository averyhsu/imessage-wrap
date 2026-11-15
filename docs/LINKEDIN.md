# LinkedIn post (draft)

Attach the clip from [`DEMO.md`](DEMO.md) and put the link in the first comment as well as
in the post.

**Before posting**, replace the bracketed parts:

- `[N]` and `[M]`: your own chat's numbers, after you have made a real recap (and the chat
  is fine with you sharing them). Do not post the demo's invented numbers as your own.
- `[PERSONALITY]`: what your chat came out as.
- `[LINK]`: the public site, `https://averyhsu.github.io/imessage-wrap/`.

---

**Our group chat sent [N] messages this year. [M] of them after midnight.**

Music apps tell you about your year. Your group chat, the place you actually spent it, tells
you nothing. So I built the missing recap: like Spotify Wrapped, for your iMessage group chats.

It's called Threadback. Someone types /wrapped in the chat, and the recap arrives in the
thread: a card, the headline numbers, and a link everyone taps through.

→ how many messages you all sent, and when
→ your chat's personality (ours: [PERSONALITY])
→ who carried the conversation
→ the message of the year, picked by tapbacks
→ awards nobody asked for (The Lurker knows who they are)

How it works, in one line: one person in the chat runs a small Mac app, it counts on that
Mac and packs the numbers into the link itself, so there is no account, no upload, and
nothing to install to watch.

The interesting constraint: Apple gives apps no way to read your message history on an
iPhone, and no way to add a command to Messages. So the recap is made where the history can
be read (a Mac), a menu-bar app there notices /wrapped and answers, and everyone else just
taps the link. No Mac app? There is a version that runs in the browser too.

I built it with Claude Code running a small team of AI agents: one researched each possible
route, others built and tested the pieces in parallel (including an iPhone app compiled and
run in Apple's simulator on cloud Macs), and three independent reviewers tried to break it.
They found real problems, and those got fixed before I posted this. The research notes and
every decision are in the repo.

Try the demo, then get it for your own chat: [LINK]
Code and write-up: https://github.com/averyhsu/imessage-wrap

What would your group chat's personality be?

#buildinpublic #sideproject #ios #ai

---

## Notes for posting

- **Shorter variant** (under about 600 characters): keep the first two lines, the five
  arrows, the "one line" paragraph and the link.
- **Say only what you have seen.** The post leads with `/wrapped`, which has answered in a
  real chat on your own Mac. Before posting, see the link arrive once too (check 2 in
  [`STATUS.md`](../STATUS.md)); if the link turns out not to arrive, change the second
  paragraph to "a card and the headline numbers" and put the link in by hand.
- **Be upfront about the Mac app.** It is not signed through Apple's paid program, so the
  first open is blocked once and takes a detour through System Settings; the download page
  walks people through it. Worth a line in the first comment, so nobody is surprised.
- **What to leave out.** The app for the Messages app drawer on iPhone: nobody else can
  install it until it is on TestFlight, which needs the paid Apple Developer Program.
- **Names.** "Spotify Wrapped" and "iMessage" are other companies' trademarks. The post uses
  them only to describe what the project is like and what it works with; the product name is
  Threadback. Keep it that way in the headline and the video end card.
- **Quotes.** A recap leaves the words of messages out unless you switch them on. If your
  clip shows the message of the year with its text, ask whoever wrote it first.
- **Good first comment:** "How it's built, what Apple does and doesn't allow, and the eleven
  routes I scored before picking this one: [link to docs/DECISIONS.md]".
