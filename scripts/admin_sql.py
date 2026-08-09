#!/usr/bin/env python3
"""Generate reviewable D1 SQL for metaserver ownership administration.

This tool never connects to Cloudflare. Redirect its output to a file, review it,
and then pass that file to ``wrangler d1 execute --remote --file``.
"""

from __future__ import annotations

import argparse
import re
import sys

HEX_64 = re.compile(r"^[0-9a-f]{64}$")


def server_identity(value: object) -> str:
    if not isinstance(value, str) or HEX_64.fullmatch(value.lower()) is None:
        raise ValueError("server_id must be 64 hexadecimal characters")
    return value.lower()


def sql_string(value: object) -> str:
    if not isinstance(value, str):
        raise ValueError(f"expected a string, got {type(value).__name__}")
    if "\x00" in value:
        raise ValueError("SQL strings cannot contain NUL")
    return "'" + value.replace("'", "''") + "'"


def command_reset_owner(args: argparse.Namespace) -> str:
    server_id = server_identity(args.server_id)
    quoted = sql_string(server_id)
    return (
        "-- Destructive recovery: verify certificate-holder authorization and "
        "preserve or deliberately rotate the matching local publisher identity "
        "and sequence state before re-registering this identity.\n"
        "-- Advance each affected public profile before deleting it so a static "
        "directory rebuild cannot miss this removal. Execute the complete file "
        "with stop-on-error semantics.\n"
        "UPDATE directory_revisions SET revision = revision + 1, "
        "updated_at = unixepoch() WHERE profile = 'classic-v1' AND EXISTS ("
        "SELECT 1 FROM directory_entries WHERE profile = 'classic-v1' "
        f"AND server_id = {quoted});\n"
        "INSERT INTO directory_outbox (profile, revision, created_at) "
        "SELECT profile, revision, unixepoch() FROM directory_revisions "
        "WHERE profile = 'classic-v1' AND EXISTS (SELECT 1 FROM "
        "directory_entries WHERE profile = 'classic-v1' "
        f"AND server_id = {quoted});\n"
        "UPDATE directory_revisions SET revision = revision + 1, "
        "updated_at = unixepoch() WHERE profile = 'game-v1' AND EXISTS ("
        "SELECT 1 FROM directory_entries WHERE profile = 'game-v1' "
        f"AND server_id = {quoted});\n"
        "INSERT INTO directory_outbox (profile, revision, created_at) "
        "SELECT profile, revision, unixepoch() FROM directory_revisions "
        "WHERE profile = 'game-v1' AND EXISTS (SELECT 1 FROM "
        "directory_entries WHERE profile = 'game-v1' "
        f"AND server_id = {quoted});\n"
        f"DELETE FROM publisher_replay WHERE server_id = {quoted};\n"
        f"DELETE FROM directory_entries WHERE server_id = {quoted};\n"
        f"DELETE FROM server_presence WHERE server_id = {quoted};\n"
        f"DELETE FROM servers WHERE server_id = {quoted};\n"
        f"DELETE FROM server_owners WHERE server_id = {quoted};\n"
    )


def validate_glob(pattern: str) -> str:
    if not pattern or len(pattern) > 253 or "\x00" in pattern:
        raise ValueError("blacklist pattern must contain 1-253 characters")
    return pattern.lower()


def command_blacklist_add(args: argparse.Namespace) -> str:
    pattern = validate_glob(args.pattern)
    if len(args.reason) > 256:
        raise ValueError("blacklist reason must be at most 256 characters")
    return (
        "INSERT INTO server_blacklist (pattern, reason, created_at) "
        f"VALUES ({sql_string(pattern)}, {sql_string(args.reason)}, unixepoch()) "
        "ON CONFLICT(pattern) DO UPDATE SET "
        "reason = excluded.reason, created_at = excluded.created_at;\n"
    )


def command_blacklist_remove(args: argparse.Namespace) -> str:
    return (
        "DELETE FROM server_blacklist WHERE pattern = "
        f"{sql_string(validate_glob(args.pattern))};\n"
    )


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    commands = root.add_subparsers(dest="command", required=True)

    reset_owner = commands.add_parser(
        "reset-owner",
        help="generate SQL that removes one owner and all of its listings",
    )
    reset_owner.add_argument("server_id")
    reset_owner.set_defaults(handler=command_reset_owner)

    blacklist_add = commands.add_parser("blacklist-add")
    blacklist_add.add_argument("pattern")
    blacklist_add.add_argument("reason")
    blacklist_add.set_defaults(handler=command_blacklist_add)

    blacklist_remove = commands.add_parser("blacklist-remove")
    blacklist_remove.add_argument("pattern")
    blacklist_remove.set_defaults(handler=command_blacklist_remove)
    return root


def main() -> int:
    args = parser().parse_args()
    try:
        sys.stdout.write(args.handler(args))
    except ValueError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
