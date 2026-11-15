"""``python -m wrapped.mac`` runs the Mac-helper commands on their own."""

import sys

from .cli import main

if __name__ == "__main__":
    sys.exit(main())
