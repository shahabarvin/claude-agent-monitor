# Agent Monitor

A small local dashboard for watching a fleet of background agents. Point your
coding agent at it and it renders a live wall of status cards, one per agent,
with streamed logs and a two-way manager chat. It's a single Node script with
no dependencies.

## What it looks like

- A grid of cards. Each one shows an agent's name, a colour-coded status (green
  for running, blue for done, red for failed or stopped), an optional git
  worktree path, the current "now" line, and a scrolling stream of that agent's
  `[HH:mm:ss]` log lines.
- Empty dashed tiles fill the rest of the viewport, so the page always reads as
  a wall of squares with real work filling in from the top-left.
- Draft task cards. Hit "+ new task" to define a job right in the browser: name
  it, write the task, point it at a worktree, and edit it whenever. It sits as an
  amber draft until you press Play, which signals the manager session to spawn
  the agent and turn the card into a live one. The page never runs anything
  itself, it just writes the task to disk for the manager to pick up.
- A manager chat bar pinned to the bottom. Type to the manager session, paste
  files and clipboard screenshots (they stage as chips until you hit send),
  preview images in a modal, and clear or archive the conversation. Archived
  sessions can be re-read and deleted one at a time or all at once. Mixed
  right-to-left text (Persian, Arabic) renders correctly.
- A home page. Open the server root with no `?g=` and you get a list of every
  session on this server, with agent counts and last activity, so reopening the
  browser drops you back on a menu of runs to jump into. You can also start a new
  group from there.
- A downloadable report. From any group view (or the home list) you can grab a
  Markdown or HTML report of that session: every agent's status, task, worktree,
  timing and full log, followed by the chat transcript.
- Black-on-white monospace theme. No build step, no external assets.

It's display-only. All it does is render the JSON, log, and JSONL files on disk
that the manager session keeps up to date.

## Requirements

- Node.js, any recent LTS. There are no npm dependencies.
- A browser.
- Git worktrees are optional. Cards show a worktree path if you give them one,
  but agents don't have to run in worktrees.

## Quick start (standalone)

```bash
git clone https://github.com/shahabarvin/claude-agent-monitor.git
cd claude-agent-monitor
npm start          # or: node scripts/server.js
```

Then open **http://127.0.0.1:4599/?g=main** in your browser. Open
**http://127.0.0.1:4599/** with no `?g=` to see the list of all sessions and pick
one (or start a new group).

Two optional settings:

| env var             | default            | purpose                                            |
|---------------------|--------------------|----------------------------------------------------|
| `PORT`              | `4599`             | server port                                        |
| `AGENT_MONITOR_DIR` | `scripts/groups/`  | where per-group runtime data (manifests, logs, chat, uploads) is stored |

Set `AGENT_MONITOR_DIR` to a folder inside your project so runtime data lives
with the project instead of with the tool:

```bash
AGENT_MONITOR_DIR="/path/to/project/.agent-monitor" PORT=4599 node scripts/server.js
```

## Use it as a coding-agent skill

`SKILL.md` ships with this repo, so a coding agent can drive the dashboard for
you: start the server, register agent cards, stream progress, and run the
manager chat.

### Install (recommended: one-command plugin)

The repo ships a plugin manifest, so a teammate can add it as a marketplace and
install with two lines inside Claude Code:

```text
/plugin marketplace add shahabarvin/claude-agent-monitor
/plugin install agent-monitor@agent-monitor
```

(The first `agent-monitor` is the plugin, the second is the marketplace. Both
are named `agent-monitor` in this repo.) To update later:

```text
/plugin marketplace update agent-monitor
```

### Install (manual clone)

```bash
# clone straight into the skills folder
git clone https://github.com/shahabarvin/claude-agent-monitor.git ~/.claude/skills/agent-monitor
```

Or clone it anywhere and copy or symlink the folder into `~/.claude/skills/`.
Restart your agent session so it picks up the new skill.

> Note: the dashboard runs a small Node server. The first time the skill
> launches it, the agent asks permission to run `node scripts/server.js`.
> Approve it, or pre-approve it in `.claude/settings.json`. Re-invoke the skill
> once per session to restart the server.

### Invoke it

Once it's installed, just tell your agent:

> **"start group work"**, or "monitor the agents", or "open the agent dashboard".

The agent boots the server in the background, hands you a
`http://127.0.0.1:4599/?g=<group>` link, spins up its background agents, and
keeps the cards and chat live while it works. You can talk back to it any time
from the chat bar at the bottom of the page.

## How it works

Each session is a group (`?g=<name>`). Everything for a group lives under
`<AGENT_MONITOR_DIR>/<group>/`:

```
manifest.json            the roster: [{ id, name, task, worktree, status, startedAt, endedAt }]
agents/<id>.log          per-agent progress stream, one "[HH:mm:ss] message" line per step
chat.jsonl               append-only two-way chat (roles: user / manager / status / typing / clear)
uploads/<stamped-file>   files pasted or uploaded from the browser
```

The page polls `manifest.json` and each `agents/<id>.log` every 1.5 seconds, and
`chat.jsonl` every second, with no-store caching, so the browser always sees the
latest bytes. The server exposes small endpoints the page uses:
`POST /say`, `/clear`, `/upload`, `/remove`, `/archive-delete`,
`/archive-delete-all`, and the draft-task endpoints `/draft-create`,
`/draft-update`, `/draft-delete`, `/draft-play` (each taking `?g=<group>`), plus
`GET /groups-list` (the home page's session list) and
`GET /report?g=<group>&format=md|html` (the downloadable session report).

See `SKILL.md` for the full manager protocol: manifest shape, log format, chat
roles, `[MGR]` management markers, and the agent name pool.

## License

MIT. See [LICENSE](LICENSE). Copyright (c) 2026 Shahab Avin.
