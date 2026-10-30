---
name: setup
description: Install the spend status line into ~/.claude and point the statusLine setting at it. Use when the user runs /spend-statusline:setup or asks to set up or update the spend status line.
---

Install the spend status line from this plugin.

1. The script is `statusline-cost.py` in the plugin root, two directories above this skill's base directory. If it isn't there, say so and stop.
2. Read `~/.claude/settings.json` (treat a missing file as `{}`).
3. If `statusLine` is already set and its command isn't `~/.claude/statusline-cost.py`, show the current value and ask before replacing it.
4. Back up `~/.claude/settings.json` to `~/.claude/settings.json.bak-<timestamp>` if it exists.
5. Ask (AskUserQuestion) which segments to show: two `multiSelect` questions in one call (options are capped at 4), `session`/`today`/`week` and `month`/`avg`/`proj`; the union is `segments`, and no picks means all six (the default). Ask the monthly budget in USD (default 1000). Read `~/.claude/spend_statusline.json` (missing = `{}`), set `segments` and `monthly_budget`, keep every other key, and write it back. Skip writing if the answers equal the defaults and the file does not exist.
6. Copy the script to `~/.claude/statusline-cost.py` and `chmod +x` it. The plugin folder is versioned and moves on update, so the status line must point at this stable copy.
7. Set `"statusLine": {"type": "command", "command": "~/.claude/statusline-cost.py", "padding": 0}`, keeping every other key.
8. Tell the user:
   - It takes effect on the next status line refresh.
   - The first refresh scans past transcripts to backfill totals; set `CLAUDE_SPEND_BACKFILL=0` before that to skip it.
   - Segments and budget live in `~/.claude/spend_statusline.json`; `CLAUDE_MONTHLY_BUDGET` overrides the budget.
   - Costs are list-price estimates, not billing.
   - Re-run this skill after a plugin update to refresh the copy.
