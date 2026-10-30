#!/usr/bin/env python3
"""Claude Code status line: model, session/day/week/month cost, average, budget projection.

Run with --report for a detailed breakdown.
Env: CLAUDE_MONTHLY_BUDGET (default 1000), CLAUDE_SPEND_BACKFILL=0 to skip the
one-time transcript backfill, CLAUDE_SPEND_FILE to move the state file.
Options (show_* and breakdown* settings, monthly_budget) come from the plugin's userConfig, edited in
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
PERIODS = ("session", "today", "week", "month")
SPLITS = ("combined", "main/agents")
PLUGIN = "spend-statusline"


class Config:
    """Plugin options from settings.json pluginConfigs, read once; read-only accessors."""

    # Mirrors plugin.json userConfig defaults.
    DEFAULTS = {
        **{f"show_{k}": True for k in SEGMENTS},
        "breakdown": False,
        "breakdown_split": "combined",
        "breakdown_session": False,
        "breakdown_today": True,
        "breakdown_week": False,
        "breakdown_month": True,
        "monthly_budget": 1000,
    }

    def __init__(self, options=None):
        self._opts = dict(self.DEFAULTS)
        self._opts.update(options or {})
        self._env_budget = os.environ.get("CLAUDE_MONTHLY_BUDGET")

    @classmethod
    def load(cls):
        """Defaults on any missing or malformed settings."""
        opts = {}
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
                    for k, default in cls.DEFAULTS.items():
                        v = got.get(k)
                        if isinstance(default, bool):
                            if isinstance(v, bool):
                                opts[k] = v
                        elif isinstance(default, str):
                            if v in SPLITS:
                                opts[k] = v
                        elif isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0:
                            opts[k] = v
                    break
        except Exception:
            opts = {}
        return cls(opts)

    @property
    def segments(self):
        """Shown segment names, in display order."""
        return [k for k in SEGMENTS if self._opts[f"show_{k}"]]

    def shows(self, name):
        return self._opts.get(f"show_{name}", False)

    @property
    def breakdown_enabled(self):
        return self._opts["breakdown"]

    @property
    def breakdown_split(self):
        """"combined" or "main/agents"."""
        return self._opts["breakdown_split"]

    @property
    def breakdown_periods(self):
        """Periods shown in the breakdown table, in display order."""
        return [p for p in PERIODS if self._opts[f"breakdown_{p}"]]

    @property
    def budget_overridden(self):
        return bool(self._env_budget)

    @property
    def monthly_budget(self):
        """Budget in USD; CLAUDE_MONTHLY_BUDGET wins over the option."""
        try:
            return float(self._env_budget or self._opts["monthly_budget"])
        except (TypeError, ValueError):
            return float(self._opts["monthly_budget"])


CONFIG = Config.load()


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
SEED_VERSION = "transcripts-v5"

try:  # optional overrides: {"claude-opus-5-5": [input, output, cache_read], ...}
    with open(PRICES_FILE) as f:
        PRICES.update({k: tuple(v) for k, v in json.load(f).items()})
except (OSError, ValueError, TypeError):
    pass


def price_for(model):
    return next(
        (v for k, v in sorted(PRICES.items(), key=lambda kv: -len(kv[0])) if (model or "").startswith(k)),
        None,
    )


def cache_writes(u):
    """(5m, 1h) cache-write tokens of a usage block."""
    cc = u.get("cache_creation") or {}
    w5 = cc.get("ephemeral_5m_input_tokens")
    if w5 is None:
        w5 = u.get("cache_creation_input_tokens", 0)
    return (w5 or 0), (cc.get("ephemeral_1h_input_tokens") or 0)


def message_cost(msg):
    """Estimated USD for one assistant message from its usage block."""
    price = price_for(msg.get("model"))
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


def read_lines(path, off=0):
    """Complete lines after byte offset `off`: (lines, new offset)."""
    with open(path, "rb") as f:
        f.seek(off)
        data = f.read()
    end = data.rfind(b"\n") + 1
    return data[:end].decode("utf-8", "replace").splitlines(), off + end


def new_cats():
    return {"days": {}, "sessions": {}}


def new_session_cats():
    return {"files": {}}


TOKEN_TYPES = ("input", "output", "cache read", "cache write 5m", "cache write 1h")


def token_parts(msg):
    """([tokens], [USD]) per TOKEN_TYPES for one message."""
    u = msg.get("usage") or {}
    w5, w1 = cache_writes(u)
    toks = [u.get("input_tokens") or 0, u.get("output_tokens") or 0, u.get("cache_read_input_tokens") or 0, w5, w1]
    price = price_for(msg.get("model"))
    if not price:
        return toks, [0.0] * 5
    inp, out, read = price
    rates = (inp, out, read, inp * 1.25, inp * 2.0)
    mult = 2 if u.get("speed") == "fast" else 1
    return toks, [t * r * mult / 1e6 for t, r in zip(toks, rates)]


def tally_tokens(cats, sid, day, kind, msg):
    """Add per-type tokens and USD to the day and session: slot['tk'][kind] = [5 tokens + 5 USD]."""
    toks, costs = token_parts(msg)
    for slot in (
        cats["days"].setdefault(day, {}),
        cats["sessions"].setdefault(sid, new_session_cats()),
    ):
        acc = slot.setdefault("tk", {}).setdefault(kind, [0.0] * 10)
        for i, v in enumerate(toks + costs):
            acc[i] += v


def cat_record(cats, sid, ts, msg, is_agent):
    """Add one deduplicated record to the main/agent per-type totals."""
    day = datetime.fromtimestamp(ts).strftime("%Y-%m-%d")
    tally_tokens(cats, sid, day, "agent" if is_agent else "main", msg)


def parse_record(line):
    """(message, message id, epoch ts) for an assistant record, else None."""
    try:
        e = json.loads(line)
        if e.get("type") != "assistant":
            return None
        msg = e["message"]
        key = msg.get("id") or e.get("uuid")
        ts = datetime.fromisoformat(e["timestamp"].replace("Z", "+00:00")).timestamp()
    except (ValueError, KeyError, AttributeError, TypeError):
        return None
    return msg, key, ts


def scan_transcripts(by_model=None, cats=None):
    """{session_id: {local_day: [message_count, estimated_cost]}} across all transcripts.

    With `cats`, also fills per-type token and cost totals and per-file offsets.
    """
    root = os.path.expanduser("~/.claude/projects")
    files = glob.glob(f"{root}/*/*.jsonl") + glob.glob(f"{root}/*/*/subagents/*.jsonl")
    files.sort(key=lambda f: os.stat(f).st_birthtime if hasattr(os.stat(f), "st_birthtime") else os.stat(f).st_mtime)
    seen_ids, out = set(), {}
    for path in files:
        parts = path.split("/")
        is_agent = len(parts) != len(root.split("/")) + 2
        sid = parts[-3] if is_agent else parts[-1][:-6]
        rel = "agents/" + parts[-1] if is_agent else "main"
        fs, last = {}, None
        try:
            lines, end = read_lines(path)
        except OSError:
            continue
        for line in lines:
            rec = parse_record(line)
            if not rec:
                continue
            msg, key, ts_epoch = rec
            if key in seen_ids:
                continue
            seen_ids.add(key)
            last = key
            day = datetime.fromtimestamp(ts_epoch).strftime("%Y-%m-%d")
            slot = out.setdefault(sid, {}).setdefault(day, [0, 0.0])
            cost = message_cost(msg)
            slot[0] += 1
            slot[1] += cost
            if by_model is not None:
                k = (day, msg.get("model") or "unknown")
                by_model[k] = by_model.get(k, 0.0) + cost
            if cats is not None and not str(msg.get("model") or "").startswith("<"):
                cats["sessions"].setdefault(sid, new_session_cats())
                cat_record(cats, sid, ts_epoch, msg, is_agent)
        if cats is not None:
            fs.update(off=end, id=last)
            cats["sessions"].setdefault(sid, new_session_cats())["files"][rel] = fs
    return out


def update_cats(state, sid, transcript_path):
    """Fold new bytes of this session's transcripts into state['cats'] (no full rescan)."""
    cats = state.setdefault("cats", new_cats())
    sess = cats["sessions"].setdefault(sid, new_session_cats())
    base = transcript_path[:-6] if transcript_path.endswith(".jsonl") else transcript_path
    files = [("main", transcript_path, False)] + [
        ("agents/" + os.path.basename(p), p, True)
        for p in sorted(glob.glob(f"{base}/subagents/*.jsonl"))
    ]
    for rel, path, is_agent in files:
        fs = sess["files"].setdefault(rel, {})
        try:
            if os.path.getsize(path) < fs.get("off", 0):
                fs.clear()  # truncated or replaced: restart this file
            lines, end = read_lines(path, fs.get("off", 0))
        except OSError:
            continue
        seen = set()
        for line in lines:
            rec = parse_record(line)
            if not rec:
                continue
            msg, key, ts = rec
            if key in seen or key == fs.get("id"):
                continue
            seen.add(key)
            fs["id"] = key
            if not str(msg.get("model") or "").startswith("<"):
                cat_record(cats, sid, ts, msg, is_agent)
        fs["off"] = end


def seed_days(state, now):
    """One-time rebuild of daily/monthly totals from all transcripts.

    Tracked sessions: saved cost split by message count per day.
    Untracked sessions: estimated from token usage, then recorded as baselines.
    """
    cats = new_cats()
    scanned = scan_transcripts(cats=cats)
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
    cats["sessions"] = {k: v for k, v in cats["sessions"].items() if k in sessions}
    state["cats"] = cats


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
        f.write(json.dumps(state))
    os.replace(tmp, SPEND_FILE)


def week_total(days, today):
    monday = (today - timedelta(days=today.weekday())).strftime("%Y-%m-%d")
    return sum(v for k, v in days.items() if k >= monday)


def update_monthly(session_id, cost, transcript_path=None):
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
        if session_id and transcript_path and os.path.isfile(transcript_path):
            try:
                update_cats(state, session_id, transcript_path)
            except Exception:
                pass
        cats = state.get("cats")
        if isinstance(cats, dict):
            cats["days"] = {k: v for k, v in cats.get("days", {}).items() if k >= cutoff}
            cats["sessions"] = {k: v for k, v in cats.get("sessions", {}).items() if k in state["sessions"]}
        write_state(state)
    return (
        float(state["days"].get(day, 0.0)),
        week_total(state["days"], today),
        state["total"],
        state,
    )


def period_tokens(state, period, arg, today):
    """({main, agent: [5 tokens + 5 USD]}, label) for a period, or None when unavailable."""
    cats = state.get("cats") or {}
    if period == "session":
        sessions = state.get("sessions") or {}
        sid = arg or max(sessions, key=lambda k: sessions[k].get("seen", 0), default=None)
        slots = [(cats.get("sessions") or {}).get(sid)]
        label = f"session {sid[:8]}" if sid else "session"
    else:
        days = cats.get("days") or {}
        if period == "today":
            keys = [today.strftime("%Y-%m-%d")]
        elif period == "week":
            keys = [k for k in days if k >= (today - timedelta(days=today.weekday())).strftime("%Y-%m-%d")]
        else:
            keys = [k for k in days if k.startswith(today.strftime("%Y-%m"))]
        slots = [days.get(k) for k in keys]
        label = period
    out = {"main": [0.0] * 10, "agent": [0.0] * 10}
    found = False
    for slot in slots:
        for kind, acc in ((slot or {}).get("tk") or {}).items():
            found = True
            for i, v in enumerate(acc):
                out[kind][i] += v
    return (out, label) if found else None


def cost_cells(acc):
    """Display costs [input, output, cache rd, cache wr (5m+1h), total] from a 10-slot accumulator."""
    c = acc[5:]
    cells = [c[0], c[1], c[2], c[3] + c[4]]
    return cells + [sum(cells)]


def breakdown_table(state, periods, split, session_id, now):
    """Cost table by token type, one row per period (two with split), or "" without data."""
    rows = []  # (label, cells or None)
    for p in periods:
        res = period_tokens(state, p, session_id if p == "session" else None, now)
        if not res or (p == "session" and not session_id):
            continue
        tk = res[0]
        if split == "main/agents":
            rows.append((p, None))
            rows.append(("  main", cost_cells(tk["main"])))
            rows.append(("  agents", cost_cells(tk["agent"])))
        else:
            rows.append((p, cost_cells([a + b for a, b in zip(tk["main"], tk["agent"])])))
    if not rows:
        return ""
    heads = ["input", "output", "cache rd", "cache wr", "total"]
    text = [[f"${v:.2f}" for v in cells] if cells else [] for _, cells in rows]
    lw = max(len(label) for label, _ in rows)
    widths = [max([len(h)] + [len(t[i]) for t in text if t]) for i, h in enumerate(heads)]
    head = " " * lw + "".join("  " + h.rjust(w) for h, w in zip(heads, widths))
    lines = [f"{DIM}{head}{RESET}"]
    for (label, _), t in zip(rows, text):
        lines.append((label.ljust(lw) + "".join("  " + v.rjust(w) for v, w in zip(t, widths))).rstrip())
    return "\n".join(lines)


def budget_warning(total, avg, proj, today):
    """Budget status text for the status line."""
    budget = CONFIG.monthly_budget
    if total >= budget:
        return "⚠ OVER BUDGET"
    if proj > budget and avg > 0:
        out = today + timedelta(days=(budget - total) / avg)
        return f"⚠ budget out ~{out.strftime('%b %d').replace(' 0', ' ')}"
    if proj > 0.8 * budget:
        return "⚠ nearing budget"
    return "✓ under budget"


def projection(total, today):
    """Average daily spend, projected month-end spend, and a color for the budget status."""
    budget = CONFIG.monthly_budget
    avg = total / today.day
    days_in_month = (today.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)
    proj = avg * days_in_month.day
    color = RED if proj > budget else YELLOW if proj > 0.8 * budget else GREEN
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
    budget = CONFIG.monthly_budget
    now = datetime.now()
    month = now.strftime("%Y-%m")
    days = {k: v for k, v in state.get("days", {}).items() if k.startswith(month)}
    total = sum(days.values())
    avg, proj, _ = projection(total, now)
    print(f"Spend report: {now.strftime('%B %Y')} (estimates, not billing)")
    print(f"Month ${total:,.2f} of ${budget:,.0f} ({100 * total / budget:.1f}%) | "
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
        sid = data.get("session_id")
        day, week, total, state = update_monthly(sid, cost, data.get("transcript_path"))
        now = datetime.now()
        avg, proj, color = projection(total, now)
        warn = budget_warning(total, avg, proj, now)
        shown = {
            "session": f"session ${cost:.4f}",
            "today": f"today ${day:.2f}",
            "week": f"wk ${week:.2f}",
            "month": f"{month_label} ${total:.2f}",
            "avg": f"avg ${avg:.2f}/d",
            "proj": f"{color}proj ${proj:.0f}/${CONFIG.monthly_budget:.0f}{RESET}",
        }
        parts = [model] + [shown[k] for k in CONFIG.segments] + [f"{color}{warn}{RESET}"]
        line = SEP.join(parts)
        if CONFIG.breakdown_enabled and CONFIG.breakdown_periods:
            try:
                table = breakdown_table(state, CONFIG.breakdown_periods, CONFIG.breakdown_split, sid, now)
                line += f"\n{table}" if table else ""
            except Exception:
                pass
        print(line)
    except Exception:
        print(
            f"{model}{SEP}session $?{SEP}today $?{SEP}wk $?{SEP}{month_label} $?"
            f"{SEP}avg $?{SEP}proj $?"
        )


if __name__ == "__main__":
    main()
