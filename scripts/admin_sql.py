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
DECIMAL_TIMESTAMP = re.compile(r"^[0-9]{1,16}$")
DIRECTORY_PROFILES = {"classic-v3", "game-v2"}
MAX_DIRECTORY_TIMESTAMP = 9007199254740991
MAX_PIN_PRIORITY = 1000
MAX_PIN_NOTE_BYTES = 512
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


def directory_profile(value: object) -> str:
    if not isinstance(value, str) or value not in DIRECTORY_PROFILES:
        raise ValueError("profile must be a supported directory profile")
    return value


def pin_priority(value: object) -> int:
    if isinstance(value, bool):
        raise ValueError("priority must be a decimal integer")
    try:
        parsed = int(value)  # argparse supplies text; tests may supply integers.
    except (TypeError, ValueError):
        raise ValueError("priority must be a decimal integer") from None
    if str(value) != str(parsed) or not 0 <= parsed <= MAX_PIN_PRIORITY:
        raise ValueError("priority must be between 0 and 1000")
    return parsed


def pin_expiry(value: object) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or DECIMAL_TIMESTAMP.fullmatch(str(value)) is None:
        raise ValueError("expires_at must be a non-negative decimal timestamp")
    parsed = int(str(value))
    if parsed > MAX_DIRECTORY_TIMESTAMP:
        raise ValueError("expires_at exceeds the supported timestamp bound")
    return parsed


def pin_note(value: object) -> str:
    if not isinstance(value, str):
        raise ValueError("note must be a string")
    if "\x00" in value or any(
        ord(character) < 0x20 or ord(character) == 0x7f
        for character in value
    ):
        raise ValueError("note contains a control character")
    try:
        encoded_length = len(value.encode("utf-8"))
    except UnicodeEncodeError:
        raise ValueError("note contains an unpaired surrogate") from None
    if encoded_length > MAX_PIN_NOTE_BYTES:
        raise ValueError("note exceeds 512 UTF-8 bytes")
    return value


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
        "-- Exclude publishers and drain rendezvous rooms before execution; "
        "SQL cannot fence existing sockets. Retain revoked route tombstones "
        "and request budgets to prevent capability or budget resurrection.\n"
        "BEGIN IMMEDIATE;\n"
        "UPDATE directory_revisions SET revision = revision + 1, "
        "updated_at = unixepoch() WHERE EXISTS (SELECT 1 FROM directory_entries "
        "WHERE directory_entries.profile = directory_revisions.profile "
        f"AND server_id = {quoted});\n"
        "INSERT INTO directory_outbox (profile, revision, created_at) "
        "SELECT profile, revision, unixepoch() FROM directory_revisions "
        "WHERE EXISTS (SELECT 1 FROM directory_entries WHERE "
        "directory_entries.profile = directory_revisions.profile "
        f"AND server_id = {quoted});\n"
        f"DELETE FROM access_grants WHERE server_id = {quoted};\n"
        f"DELETE FROM access_route_receipts WHERE server_id = {quoted};\n"
        "UPDATE access_routes SET state = 'revoked', revoked_at = unixepoch() "
        f"WHERE server_id = {quoted} AND state IN ('reserved', 'active');\n"
        f"DELETE FROM publisher_replay WHERE server_id = {quoted};\n"
        f"DELETE FROM directory_entries WHERE server_id = {quoted};\n"
        f"DELETE FROM server_presence WHERE server_id = {quoted};\n"
        f"DELETE FROM directory_activity_buckets WHERE server_id = {quoted};\n"
        f"DELETE FROM directory_activity_state WHERE server_id = {quoted};\n"
        f"DELETE FROM directory_admin_pins WHERE server_id = {quoted};\n"
        "COMMIT;\n"
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


def command_pin_add(args: argparse.Namespace) -> str:
    profile = directory_profile(args.profile)
    server_id = server_identity(args.server_id)
    priority = pin_priority(args.priority)
    expires_at = pin_expiry(args.expires_at)
    note = pin_note(args.note)
    expiry_sql = "NULL" if expires_at is None else str(expires_at)
    return (
        "-- Reviewable operator policy only. A pin changes ordering for an "
        "already eligible public row; it cannot resurrect private, expired, "
        "denied, or malformed state.\n"
        "BEGIN IMMEDIATE;\n"
        "INSERT INTO directory_admin_pins "
        "(profile, server_id, priority, expires_at, note, created_at, updated_at) "
        f"VALUES ({sql_string(profile)}, {sql_string(server_id)}, {priority}, "
        f"{expiry_sql}, {sql_string(note)}, unixepoch(), unixepoch()) "
        "ON CONFLICT(profile, server_id) DO UPDATE SET "
        "priority = excluded.priority, expires_at = excluded.expires_at, "
        "note = excluded.note, updated_at = unixepoch();\n"
        "COMMIT;\n"
    )


def command_pin_remove(args: argparse.Namespace) -> str:
    return (
        "DELETE FROM directory_admin_pins WHERE profile = "
        f"{sql_string(directory_profile(args.profile))} AND server_id = "
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

    pin_add = commands.add_parser(
        "pin-add",
        help="generate reviewable SQL for one profile-scoped ordering pin",
    )
    pin_add.add_argument("profile")
    pin_add.add_argument("server_id")
    pin_add.add_argument("priority")
    pin_add.add_argument("--expires-at")
    pin_add.add_argument("--note", default="")
    pin_add.set_defaults(handler=command_pin_add)

    pin_remove = commands.add_parser(
        "pin-remove",
        help="generate SQL that removes one profile-scoped ordering pin",
    )
    pin_remove.add_argument("profile")
    pin_remove.add_argument("server_id")
    pin_remove.set_defaults(handler=command_pin_remove)

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
