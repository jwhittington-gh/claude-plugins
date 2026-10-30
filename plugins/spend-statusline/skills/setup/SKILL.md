---
name: setup
description: Install the spend status line into ~/.claude and point the statusLine setting at it. Use when the user runs /spend-statusline:setup or asks to set up or update the spend status line.
allowed-tools: Bash(python3 ${CLAUDE_PLUGIN_ROOT}/setup.py *) AskUserQuestion
---

Install the spend status line from this plugin. All file work is done by `${CLAUDE_PLUGIN_ROOT}/setup.py`; do not read, copy, or edit files under `~/.claude` directly.

1. Run `python3 ${CLAUDE_PLUGIN_ROOT}/setup.py --check`. It prints the current `statusLine` setting as JSON (`null` if unset).
2. If it is set and its `command` isn't `~/.claude/statusline-cost.py`, show it and ask (AskUserQuestion, on its own) whether to replace it. If not, stop. If yes, pass `--replace-statusline` in step 4.
3. Ask everything else in ONE AskUserQuestion call with these questions:
   - Segments (1/2): `multiSelect`, options `session`, `today`, `week`.
   - Segments (2/2): `multiSelect`, options `month`, `avg`, `proj`.
   - Monthly budget in USD: options `500`, `1000`, `2000`; Other for a custom amount.

   The union of the two segment answers is `segments`; no picks in either means all six (the default).
4. Run once: `python3 ${CLAUDE_PLUGIN_ROOT}/setup.py --segments <comma list> --budget <usd> [--replace-statusline]`. Omit `--segments` for the default. It backs up settings, writes the config, copies the script to `~/.claude/statusline-cost.py` (the plugin folder is versioned and moves on update, so the status line must point at this stable copy), and sets `statusLine`. Exit code 2 means a foreign `statusLine` was refused; report the message.
5. Tell the user:
   - It takes effect on the next status line refresh.
   - The first refresh scans past transcripts to backfill totals; set `CLAUDE_SPEND_BACKFILL=0` before that to skip it.
   - Segments and budget live in `~/.claude/spend_statusline.json`; `CLAUDE_MONTHLY_BUDGET` overrides the budget.
   - Costs are list-price estimates, not billing.
   - Re-run this skill after a plugin update to refresh the copy.
