# spend-statusline

A Claude Code status line that shows spend and warns before you run out of budget:

`Opus 5.5 │ session $0.12 │ today $2.58 │ wk $8.29 │ Oct $205.58 │ avg $7.34/d │ proj $228/$1000 │ ✓ under budget`

## Install

```
/plugin install spend-statusline --marketplace jwhittington-gh/claude-plugins
```

Answer `y` to add the marketplace, choose a scope, then run:

```
/spend-statusline:setup
```

Setup copies the script to `~/.claude/statusline-cost.py` and sets `statusLine` in `~/.claude/settings.json`. It asks before replacing an existing status line and backs up your settings first. Re-run it after a plugin update.

## Detailed report

```
/spend-statusline:report
```

Prints this month's daily breakdown with bars, weekly totals, spend by model, your top sessions, and the budget projection. You can also run `python3 ~/.claude/statusline-cost.py --report` in a terminal.

## Tokens by type

```
python3 ~/.claude/statusline-cost.py --tokens [session|today|week|month]
```

Default `month`. Prints a table of tokens and USD per type (input, output, cache read, cache write 5m, cache write 1h), split into all, main and agents, plus totals and each type's share of spend. `session` uses the most recent session; `--tokens session <id>` picks another. Plain text, no ANSI unless on a TTY. Data comes from the state file, so the first status line run after updating reseeds it once. `/spend-statusline:report` includes this table.

## What the numbers mean

| Field | Meaning |
|---|---|
| session | Claude Code's own cost for this session |
| today / wk / month | Spend across all sessions on this machine. The week starts Monday. |
| avg | Month total ÷ calendar days elapsed |
| proj | avg × days in the month |
| status | green under 80% of budget, yellow `nearing budget`, red `budget out ~date` or `OVER BUDGET` |

## Config

| Setting | Default | Effect |
|---|---|---|
| `CLAUDE_MONTHLY_BUDGET` | `1000` | Budget in USD; overrides `monthly_budget` in the config file |
| `CLAUDE_SPEND_BACKFILL` | `1` | `0` skips the first-run backfill |
| `CLAUDE_SPEND_FILE` | `~/.claude/monthly_spend.json` | State file |
| `CLAUDE_SPEND_BREAKDOWN` | config | `1`/`0` forces the breakdown on/off |
| `CLAUDE_SPEND_BREAKDOWN_PERIODS` | config | Comma list of `session,today,week,month` |
| `CLAUDE_SPEND_CONFIG` | `~/.claude/spend_statusline.json` | Config file path |
| `~/.claude/spend_prices.json` | none | Price overrides, e.g. `{"claude-opus-5-5": [4, 20, 0.2]}` as `[input, output, cache_read]` per MTok |

### Config file

`/spend-statusline:setup` writes `~/.claude/spend_statusline.json`; it can also be edited by hand:

```json
{"segments": ["session", "today", "month", "proj"], "monthly_budget": 1000}
```

| Key | Default | Effect |
|---|---|---|
| `segments` | all of `session`, `today`, `week`, `month`, `avg`, `proj` | Segments to print, in fixed order. Model name and budget status always show. |
| `monthly_budget` | `1000` | Budget in USD |

| `breakdown` | `{"enabled": false, "periods": ["session", "today", "week", "month"]}` | Adds a second status line splitting spend by category |

Without the file, output is unchanged.

### Breakdown

With `breakdown.enabled`, a second line shows, per period:

`session main $40.10 (cold $6.20) · agents $12.00 │ today main ... │ wk main ... │ Oct main ...`

| Category | Meaning |
|---|---|
| main | Everything except subagents |
| cold | Subset of main: cache-write cost of requests that followed an idle gap longer than the cache TTL (5 min, or 1 h when the request wrote 1 h cache). Cache rewrites after idle. |
| agents | Records under `<session>/subagents/` |

The session segment also shows `cold Nm ≈$X` while the session has been idle past the TTL: the estimated cost of rewriting the context on the next prompt.

Totals come from transcripts alone and are kept in the state file, updated incrementally. The first run after updating reseeds the state once. Category totals are token-based estimates and can differ slightly from the `session`/`today`/`wk`/month figures, which use Claude Code's own session cost where available.

## Caveats

- **First run reads every transcript** under `~/.claude/projects` to backfill past days. It runs once, so the first refresh can be slow. Skip it with `CLAUDE_SPEND_BACKFILL=0`.
- **Backfilled costs are estimates.** They come from token usage and a built-in price table. On the sessions checked they ran 0–8% above Claude Code's own costs. The Opus 5 cache-read price is an assumption.
- **Not billing.** Only Claude Code usage with transcripts on this machine is counted. Compare with the Anthropic Console for real spend.
- **Update prices** with `spend_prices.json` when model prices change.
- macOS and Linux only (uses `fcntl`).
