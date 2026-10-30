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

## What the numbers mean

| Field | Meaning |
|---|---|
| session | Claude Code's own cost for this session |
| today / wk / month | Spend across all sessions on this machine. The week starts Monday. |
| avg | Month total ÷ calendar days elapsed |
| proj | avg × days in the month |
| status | green under 80% of budget, yellow `nearing budget`, red `budget out ~date` or `OVER BUDGET` |

## Configuration

### Environment and files

| Setting | Default | Effect |
|---|---|---|
| `CLAUDE_MONTHLY_BUDGET` | `1000` | Budget in USD; overrides `monthly_budget` in the config file |
| `CLAUDE_SPEND_BACKFILL` | `1` | `0` skips the first-run backfill |
| `CLAUDE_SPEND_FILE` | `~/.claude/monthly_spend.json` | State file |
| `CLAUDE_SPEND_CONFIG` | `~/.claude/spend_statusline.json` | Config file path |
| `~/.claude/spend_prices.json` | none | Price overrides, e.g. `{"claude-opus-5-5": [4, 20, 0.2]}` as `[input, output, cache_read]` per MTok |

### Config file

Path: `~/.claude/spend_statusline.json` (override with `CLAUDE_SPEND_CONFIG`). Written by the settings pane (`/spend-config`); can be edited by hand:

```json
{"segments": ["session", "today", "month", "proj"], "monthly_budget": 1000}
```

| Key | Default | Effect |
|---|---|---|
| `segments` | all of `session`, `today`, `week`, `month`, `avg`, `proj` | Segments to print, in fixed order. Model name and budget status always show. |
| `monthly_budget` | `1000` | Budget in USD |

Missing or invalid file: defaults. `CLAUDE_MONTHLY_BUDGET` wins over `monthly_budget`.

### Adjusting

- Pane: run `/spend-config`. Granularity (`session`, `today`, `week`, `month`), spend stats (`avg`, `proj`) and the monthly budget are on one screen; Save writes the config file (unknown keys kept, defaults omitted), Cancel discards. A malformed file shows an error and is overwritten only on Save.
- File: edit the config file.

Changes apply on the next status line refresh.

The pane is a Claude Code mod and requires mods to be enabled. The command is registered when a session starts, so start a new session after installing. It reads `CLAUDE_SPEND_CONFIG` and `HOME` from Claude Code's own environment, which should match the status line's. Not drawn on mobile. `CLAUDE_MONTHLY_BUDGET` still wins over the saved budget; the pane notes it when set.

### Resetting

- Config: delete the config file; defaults apply (all segments, budget 1000).
- Totals: delete the state file (`~/.claude/monthly_spend.json` or `CLAUDE_SPEND_FILE`); totals are rebuilt from transcripts on the next refresh unless `CLAUDE_SPEND_BACKFILL=0`.

## Caveats

- **First run reads every transcript** under `~/.claude/projects` to backfill past days. It runs once, so the first refresh can be slow. Skip it with `CLAUDE_SPEND_BACKFILL=0`.
- **Backfilled costs are estimates.** They come from token usage and a built-in price table. On the sessions checked they ran 0–8% above Claude Code's own costs. The Opus 5 cache-read price is an assumption.
- **Not billing.** Only Claude Code usage with transcripts on this machine is counted. Compare with the Anthropic Console for real spend.
- **Update prices** with `spend_prices.json` when model prices change.
- macOS and Linux only (uses `fcntl`).
