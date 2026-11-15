"""The real ``osascript`` on a real Mac, with harmless scripts only.

These tests prove the plumbing the sender relies on (ARGV passing, the timeout,
the shape of AppleScript error text) on macOS itself. None of them mentions
Messages: nothing here can send, open a chat, or trigger a permission prompt.
They are skipped everywhere except macOS.
"""

import sys
import time
import unittest

import mac_support  # noqa: F401

from wrapped.mac import send

ON_MAC = sys.platform == "darwin" and send.find_osascript() is not None

ECHO = """\
on run argv
	set AppleScript's text item delimiters to "|"
	return (argv as text) & "|" & (count of argv)
end run
"""

PARAGRAPHS = """\
on run argv
	return (count of paragraphs of (item 2 of argv)) as text
end run
"""

RAISE = """\
on run argv
	error (item 1 of argv) number ((item 2 of argv) as integer)
end run
"""

ALIAS = """\
on run argv
	set attachmentFile to (POSIX file (item 1 of argv)) as alias
	return "resolved"
end run
"""


@unittest.skipUnless(ON_MAC, "needs macOS with osascript")
class LiveOsascript(unittest.TestCase):
    def test_none_of_these_scripts_mention_messages(self):
        for script in (ECHO, PARAGRAPHS, RAISE, ALIAS):
            self.assertNotIn("Messages", script)
            self.assertNotIn("send", script)

    def test_argv_reaches_the_script_verbatim(self):
        nasty = 'he said "hi" \\ & `id`; $(echo x) ünïcödé 🍝 \' end tell'
        result = send.run_osascript(ECHO, ["any;+;chat123", nasty, ""], 30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.rstrip("\n"), "any;+;chat123|" + nasty + "||3")

    def test_arguments_starting_with_a_dash_are_data_not_options(self):
        result = send.run_osascript(ECHO, ["any;-;chat123", "-e return 1", "--version"], 30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.rstrip("\n"), "any;-;chat123|-e return 1|--version|3")

    def test_multi_line_text_stays_one_argument(self):
        result = send.run_osascript(PARAGRAPHS, ["g", "line one\nline two\nline three", ""], 30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "3")

    def test_timeout_is_enforced(self):
        started = time.monotonic()
        result = send.run_osascript("delay 20", [], 2)
        self.assertTrue(result.timed_out)
        self.assertLess(time.monotonic() - started, 10)
        reason, hint = send.explain_osascript_error(result)
        self.assertIn("did not answer", reason)
        self.assertTrue(hint)

    def test_real_error_text_carries_the_number_the_sender_parses(self):
        cases = [
            ("Messages got an error: Can’t get chat id \"any;+;chat1\".", -1728, send.CHAT_NOT_FOUND_HINT),
            ("Not authorized to send Apple events to Messages.", -1743, send.AUTOMATION_HINT),
            ("Messages got an error: Application isn’t running.", -600, send.MESSAGES_NOT_RUNNING_HINT),
        ]
        for message, number, hint in cases:
            with self.subTest(number=number):
                result = send.run_osascript(RAISE, [message, str(number)], 30)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(send.osa_error_number(result.stderr), number, result.stderr)
                self.assertEqual(send.explain_osascript_error(result)[1], hint)

    def test_missing_attachment_fails_before_anything_else_could_run(self):
        result = send.run_osascript(ALIAS, ["/nonexistent/threadback/card.png"], 30)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("resolved", result.stdout)
        reason, hint = send.explain_osascript_error(result)
        self.assertIn("attachment", reason, result.stderr)
        self.assertEqual(hint, send.ATTACHMENT_HINT)


if __name__ == "__main__":
    unittest.main()
