# Status

_Last updated: 2026-11-11 — research complete, builds in progress_

## What works (verified)
- Research on all candidate paths is written up with sources in `docs/research/` and
  synthesised, scored and decided in `docs/DECISIONS.md`.
- The shared contract (`docs/SCHEMA.md`): stats JSON v1, exact counting rules, link payload,
  embed bridge, naming.
- Invented demo data (`web/js/demo-data.js`) and a cross-language payload test vector
  (`tests/vectors/payload-v1.json`).

## In progress (not yet verified — do not rely on these yet)
- Web story player (`web/`), with Playwright tests and screenshots.
- Stats engines: Python (`wrapped/`) and in-browser JavaScript (`web/make/`), with generated
  fixtures and a conformance suite.
- iOS app + iMessage extension (`ios/`), built on GitHub Actions `macos-26`.
  First CI run: https://github.com/averyhsu/imessage-wrap/actions/runs/43030079757 (queued).

## Not started
- Mac helper that answers `/wrapped` in a group chat (card + link via AppleScript).
- "Make your own" page UI on top of the in-browser engine.
- README for strangers, `docs/DEMO.md`, `docs/LINKEDIN.md`.
- Independent review pass.

## Waiting on the owner (nothing is blocked on these yet)
- Turning on GitHub Pages (makes the demo and links public). Prepared: `.github/workflows/pages.yml`, manual-only.
- Apple Developer Program ($99/yr) for TestFlight / notarization.
- Any send into a real group chat.

## Assumptions made so far
- The brief names the repo `imessage-wrapped`; the repo this session was actually given is
  `averyhsu/imessage-wrap`, so all work happens there, on branch
  `claude/imessage-wrapped-build-84gdoo` (the only branch this session may push to).
- No `imessage-wrapped.zip` was attached, so the Mac prototype is being recreated from the
  written description rather than imported.
- The repo is already public, so nothing private is ever committed. GitHub Pages is **not**
  enabled and will not be without an explicit yes.
- Public product name is "Threadback" (one constant) to stay clear of the "iMessage" and
  "Wrapped" trademarks; code and the `/wrapped` command keep the working name. See
  `docs/DECISIONS.md` D4.
