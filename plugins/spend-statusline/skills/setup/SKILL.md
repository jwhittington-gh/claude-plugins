---
name: setup
description: Install the spend status line into ~/.claude and point the statusLine setting at it. Use when the user runs /spend-statusline:setup or asks to set up or update the spend status line.
---

Install the spend status line from this plugin.

1. The script is `statusline-cost.py` in the plugin root, two directories above this skill's base directory. If it isn't there, say so and stop.
2. Read `~/.claude/settings.json` (treat a missing file as `{}`).
3. If `statusLine` is already set and its command isn't `~/.claude/statusline-cost.py`, show the current value and ask before replacing it.
4. Back up `~/.claude/settings.json` to `~/.claude/settings.json.bak-<timestamp>` if it exists.
5. Copy the script to `~/.claude/statusline-cost.py` and `chmod +x` it. The plugin folder is versioned and moves on update, so the status line must point at this stable copy.
6. Set `"statusLine": {"type": "command", "command": "~/.claude/statusline-cost.py", "padding": 0}`, keeping every other key.
7. Tell the user:
   - It takes effect on the next status line refresh.
   - The first refresh scans past transcripts to backfill totals; set `CLAUDE_SPEND_BACKFILL=0` before that to skip it.
   - `CLAUDE_MONTHLY_BUDGET` sets the budget (default 1000).
   - Costs are list-price estimates, not billing.
   - Re-run this skill after a plugin update to refresh the copy.

Finally, tell the user that `/spend-config` edits the status line settings (segments, monthly budget) in a pane (requires mods to be enabled), and that the settings live in `~/.claude/spend_statusline.json`.
