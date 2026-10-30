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

Settings are plugin options, edited in `/config` (Claude Code 2.1.271 or later; older versions cannot load the `breakdown_split` option) and stored in `~/.claude/settings.json` under `pluginConfigs`. Changes apply on the next status line refresh.

| Option | Default | Effect |
|---|---|---|
| `show_session` | on | Show the session segment |
| `show_today` | on | Show the today segment |
| `show_week` | on | Show the week segment |
| `show_month` | on | Show the month segment |
| `show_avg` | on | Show the daily average segment |
| `show_proj` | on | Show the projection segment |
| `breakdown` | off | Print the cost breakdown table below the status line |
| `breakdown_split` | `combined` | `combined`, or `main/agents` for separate rows |
| `breakdown_session` | off | Table row: session |
| `breakdown_today` | on | Table row: today |
| `breakdown_week` | off | Table row: week |
| `breakdown_month` | on | Table row: month |
| `monthly_budget` | `1000` | Budget in USD (minimum 1) |

Model name and budget status always show. The table shows when `breakdown` is on and at least one period is selected. List options are not editable in `/config`, hence one boolean per segment. Missing or malformed settings fall back to defaults.

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

Turn on `breakdown` in `/config` to print a table below the status line: estimated spend by token type for each selected period. `cache wr` combines 5-minute and 1-hour cache writes.

`combined`:

```
       input   output  cache rd  cache wr     total
today  $0.01    $8.56    $15.20    $16.97    $40.74
month  $0.62  $261.15   $404.13   $871.54  $1537.44
```

`main/agents`:

```
          input   output  cache rd  cache wr     total
today
  main    $0.00    $5.20    $11.22    $12.25    $28.68
  agents  $0.00    $3.36     $3.97     $4.73    $12.06
month
  main    $0.52  $219.63   $295.68   $706.13  $1221.96
  agents  $0.10   $41.51   $108.45   $165.41   $315.48
```

Example with `breakdown_split` = `main/agents` and only the session period selected:

```text
            input  output  cache rd  cache wr  total
  session
  main    $0.00   $0.02     $0.02     $0.21  $0.25
  agents  $0.00   $0.00     $0.00     $0.00  $0.00
```

`agents` is spend recorded under `<session>/subagents/`; `main` is everything else. Totals come from transcripts alone and are kept in the state file, updated incrementally. The first run after updating reseeds the state once. Table totals are token-based estimates and can differ slightly from the `session`/`today`/`wk`/month segments, which use Claude Code's own session cost where available.

`--tokens` reads the same stored totals; see [Tokens by type](#tokens-by-type).

## Caveats

- **First run reads every transcript** under `~/.claude/projects` to backfill past days. It runs once, so the first refresh can be slow. Skip it with `CLAUDE_SPEND_BACKFILL=0`.
- **Backfilled costs are estimates.** They come from token usage and a built-in price table. On the sessions checked they ran 0–8% above Claude Code's own costs. The Opus 5 cache-read price is an assumption.
- **Not billing.** Only Claude Code usage with transcripts on this machine is counted. Compare with the Anthropic Console for real spend.
- **Update prices** with `spend_prices.json` when model prices change.
- macOS and Linux only (uses `fcntl`).
