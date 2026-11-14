"""The real price file, read from the repository: a row problem fails CI before merge,
not only the daily check."""

import json
from pathlib import Path

from scripts.model_prices.catalogs import PRICE_PATH, validate_rows
from scripts.model_prices.checks import find_row_problems

PRICE_FILE = Path(__file__).resolve().parents[2] / PRICE_PATH


def test_the_real_price_file_has_no_row_problems():
    rows = validate_rows(json.loads(PRICE_FILE.read_text()))

    assert find_row_problems(rows) == []
