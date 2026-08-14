# Agent Monitor

A tiny, portable local dashboard for watching a fleet of **background agents**.
Point your coding agent at it and it renders a live wall of status cards — one
per agent — with streamed logs and a two-way manager chat, all served from a
single dependency-free Node script.

## What it looks like

- A **grid of cards**, each showing an agent's name, a colour-coded status
  (green = running, blue = done, red = failed/stopped), an optional git
  worktree path, the current "now" line, and a scrolling stream of the agent's
  `[HH:mm:ss]` log lines.
- Empty dashed placeholder tiles fill the rest of the viewport, so the page
  always reads as a wall of squares with real work filling in from the top-left.
- A **manager chat** bar pinned to the bottom: type to the manager session,
  paste files and clipboard screenshots (they stage as chips until you hit
  send), preview images in a modal, and clear/archive the conversation. Mixed
  right-to-left (e.g. Persian/Arabic) text is handled correctly.
- Brutalist black-on-white monospace theme, no build step, no external assets.

The whole thing is display-only: it just renders JSON/log/JSONL files on disk
that the manager session keeps up to date.

## Requirements

- **Node.js** (any recent LTS) — no npm dependencies at all.
- A browser.
- Git worktrees are **optional** — cards show a worktree path if you give them
  one, but agents don't need to run in worktrees.

## Quick start (standalone)

```bash
git clone https://github.com/<your-user>/agent-monitor.git
cd agent-monitor
npm start          # or: node scripts/server.js
```

Then open **http://127.0.0.1:4599/?g=main** in your browser.

Configuration (both optional):

| env var             | default            | purpose                                            |
|---------------------|--------------------|----------------------------------------------------|
| `PORT`              | `4599`             | server port                                        |
| `AGENT_MONITOR_DIR` | `scripts/groups/`  | where per-group runtime data (manifests, logs, chat, uploads) is stored |

Set `AGENT_MONITOR_DIR` to a folder inside your project so runtime data lives
with the project, not with the tool:

```bash
AGENT_MONITOR_DIR="/path/to/project/.agent-monitor" PORT=4599 node scripts/server.js
```

## Use as a coding-agent skill

`SKILL.md` ships with this repo so a coding agent can drive the dashboard
automatically — start the server, register agent cards, stream progress, and
run the manager chat.

### Install (recommended — one-command plugin)

The repo ships a plugin manifest, so a teammate can add it as a marketplace and
install in two lines inside Claude Code:

```text
/plugin marketplace add shahabarvin/claude-agent-monitor
/plugin install agent-monitor@agent-monitor
```

(The first `agent-monitor` is the plugin; the second is the marketplace — both
are named `agent-monitor` in this repo.) Updating later:

```text
/plugin marketplace update agent-monitor
```

### Install (manual clone)

```bash
# clone straight into the skills folder
git clone https://github.com/shahabarvin/claude-agent-monitor.git ~/.claude/skills/agent-monitor
```

or clone anywhere and copy/symlink the folder into `~/.claude/skills/`. Restart
your agent session so it picks up the new skill.

> **Note:** the dashboard runs a small Node server. The first time the skill
> launches it, the agent asks permission to run `node scripts/server.js`; approve
> it (or pre-approve in `.claude/settings.json`). Re-invoke the skill once per
> session to (re)start the server.

### Invoke it

Once installed, just tell your agent:

> **"start group work"** — or "monitor the agents", or "open the agent dashboard".

The agent will boot the server in the background, hand you a
`http://127.0.0.1:4599/?g=<group>` link, spin up its background agents, and keep
the cards and chat live while it works. Talk back to it any time from the chat
bar at the bottom of the page.

## How it works

Each session is a **group** (`?g=<name>`). Everything for a group lives under
`<AGENT_MONITOR_DIR>/<group>/`:

```
manifest.json            # the roster: [{ id, name, task, worktree, status, startedAt, endedAt }]
agents/<id>.log          # per-agent progress stream, one "[HH:mm:ss] message" line per step
chat.jsonl               # append-only two-way chat (roles: user / manager / status / typing / clear)
uploads/<stamped-file>   # files pasted or uploaded from the browser
```

The page polls `manifest.json` and each `agents/<id>.log` every 1.5s and
`chat.jsonl` every second, with no-store caching, so the browser always sees
the latest bytes. The server exposes four small write endpoints the page uses:
`POST /say`, `/clear`, `/upload`, and `/remove` (each takes `?g=<group>`).

See **`SKILL.md`** for the full manager protocol (manifest shape, log format,
chat roles, `[MGR]` management markers, and the agent name pool).

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 Shahab Avin.
