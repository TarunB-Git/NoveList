#!/usr/bin/env python
"""
search_cli.py — Command-line search tool.

Runs a standalone search without needing the FastAPI server running.
Useful for debugging, testing, and batch queries.

Usage:
    python scripts/search_cli.py "beast tamer worm evolves into dragon"
    python scripts/search_cli.py "weakest hunter shadow army" --top-k 5
    python scripts/search_cli.py --interactive
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys
import textwrap
from pathlib import Path

BACKEND_DIR = Path(__file__).parent.parent / "backend"
sys.path.insert(0, str(BACKEND_DIR))

# Suppress verbose logs from transformers / tokenizers during CLI use
logging.getLogger("sentence_transformers").setLevel(logging.WARNING)
logging.getLogger("transformers").setLevel(logging.ERROR)
logging.basicConfig(level=logging.WARNING)

from search import SearchEngine  # noqa: E402

# ANSI colour codes
C = {
    "reset": "\033[0m",
    "bold": "\033[1m",
    "dim": "\033[2m",
    "green": "\033[32m",
    "yellow": "\033[33m",
    "cyan": "\033[36m",
    "grey": "\033[90m",
    "white": "\033[97m",
}


def coloured(text: str, *codes: str) -> str:
    return "".join(C[c] for c in codes) + text + C["reset"]


def print_results(results: list[dict], rewritten: str | None) -> None:
    if rewritten:
        print(coloured("\n⟳ Expanded query:", "yellow", "bold"))
        for line in textwrap.wrap(rewritten, 80):
            print(coloured(f"  {line}", "dim"))

    if not results:
        print(coloured("\n  No strong matches found. Try different keywords.", "grey"))
        return

    print(coloured(f"\n  Found {len(results)} result(s)\n", "dim"))
    sep = coloured("─" * 72, "grey")

    for i, r in enumerate(results, 1):
        print(sep)
        print(coloured(f"  #{i}  ", "dim") + coloured(r["title"], "white", "bold"))
        print(coloured(f"       Rank score: {r['score']:.2f}", "dim"))
        print()

        if r.get("reason"):
            reason_lines = textwrap.wrap(r["reason"], 66)
            for line in reason_lines:
                print(coloured(f"       {line}", "cyan"))
            print()

        tags = ", ".join(r.get("tags", [])[:8])
        if tags:
            print(coloured(f"       Tags: {tags}", "grey"))
        print()

    print(sep)


async def run_search(engine: SearchEngine, query: str, top_k: int) -> None:
    print(coloured(f'\nSearching: "{query}"', "dim"))
    results, rewritten = await engine.search(query=query, top_k=top_k)
    print_results(results, rewritten)


def interactive_mode(engine: SearchEngine, top_k: int) -> None:
    print(coloured("Webnovel Memory Search — Interactive Mode", "green", "bold"))
    print(coloured("Type a query and press Enter.  Ctrl+C to exit.\n", "dim"))
    while True:
        try:
            query = input(coloured("Query > ", "cyan")).strip()
        except (KeyboardInterrupt, EOFError):
            print("\nGoodbye.")
            break
        if not query:
            continue
        asyncio.run(run_search(engine, query, top_k))


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Webnovel Memory Search — CLI",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=textwrap.dedent("""
        Examples:
          python scripts/search_cli.py "beast tamer worm evolves to dragon"
          python scripts/search_cli.py --interactive
          python scripts/search_cli.py "shadow army undead system" --top-k 5
        """),
    )
    parser.add_argument(
        "query", nargs="?", help="Search query (omit for interactive mode)"
    )
    parser.add_argument(
        "--top-k",
        type=int,
        default=8,
        metavar="N",
        help="Number of results (default: 8)",
    )
    parser.add_argument(
        "--interactive", "-i", action="store_true", help="Enter interactive search mode"
    )
    args = parser.parse_args()

    print(coloured("Loading search engine…", "grey"), end=" ", flush=True)
    try:
        engine = SearchEngine()
    except FileNotFoundError as e:
        print(coloured(f"\nError: {e}", "yellow"))
        sys.exit(1)
    print(coloured(f"ready ({engine.num_indexed} novels)\n", "green"))

    if args.interactive or not args.query:
        interactive_mode(engine, args.top_k)
    else:
        asyncio.run(run_search(engine, args.query, args.top_k))


if __name__ == "__main__":
    main()
