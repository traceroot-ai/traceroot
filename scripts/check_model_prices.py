"""Check the standard model price file against two public price catalogs.

Run it with --help for what it reports and how. The code is in the model_prices package
next to this file, which Python finds because it puts this file's directory on the path.
"""

import sys

from model_prices.cli import main

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
