#!/usr/bin/env python3
"""Generate reviewable D1 SQL for canonical metaserver identity administration.

This tool never connects to Cloudflare. Redirect its output to a file, review it,
and then pass that file to ``wrangler d1 execute --remote --file``.
"""

from __future__ import annotations

import argparse
import re
import sys

HEX_64 = re.compile(r"^[0-9a-f]{64}$")
CLASSIC_V1_RETIREMENT_CONFIRMATION = "human-accepted-v5-canaries-and-cutover"


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


def command_reset_identity(args: argparse.Namespace) -> str:
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
        "updated_at = unixepoch() WHERE profile = 'classic-v2' AND EXISTS ("
        "SELECT 1 FROM directory_entries WHERE profile = 'classic-v2' "
        f"AND server_id = {quoted});\n"
        "INSERT INTO directory_outbox (profile, revision, created_at) "
        "SELECT profile, revision, unixepoch() FROM directory_revisions "
        "WHERE profile = 'classic-v2' AND EXISTS (SELECT 1 FROM "
        "directory_entries WHERE profile = 'classic-v2' "
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
    )


def command_deny_add(args: argparse.Namespace) -> str:
    server_id = server_identity(args.server_id)
    return (
        "INSERT INTO server_denials (server_id, created_at) "
        f"VALUES ({sql_string(server_id)}, unixepoch()) "
        "ON CONFLICT(server_id) DO UPDATE SET "
        "created_at = excluded.created_at;\n"
    )


def command_deny_remove(args: argparse.Namespace) -> str:
    return (
        "DELETE FROM server_denials WHERE server_id = "
        f"{sql_string(server_identity(args.server_id))};\n"
    )


def command_retire_classic_v1(args: argparse.Namespace) -> str:
    if args.confirm != CLASSIC_V1_RETIREMENT_CONFIRMATION:
        raise ValueError(
            "retirement requires human acceptance of the v5 production "
            "canaries and one-way alias cutover"
        )
    return (
        "-- ONE-WAY GLOBAL GATE. Run only after the documented publisher "
        "exclusion and Durable Object drain, and only after human acceptance "
        "of v5 production canaries and alias cutover. Never roll this mode back.\n"
        "BEGIN IMMEDIATE;\n"
        "UPDATE directory_revisions SET revision = revision + 1, "
        "updated_at = unixepoch() WHERE profile = 'classic-v1' AND EXISTS ("
        "SELECT 1 FROM directory_entries WHERE profile = 'classic-v1');\n"
        "INSERT INTO directory_outbox (profile, revision, created_at) "
        "SELECT profile, revision, unixepoch() FROM directory_revisions "
        "WHERE profile = 'classic-v1' AND EXISTS ("
        "SELECT 1 FROM directory_entries WHERE profile = 'classic-v1');\n"
        "UPDATE classic_receiver_mode SET mode = 'classic-v1-retired', "
        "activated_at = coalesce(activated_at, unixepoch()) "
        "WHERE singleton = 1 AND mode IN "
        "('classic-v1-accepting', 'classic-v1-retired');\n"
        "DELETE FROM server_presence WHERE profile = 'classic-v1' AND EXISTS ("
        "SELECT 1 FROM classic_receiver_mode WHERE singleton = 1 "
        "AND mode = 'classic-v1-retired');\n"
        "INSERT INTO directory_transaction_assertions (assertion) "
        "SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM classic_receiver_mode "
        "WHERE singleton = 1 AND mode = 'classic-v1-retired') OR EXISTS ("
        "SELECT 1 FROM server_presence WHERE profile = 'classic-v1') OR EXISTS ("
        "SELECT 1 FROM directory_entries WHERE profile = 'classic-v1');\n"
        "COMMIT;\n"
    )


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    commands = root.add_subparsers(dest="command", required=True)

    reset_identity = commands.add_parser(
        "reset-identity",
        help="generate SQL that removes one signed identity and all of its listings",
    )
    reset_identity.add_argument("server_id")
    reset_identity.set_defaults(handler=command_reset_identity)

    deny_add = commands.add_parser("deny-add")
    deny_add.add_argument("server_id")
    deny_add.set_defaults(handler=command_deny_add)

    deny_remove = commands.add_parser("deny-remove")
    deny_remove.add_argument("server_id")
    deny_remove.set_defaults(handler=command_deny_remove)

    retire_classic = commands.add_parser(
        "retire-classic-v1",
        help="generate the one-way durable global Classic v1 retirement gate",
    )
    retire_classic.add_argument(
        "--confirm",
        required=True,
        help=f"must equal {CLASSIC_V1_RETIREMENT_CONFIRMATION}",
    )
    retire_classic.set_defaults(handler=command_retire_classic_v1)
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
