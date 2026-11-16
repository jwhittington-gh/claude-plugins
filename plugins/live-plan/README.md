# live-plan

A pane beside the chat that tracks what the agent is doing, plus a queue of follow-up tasks.

- **Plan tab:** the agent's steps and sub-steps, each with an ETA (time left, or how far it has run over). Steps added mid-plan are marked `+`.
- **Shells tab:** every Bash command, subagents' included, with elapsed time and ETA. Background shells show their output as it is written.
- **Queue tab:** follow-up tasks queued with `/queue`, and whether each waits for everything to finish or can run while background work is in flight.

## Install

```
/plugin install live-plan --marketplace jwhittington-gh/claude-plugins
```

The pane opens on session start. Close it with its **✕ Close** button or `/plan-pane close`; reopen it with `/plan-pane`.

To stop it opening, run `/plan-pane off`. That closes it and keeps it closed in later sessions; `/plan-pane on` brings it back. Or turn off **Open pane at session start** (`auto_open`) in the plugin's settings. Tracking and the queue keep working while the pane is closed.

## Commands

| Command | What it does |
|---|---|
| `/plan-pane` · `on` | Open the pane (and re-enable it) |
| `/plan-pane close` | Close the pane for now; `/plan-pane` reopens it. The pane's **✕ Close** button does the same |
| `/plan-pane off` | Close the pane and keep it closed in later sessions |
| `/queue <task>` | Queue a follow-up; the agent decides when it can run |
| `/queue --after-done <task>` | Queue it to run only once all work, background included, is finished |
| `/queue --while-waiting <task>` | Queue it to run as soon as the agent is idle, even with background work in flight |
| `/queue list` · `drop <n>` · `clear` | Show, remove one, or empty the queue |
| `/queue pause` · `resume` | Stop or restart dispatching. An interrupt (Esc) pauses the queue. |

## How it works

- **Steps** come from the agent's `TaskCreate`/`TaskUpdate`/`TodoWrite` calls. Where those are disabled, the agent uses the plugin's own `step` tool. The ETA is `metadata.eta_s`, and a sub-step's parent is `metadata.parent`.
- **Shell ETAs** come from a hint at the end of the Bash description, such as `(~90s)`. Without one, the plugin uses the median of the last 5 runs of the same command.
- **Instructions** reach the agent through the first message's context, and through the next prompt in a conversation already under way. They ask it to report steps and ETAs.
- **Queue:**
  - Tasks run one at a time, each as its own prompt, when the agent goes idle.
  - With background work in flight, only tasks classified `while_waiting` go.
  - The agent classifies each task with the `queue_classify` tool. A task you queue mid-turn is classified mid-turn. A task still unclassified when the agent goes idle gets one short turn that only classifies it.

## Limits

- Foreground shell commands show a timer and ETA while they run, and their last lines once they finish. The plugin API offers no live stream of their output.
- Step ETAs appear only when the agent provides them.
- The queue survives a plugin reload, but not a Claude Code restart.

## Develop

```
claude plugin validate plugins/live-plan
claude plugin test plugins/live-plan
```
