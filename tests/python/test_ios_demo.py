"""The iPhone app's built-in sample is the site's demo.

ios/Shared/DemoRecap.swift holds the sample as a link payload. It once drifted from
web/js/demo-data.js and went on showing a personality the site no longer gave that chat.
"""
import importlib.util
import os
import unittest

import support

from wrapped.payload import decode_payload

SCRIPT = os.path.join(support.ROOT, "ios", "scripts", "make-demo-payload.py")


def load_script():
    spec = importlib.util.spec_from_file_location("make_demo_payload", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class IOSDemoTests(unittest.TestCase):
    def test_the_swift_sample_decodes_to_the_site_demo(self):
        script = load_script()
        stats = decode_payload(script.swift_payload())
        self.assertEqual(stats, script.demo_stats(),
                         "run python3 ios/scripts/make-demo-payload.py after changing the demo")

    def test_the_sample_carries_the_reason_for_its_personality(self):
        personality = decode_payload(load_script().swift_payload())["personality"]
        self.assertTrue(personality.get("reason"))
        self.assertEqual(personality["blurb"].split(". ")[0], personality["reason"])


if __name__ == "__main__":
    unittest.main()
