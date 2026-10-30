---
name: report
description: Show a detailed spend report (daily breakdown, weekly totals, by-model split, top sessions, token-type breakdown, budget projection). Use when the user runs /spend-statusline:report or asks for a detailed usage or spend report.
---

Run `python3 ~/.claude/statusline-cost.py --report` and show the output verbatim in a code block.

If the file is missing, tell the user to run `/spend-statusline:setup` first.

Then run `python3 ~/.claude/statusline-cost.py --tokens month` and show it under a "Tokens by type (month)" heading in a code block. If it reports no token data, tell the user to let the status line run once to reseed.

Then add at most three lines: the budget status, the heaviest day or session, and anything that looks off (for example a projection near the budget). Remind them the figures are estimates, not billing.
