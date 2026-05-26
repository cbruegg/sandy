#!/usr/bin/env python3
"""
Sandy-MemPalace helper script — search and add-drawer operations via the MemPalace Python API.

Usage:
  python3 mempalace-helper.py search --palace <path> --query "..." --wing <wing> [--room <room>] [--results 5]
  python3 mempalace-helper.py add --palace <path> --wing <wing> --room <room> --content "..."

Output:
  All operations write a JSON object to stdout. Errors produce {"error": "...", "hint": "..."}
  and exit with code 1.
"""

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone

try:
    from mempalace.searcher import search_memories
    from mempalace.palace import get_collection
    from mempalace.config import sanitize_name, sanitize_content
except ImportError as e:
    print(
        json.dumps(
            {
                "error": f"MemPalace import failed: {e}",
                "hint": "Install mempalace: pip install mempalace",
            }
        ),
        file=sys.stderr,
    )
    sys.exit(1)


def _validate_room(value: str) -> str:
    """Validate and sanitize a room name. More permissive than MemPalace's
    sanitize_name because we use room names like 'user_message', 'reply',
    'task_summary' which contain underscores."""
    if not isinstance(value, str) or not value.strip():
        raise ValueError("room must be a non-empty string")
    value = value.strip()
    if len(value) > 128:
        raise ValueError("room exceeds maximum length")
    if ".." in value or "/" in value or "\\" in value:
        raise ValueError("room contains invalid path characters")
    if "\x00" in value:
        raise ValueError("room contains null bytes")
    return value


def cmd_search(args):
    """Search the palace by wing and optional room filter."""
    result = search_memories(
        query=args.query,
        palace_path=args.palace,
        wing=args.wing or None,
        room=args.room or None,
        n_results=args.results,
    )

    if "error" in result:
        print(json.dumps(result))
        sys.exit(1)

    # Return only the fields Sandy needs so the JSON stays compact.
    compact = {
        "query": result.get("query", args.query),
        "results": [
            {
                "text": r.get("text", ""),
                "wing": r.get("wing", "unknown"),
                "room": r.get("room", "unknown"),
                "similarity": r.get("similarity"),
                "source_file": r.get("source_file", ""),
                "created_at": r.get("created_at", ""),
            }
            for r in result.get("results", [])
        ],
    }
    print(json.dumps(compact))


def cmd_add(args):
    """Add a single drawer to the palace. Idempotent: duplicate content is
    silently skipped based on a deterministic drawer ID."""
    try:
        wing = sanitize_name(args.wing, "wing")
        room = _validate_room(args.room)
        content = sanitize_content(args.content)
    except ValueError as e:
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)

    try:
        col = get_collection(args.palace, create=True)
    except Exception as e:
        print(json.dumps({"success": False, "error": f"Palace open failed: {e}"}))
        sys.exit(1)

    # Deterministic drawer ID so re-filing identical content is idempotent.
    id_source = f"{wing}\x00{room}\x00{content}"
    drawer_id = (
        f"drawer_{wing}_{room}_"
        f"{hashlib.sha256(id_source.encode('utf-8')).hexdigest()[:24]}"
    )

    # Prohibit a duplicate write so the palace does not accumulate redundant
    # embedding work. ChromaDB get on a massive collection is cheap.
    try:
        existing = col.get(ids=[drawer_id], include=[])
        if existing.ids:
            print(
                json.dumps(
                    {
                        "success": True,
                        "reason": "already_exists",
                        "drawer_id": drawer_id,
                        "wing": wing,
                        "room": room,
                    }
                )
            )
            return
    except Exception:
        # Best-effort duplicate check; on failure, proceed to upsert.
        pass

    meta = {
        "wing": wing,
        "room": room,
        "source_file": args.source_file or "sandy",
        "added_by": "sandy",
        "filed_at": datetime.now(timezone.utc).isoformat(),
    }

    try:
        col.upsert(ids=[drawer_id], documents=[content], metadatas=[meta])
    except Exception as e:
        print(json.dumps({"success": False, "error": f"Upsert failed: {e}"}))
        sys.exit(1)

    print(
        json.dumps(
            {
                "success": True,
                "drawer_id": drawer_id,
                "wing": wing,
                "room": room,
            }
        )
    )


def main():
    parser = argparse.ArgumentParser(description="Sandy-MemPalace helper")
    subparsers = parser.add_subparsers(dest="command", required=True)

    search_parser = subparsers.add_parser("search", help="Search the palace")
    search_parser.add_argument("--palace", required=True, help="Path to palace directory")
    search_parser.add_argument("--query", required=True, help="Search query text")
    search_parser.add_argument("--wing", default=None, help="Wing filter")
    search_parser.add_argument("--room", default=None, help="Room filter")
    search_parser.add_argument(
        "--results", type=int, default=5, help="Max results (default: 5)"
    )

    add_parser = subparsers.add_parser("add", help="Add a drawer to the palace")
    add_parser.add_argument("--palace", required=True, help="Path to palace directory")
    add_parser.add_argument("--wing", required=True, help="Wing name")
    add_parser.add_argument("--room", required=True, help="Room name")
    add_parser.add_argument("--content", required=True, help="Verbatim content to store")
    add_parser.add_argument(
        "--source-file", default="sandy", help="Source label (default: sandy)"
    )

    args = parser.parse_args()

    if args.command == "search":
        cmd_search(args)
    elif args.command == "add":
        cmd_add(args)


if __name__ == "__main__":
    main()
