#!/usr/bin/env python3
"""Claude Code status line: model, session/day/week/month cost, average, budget projection.

Run with --report for a detailed breakdown.
Env: CLAUDE_MONTHLY_BUDGET (default 1000), CLAUDE_SPEND_BACKFILL=0 to skip the
one-time transcript backfill, CLAUDE_SPEND_FILE to move the state file.
Options (show_* booleans, monthly_budget) come from the plugin's userConfig, edited in
/config and stored in settings.json pluginConfigs; env CLAUDE_MONTHLY_BUDGET wins.
Optional ~/.claude/spend_prices.json overrides PRICES. macOS/Linux only (fcntl).
"""
import copy
import fcntl
import glob
import json
import os
import sys
import tempfile
import time
from datetime import datetime, timedelta

SPEND_FILE = os.path.expanduser(
    os.environ.get("CLAUDE_SPEND_FILE", "~/.claude/monthly_spend.json")
)
PRUNE_SECONDS = 40 * 86400
SEGMENTS = ("session", "today", "week", "month", "avg", "proj")
PLUGIN = "spend-statusline"
DEFAULTS = {f"show_{k}": True for k in SEGMENTS}
DEFAULTS["monthly_budget"] = 1000


def load_options():
    """Plugin options from settings.json pluginConfigs; defaults on any problem."""
    opts = dict(DEFAULTS)
    try:
        base = "~/.claude"
        with open(os.path.join(os.path.expanduser(base), "settings.json")) as f:
            configs = json.load(f).get("pluginConfigs")
        keys = [f"{PLUGIN}@jwhittington-plugins"]
        keys += sorted(k for k in configs if k.startswith(PLUGIN + "@"))
        keys += [PLUGIN, f"{PLUGIN}@inline"]
        for key in keys:
            entry = configs.get(key)
            got = entry.get("options") if isinstance(entry, dict) else None
            if isinstance(got, dict):
                for k, default in DEFAULTS.items():
                    v = got.get(k)
                    if isinstance(default, bool):
                        if isinstance(v, bool):
                            opts[k] = v
                    elif isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0:
                        opts[k] = v
                break
    except Exception:
        pass
    return opts


OPTIONS = load_options()
try:
    BUDGET = float(os.environ.get("CLAUDE_MONTHLY_BUDGET") or OPTIONS["monthly_budget"])
except (TypeError, ValueError):
    BUDGET = float(OPTIONS["monthly_budget"])
BACKFILL = os.environ.get("CLAUDE_SPEND_BACKFILL", "1") != "0"
PRICES_FILE = os.path.expanduser("~/.claude/spend_prices.json")
RED, YELLOW, GREEN = "\033[31m", "\033[33m", "\033[32m"
DIM, RESET = "\033[2m", "\033[0m"
SEP = f" {DIM}│{RESET} "


# $/MTok (input, output, cache read). Cache writes: 1.25x input (5m), 2x (1h).
PRICES = {
    "claude-opus-5-5": (4.0, 20.0, 0.20),
    "claude-opus-5": (5.0, 25.0, 0.25),
    "claude-opus-4": (5.0, 25.0, 0.50),
    "claude-sonnet-5": (2.0, 10.0, 0.20),
    "claude-sonnet-4": (3.0, 15.0, 0.30),
    "claude-fable-5": (10.0, 50.0, 0.25),
    "claude-haiku-5": (0.10, 0.50, 0.01),
    "claude-haiku-4": (1.0, 5.0, 0.10),
}
SEED_VERSION = "transcripts-v2"

try:  # optional overrides: {"claude-opus-5-5": [input, output, cache_read], ...}
    with open(PRICES_FILE) as f:
        PRICES.update({k: tuple(v) for k, v in json.load(f).items()})
except (OSError, ValueError, TypeError):
    pass


def message_cost(msg):
    """Estimated USD for one assistant message from its usage block."""
    model = msg.get("model") or ""
    price = next(
        (v for k, v in sorted(PRICES.items(), key=lambda kv: -len(kv[0])) if model.startswith(k)),
        None,
    )
    u = msg.get("usage") or {}
    if not price:
        return 0.0
    inp, out, read = price
    cc = u.get("cache_creation") or {}
    w5 = cc.get("ephemeral_5m_input_tokens")
    w1 = cc.get("ephemeral_1h_input_tokens", 0)
    if w5 is None:
        w5 = u.get("cache_creation_input_tokens", 0)
    tokens = (
        (u.get("input_tokens") or 0) * inp
        + (u.get("output_tokens") or 0) * out
        + (u.get("cache_read_input_tokens") or 0) * read
        + (w5 or 0) * inp * 1.25
        + (w1 or 0) * inp * 2.0
    )
    cost = tokens / 1e6
    return cost * 2 if u.get("speed") == "fast" else cost


def scan_transcripts(by_model=None):
    """{session_id: {local_day: [message_count, estimated_cost]}} across all transcripts."""
    root = os.path.expanduser("~/.claude/projects")
    files = glob.glob(f"{root}/*/*.jsonl") + glob.glob(f"{root}/*/*/subagents/*.jsonl")
    files.sort(key=lambda f: os.stat(f).st_birthtime if hasattr(os.stat(f), "st_birthtime") else os.stat(f).st_mtime)
    seen_ids, out = set(), {}
    for path in files:
        parts = path.split("/")
        sid = parts[-1][:-6] if len(parts) == len(root.split("/")) + 2 else parts[-3]
        try:
            with open(path) as f:
                for line in f:
                    try:
                        e = json.loads(line)
                        if e.get("type") != "assistant":
                            continue
                        msg = e["message"]
                        key = msg.get("id") or e.get("uuid")
                        if key in seen_ids:
                            continue
                        seen_ids.add(key)
                        ts = datetime.fromisoformat(e["timestamp"].replace("Z", "+00:00"))
                    except (ValueError, KeyError, AttributeError, TypeError):
                        continue
                    day = ts.astimezone().strftime("%Y-%m-%d")
                    slot = out.setdefault(sid, {}).setdefault(day, [0, 0.0])
                    cost = message_cost(msg)
                    slot[0] += 1
                    slot[1] += cost
                    if by_model is not None:
                        k = (day, msg.get("model") or "unknown")
                        by_model[k] = by_model.get(k, 0.0) + cost
        except OSError:
            pass
    return out


def seed_days(state, now):
    """One-time rebuild of daily/monthly totals from all transcripts.

    Tracked sessions: saved cost split by message count per day.
    Untracked sessions: estimated from token usage, then recorded as baselines.
    """
    scanned = scan_transcripts()
    sessions = state["sessions"]
    days = {}
    for sid, by_day in scanned.items():
        if sid in sessions:
            cost = float(sessions[sid].get("cost", 0.0))
            n_total = sum(n for n, _ in by_day.values())
            for day, (n, _) in by_day.items():
                days[day] = days.get(day, 0.0) + cost * n / n_total
        else:
            for day, (_, est) in by_day.items():
                days[day] = days.get(day, 0.0) + est
            last = max(by_day)
            sessions[sid] = {
                "cost": sum(est for _, est in by_day.values()),
                "seen": datetime.strptime(last, "%Y-%m-%d").timestamp() + 43200,
            }
    for sid, v in sessions.items():
        if sid not in scanned:
            day = datetime.fromtimestamp(v.get("seen", 0)).strftime("%Y-%m-%d")
            days[day] = days.get(day, 0.0) + float(v.get("cost", 0.0))
    month = datetime.fromtimestamp(now).strftime("%Y-%m")
    state["days"] = days
    state["total"] = sum(v for k, v in days.items() if k.startswith(month))
    state["month"] = month
    state["seeded"] = SEED_VERSION


def load_state(month):
    try:
        with open(SPEND_FILE) as f:
            state = json.load(f)
        if not isinstance(state.get("sessions"), dict):
            raise ValueError("bad state")
    except (OSError, ValueError):
        state = {"month": month, "total": 0.0, "sessions": {}}
    if not isinstance(state.get("days"), dict):
        state["days"] = {}
    if BACKFILL and state.get("seeded") != SEED_VERSION:
        trial = copy.deepcopy(state)
        try:
            seed_days(trial, time.time())
            state = trial
        except Exception:
            pass
    if state.get("month") != month:
        # Keep session baselines so cross-month sessions only add new spend.
        state["month"], state["total"] = month, 0.0
    return state


def write_state(state):
    d = os.path.dirname(SPEND_FILE)
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".monthly_spend.")
    with os.fdopen(fd, "w") as f:
        json.dump(state, f)
    os.replace(tmp, SPEND_FILE)


def week_total(days, today):
    monday = (today - timedelta(days=today.weekday())).strftime("%Y-%m-%d")
    return sum(v for k, v in days.items() if k >= monday)


def update_monthly(session_id, cost):
    now = time.time()
    today = datetime.now()
    month = today.strftime("%Y-%m")
    day = today.strftime("%Y-%m-%d")
    with open(SPEND_FILE + ".lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        state = load_state(month)
        sessions = state["sessions"]
        if session_id:
            last = float(sessions.get(session_id, {}).get("cost", 0.0))
            delta = cost if cost < last else cost - last
            if delta > 0:
                state["total"] = float(state.get("total", 0.0)) + delta
                state["days"][day] = float(state["days"].get(day, 0.0)) + delta
            sessions[session_id] = {"cost": cost, "seen": now}
        state["sessions"] = {
            k: v for k, v in sessions.items() if now - v.get("seen", 0) < PRUNE_SECONDS
        }
        cutoff = (today - timedelta(days=40)).strftime("%Y-%m-%d")
        state["days"] = {k: v for k, v in state["days"].items() if k >= cutoff}
        write_state(state)
    return (
        float(state["days"].get(day, 0.0)),
        week_total(state["days"], today),
        state["total"],
    )


def budget_warning(total, avg, proj, today):
    """Budget status text for the status line."""
    if total >= BUDGET:
        return "⚠ OVER BUDGET"
    if proj > BUDGET and avg > 0:
        out = today + timedelta(days=(BUDGET - total) / avg)
        return f"⚠ budget out ~{out.strftime('%b %d').replace(' 0', ' ')}"
    if proj > 0.8 * BUDGET:
        return "⚠ nearing budget"
    return "✓ under budget"


def projection(total, today):
    """Average daily spend, projected month-end spend, and a color for the budget status."""
    avg = total / today.day
    days_in_month = (today.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)
    proj = avg * days_in_month.day
    color = RED if proj > BUDGET else YELLOW if proj > 0.8 * BUDGET else GREEN
    return avg, proj, color


def bar(value, peak, width=24):
    return "█" * round(width * value / peak) if peak > 0 else ""


def report():
    """Detailed spend report for the current month, printed as plain text."""
    try:
        with open(SPEND_FILE) as f:
            state = json.load(f)
    except (OSError, ValueError):
        print("No spend data yet. Use Claude Code for a bit, then run this again.")
        return
    now = datetime.now()
    month = now.strftime("%Y-%m")
    days = {k: v for k, v in state.get("days", {}).items() if k.startswith(month)}
    total = sum(days.values())
    avg, proj, _ = projection(total, now)
    print(f"Spend report: {now.strftime('%B %Y')} (estimates, not billing)")
    print(f"Month ${total:,.2f} of ${BUDGET:,.0f} ({100 * total / BUDGET:.1f}%) | "
          f"avg ${avg:,.2f}/day | projected ${proj:,.0f} | {budget_warning(total, avg, proj, now)}")
    if total:
        print("\nDaily")
        peak = max(days.values())
        for day in sorted(days):
            d = datetime.strptime(day, "%Y-%m-%d")
            print(f"  {d.strftime('%b %d %a')}  ${days[day]:>8,.2f}  {bar(days[day], peak)}")
        busiest = max(days, key=days.get)
        idle = now.day - len(days)
        print(f"  busiest {busiest} (${days[busiest]:,.2f}); {len(days)} active days, {idle} with no usage")

    weeks = {}
    for day, v in state.get("days", {}).items():
        d = datetime.strptime(day, "%Y-%m-%d")
        monday = (d - timedelta(days=d.weekday())).strftime("%Y-%m-%d")
        weeks[monday] = weeks.get(monday, 0.0) + v
    if weeks:
        print("\nWeeks (Monday start)")
        for monday in sorted(weeks)[-6:]:
            print(f"  {monday}  ${weeks[monday]:>8,.2f}")

    by_model = {}
    scan_transcripts(by_model)
    models = {}
    for (day, model), c in by_model.items():
        if day.startswith(month):
            models[model] = models.get(model, 0.0) + c
    models.pop("<synthetic>", None)
    if models:
        mtotal = sum(models.values()) or 1
        print("\nBy model (this month, from transcripts)")
        for model, c in sorted(models.items(), key=lambda kv: -kv[1]):
            print(f"  {model:<22} ${c:>8,.2f}  {100 * c / mtotal:4.1f}%")

    sessions = state.get("sessions", {})
    top = sorted(sessions.items(), key=lambda kv: -float(kv[1].get("cost", 0)))[:5]
    if top:
        print("\nTop sessions (lifetime cost of each, last seen)")
        for sid, v in top:
            seen = datetime.fromtimestamp(v.get("seen", 0)).strftime("%b %d")
            print(f"  {sid[:8]}  ${float(v.get('cost', 0)):>8,.2f}  {seen}")


def main():
    if "--report" in sys.argv:
        report()
        return
    month_label = datetime.now().strftime("%b")
    model = "Claude"
    try:
        data = json.load(sys.stdin)
        model = (data.get("model") or {}).get("display_name") or model
        cost = float((data.get("cost") or {}).get("total_cost_usd") or 0.0)
        day, week, total = update_monthly(data.get("session_id"), cost)
        now = datetime.now()
        avg, proj, color = projection(total, now)
        warn = budget_warning(total, avg, proj, now)
        shown = {
            "session": f"session ${cost:.4f}",
            "today": f"today ${day:.2f}",
            "week": f"wk ${week:.2f}",
            "month": f"{month_label} ${total:.2f}",
            "avg": f"avg ${avg:.2f}/d",
            "proj": f"{color}proj ${proj:.0f}/${BUDGET:.0f}{RESET}",
        }
        parts = [model] + [shown[k] for k in SEGMENTS if OPTIONS[f"show_{k}"]] + [f"{color}{warn}{RESET}"]
        print(SEP.join(parts))
    except Exception:
        print(
            f"{model}{SEP}session $?{SEP}today $?{SEP}wk $?{SEP}{month_label} $?"
            f"{SEP}avg $?{SEP}proj $?"
        )


if __name__ == "__main__":
    main()
