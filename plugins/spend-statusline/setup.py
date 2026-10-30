#!/usr/bin/env python3
"""Install the spend status line into ~/.claude (used by /spend-statusline:setup).

setup.py --check
setup.py [--segments session,today] [--budget 2000] [--breakdown-periods session,today]
         [--replace-statusline]

--check prints the current statusLine setting as JSON (null if unset).
Otherwise: backs up settings.json, writes spend_statusline.json (unknown keys
kept; skipped when the answers equal the defaults and the file is absent),
copies statusline-cost.py and points statusLine at the copy. Exit 2 if a
foreign statusLine exists and --replace-statusline is not given.
Config dir: --home, else CLAUDE_CONFIG_DIR, else ~/.claude. CLAUDE_SPEND_CONFIG
overrides the config file path.
"""
import argparse
import json
import os
import shutil
import sys
import tempfile
import time

SEGMENTS = ("session", "today", "week", "month", "avg", "proj")
PERIODS = ("session", "today", "week", "month")
DEFAULT_BUDGET = 1000.0
COMMAND = "~/.claude/statusline-cost.py"
STATUS_LINE = {"type": "command", "command": COMMAND, "padding": 0}
SOURCE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "statusline-cost.py")


def fail(msg, code=1):
    print(f"setup.py: {msg}", file=sys.stderr)
    sys.exit(code)


def load_json(path):
    try:
        with open(path) as f:
            data = json.load(f)
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as e:
        fail(f"cannot read {path}: {e}")
    if not isinstance(data, dict):
        fail(f"{path} is not a JSON object")
    return data


def write_json(path, data):
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".setup-")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2)
            f.write("\n")
        if os.path.exists(path):
            shutil.copymode(path, tmp)
        else:
            os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def parse_list(value, allowed, name):
    items = [s.strip() for s in value.split(",") if s.strip()]
    bad = [s for s in items if s not in allowed]
    if bad:
        fail(f"unknown {name}: {', '.join(bad)} (allowed: {', '.join(allowed)})")
    return [s for s in allowed if s in items]


def main():
    ap = argparse.ArgumentParser(description="Install the spend status line.")
    ap.add_argument("--check", action="store_true", help="print current statusLine as JSON")
    ap.add_argument("--segments", help="comma list of: " + ",".join(SEGMENTS))
    ap.add_argument("--budget", type=float, help="monthly budget in USD")
    ap.add_argument(
        "--breakdown-periods",
        help="enable the cost breakdown for: " + ",".join(PERIODS) + " (omit or empty: disabled)",
    )
    ap.add_argument("--replace-statusline", action="store_true")
    ap.add_argument("--home", help="Claude config dir (default $CLAUDE_CONFIG_DIR or ~/.claude)")
    args = ap.parse_args()

    home = os.path.expanduser(args.home or os.environ.get("CLAUDE_CONFIG_DIR") or "~/.claude")
    settings_path = os.path.join(home, "settings.json")
    config_path = os.path.expanduser(
        os.environ.get("CLAUDE_SPEND_CONFIG") or os.path.join(home, "spend_statusline.json")
    )
    settings = load_json(settings_path)
    current = settings.get("statusLine")

    if args.check:
        print(json.dumps(current))
        return

    segments = parse_list(args.segments, SEGMENTS, "segment") if args.segments else []
    segments = segments or list(SEGMENTS)
    periods = parse_list(args.breakdown_periods, PERIODS, "period") if args.breakdown_periods else []
    budget = args.budget if args.budget and args.budget > 0 else DEFAULT_BUDGET

    foreign = current is not None and not (
        isinstance(current, dict) and current.get("command") == COMMAND
    )
    if foreign and not args.replace_statusline:
        fail(
            f"settings.json already has a different statusLine ({json.dumps(current)}); "
            "re-run with --replace-statusline to replace it",
            2,
        )
    if not os.path.isfile(SOURCE):
        fail(f"{SOURCE} not found")

    os.makedirs(home, exist_ok=True)
    if os.path.exists(settings_path):
        backup = f"{settings_path}.bak-{time.strftime('%Y%m%d-%H%M%S')}"
        shutil.copy2(settings_path, backup)
        print(f"backup: {backup}")

    changed = segments != list(SEGMENTS) or budget != DEFAULT_BUDGET or periods
    if os.path.exists(config_path) or changed:
        config = load_json(config_path)
        config["segments"] = segments
        config["monthly_budget"] = int(budget) if budget == int(budget) else budget
        breakdown = config.get("breakdown")
        breakdown = breakdown if isinstance(breakdown, dict) else {}
        if periods:
            config["breakdown"] = {**breakdown, "enabled": True, "periods": periods}
        elif "breakdown" in config:
            config["breakdown"] = {**breakdown, "enabled": False}
        os.makedirs(os.path.dirname(config_path), exist_ok=True)
        write_json(config_path, config)
        print(f"config: {config_path}")
    else:
        print("config: defaults, not written")

    dest = os.path.join(home, "statusline-cost.py")
    shutil.copyfile(SOURCE, dest)
    os.chmod(dest, 0o755)
    print(f"script: {dest}")

    settings["statusLine"] = dict(STATUS_LINE)
    write_json(settings_path, settings)
    print(f"statusLine: {settings_path}")


if __name__ == "__main__":
    main()
