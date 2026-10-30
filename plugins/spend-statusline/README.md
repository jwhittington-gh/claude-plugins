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

## Configuration

Settings are plugin options, edited in `/config` (Claude Code 2.1.269 or later) and stored in `~/.claude/settings.json` under `pluginConfigs`. Changes apply on the next status line refresh.

| Option | Default | Effect |
|---|---|---|
| `show_session` | on | Show the session segment |
| `show_today` | on | Show the today segment |
| `show_week` | on | Show the week segment |
| `show_month` | on | Show the month segment |
| `show_avg` | on | Show the daily average segment |
| `show_proj` | on | Show the projection segment |
| `breakdown_session` | off | Breakdown line: include session |
| `breakdown_today` | off | Breakdown line: include today |
| `breakdown_week` | off | Breakdown line: include week |
| `breakdown_month` | off | Breakdown line: include month |
| `monthly_budget` | `1000` | Budget in USD (minimum 1) |

Model name and budget status always show. The breakdown line shows when any `breakdown_*` option is on, for those periods only. List options are not editable in `/config`, hence one boolean per segment. Missing or malformed settings fall back to defaults.

### Environment and files

| Setting | Default | Effect |
|---|---|---|
| `CLAUDE_MONTHLY_BUDGET` | none | Budget in USD; overrides `monthly_budget` |
| `CLAUDE_SPEND_BACKFILL` | `1` | `0` skips the first-run backfill |
| `CLAUDE_SPEND_FILE` | `~/.claude/monthly_spend.json` | State file |
| `~/.claude/spend_prices.json` | none | Price overrides, e.g. `{"claude-opus-5-5": [4, 20, 0.2]}` as `[input, output, cache_read]` per MTok |

### Resetting

- Options: clear the values in `/config`, or remove the plugin's entry from `pluginConfigs` in `settings.json`; defaults apply.
- Totals: delete the state file (`~/.claude/monthly_spend.json` or `CLAUDE_SPEND_FILE`); totals are rebuilt from transcripts on the next refresh unless `CLAUDE_SPEND_BACKFILL=0`.

### Breakdown

Enable it by turning on one or more `breakdown_*` options in `/config`. A second line then shows, per period:

`session main $40.10 (cold $6.20) · agents $12.00 │ today main ... │ wk main ... │ Oct main ...`

| Category | Meaning |
|---|---|
| main | Everything except subagents |
| cold | Subset of main: cache-write cost of requests that followed an idle gap longer than the cache TTL (5 min, or 1 h when the request wrote 1 h cache). Cache rewrites after idle. |
| agents | Records under `<session>/subagents/` |

The session segment also shows `cold Nm ≈$X` while the session has been idle past the TTL: the estimated cost of rewriting the context on the next prompt.

Totals come from transcripts alone and are kept in the state file, updated incrementally. The first run after updating reseeds the state once. Category totals are token-based estimates and can differ slightly from the `session`/`today`/`wk`/month figures, which use Claude Code's own session cost where available.

Per-type token and USD totals (`--tokens`, no config key) are documented under [Tokens by type](#tokens-by-type). Resetting the state file also clears them until reseeded.

## Caveats

- **First run reads every transcript** under `~/.claude/projects` to backfill past days. It runs once, so the first refresh can be slow. Skip it with `CLAUDE_SPEND_BACKFILL=0`.
- **Backfilled costs are estimates.** They come from token usage and a built-in price table. On the sessions checked they ran 0–8% above Claude Code's own costs. The Opus 5 cache-read price is an assumption.
- **Not billing.** Only Claude Code usage with transcripts on this machine is counted. Compare with the Anthropic Console for real spend.
- **Update prices** with `spend_prices.json` when model prices change.
- macOS and Linux only (uses `fcntl`).
