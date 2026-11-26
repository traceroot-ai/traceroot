"""Tracing quickstart: initialize traceroot where the application starts.

The block between the markers is synced into docs/tracing/get-started.mdx by
scripts/sync_doc_snippets.py.

Usage:
    python quickstart.py
"""
# ruff: noqa: F841

# [start:tracing-get-started-python]
from openai import OpenAI

import traceroot
from traceroot import Integration


def main():
    client = OpenAI()
    # ...your application


if __name__ == "__main__":
    # from dotenv import load_dotenv; load_dotenv()  # Uncomment if using a .env file (requires: pip install python-dotenv)
    traceroot.initialize(integrations=[Integration.OPENAI])  # instruments all OpenAI calls
    main()
# [end:tracing-get-started-python]
