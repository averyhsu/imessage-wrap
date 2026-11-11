"""Threadback Mac helper: answers ``/wrapped`` typed in a group chat.

Everything here runs on the owner's Mac. It reads ``chat.db`` read-only, computes
the recap locally through the stats engine, and replies into the thread with a
card image, a short text recap and a link. Nothing is sent unless the person
running it has explicitly opted in (see ``agent.py`` and ``docs/MAC.md``).

The modules are deliberately small and injectable so that every part except the
final AppleScript hand-off to Messages can be tested without a Mac:

- ``triggers``  what counts as a command
- ``engine``    the narrow interface to the stats engine (and the real adapter)
- ``card``      the PNG that lands in the thread (Pillow)
- ``text``      the plain-text recap
- ``send``      AppleScript sender with chat.db verification, and a dry-run sender
- ``agent``     the polling loop
- ``ai``        optional model-written awards (opt-in)
- ``cli``       ``register(subparsers)`` for the ``wrapped`` command
"""

# The public product name is one constant (docs/SCHEMA.md §7). Code, file names and
# the typed command keep the working name ``wrapped``.
PRODUCT_NAME = "Threadback"
TAGLINE = "your group chat's year in review"

__all__ = ["PRODUCT_NAME", "TAGLINE"]
