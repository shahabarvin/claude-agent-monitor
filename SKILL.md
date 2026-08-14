---
name: agent-monitor
description: Live local dashboard for watching background agents - a grid of status cards with streamed per-agent logs plus a two-way manager chat. Use when the user says "start group work", "monitor agents", "agent dashboard", or wants to launch and coordinate several background agents at once and watch them in the browser.
---

# Agent Monitor

A tiny local web dashboard for coordinating a fleet of background agents. It
serves a grid of cards - one per agent - showing name, colour-coded status,
optional git worktree, and a live stream of that agent's log lines. A manager
chat bar at the bottom is a two-way channel between the human (in the browser)
and the manager session (you), with file/image paste, archives, and RTL text
support.

You are the **manager session**: you launch the background agents, keep the
dashboard's files up to date, and answer the human in the chat. The dashboard
is display-only - it renders whatever files you write on disk.

## 1. Start the server

Launch the static server in the background (use your run-in-background
facility; it must keep running for the whole session):

```bash
# from the skill directory
AGENT_MONITOR_DIR="<project>/.agent-monitor" PORT=4599 node scripts/server.js
```

- `PORT` - default `4599`.
- `AGENT_MONITOR_DIR` - where runtime data (per-group manifests, logs, chat)
  is stored. Point it at a folder inside the current project (e.g.
  `<project>/.agent-monitor`) so runtime data never pollutes the installed
  skill. If unset it defaults to a `groups/` folder beside `server.js`.

Then tell the human to open **http://127.0.0.1:4599/?g=<group>** (see groups
below). Everything the page reads lives under `<AGENT_MONITOR_DIR>/<group>/`.

## 2. Groups

Each session is one **group** (`?g=<name>`, default `main`) with its own
manifest, agent logs and chat. Use a fresh group name per working session so
runs don't collide. All paths below are relative to
`<AGENT_MONITOR_DIR>/<group>/`.

Opening the server root with **no** `?g=` shows a home page that lists every
group on the server (agent counts + last activity) and links into each one. It
is the reconnect view: point the human there after a browser or editor restart
and they can pick the session to rejoin, or type a new group name to start one.

## 3. Register agent cards - `manifest.json`

Before (or as) you launch a background agent, add it to `manifest.json`:

```json
{
  "agents": [
    {
      "id": "castiel",
      "name": "Castiel",
      "task": "one-line description of what this agent is doing",
      "worktree": "/abs/path/to/worktree",
      "status": "running",
      "startedAt": "2026-01-01T00:00:00.000Z",
      "endedAt": null
    }
  ]
}
```

- `id` - lowercase, `[a-z0-9_-]` only. It is also the log filename
  (`agents/<id>.log`).
- `name` - display name (Title-Case).
- `worktree` - absolute path if the agent runs in its own git worktree, else
  `""`.
- `startedAt` / `endedAt` - ISO timestamps; set `endedAt` when it finishes.
- `order` - **optional integer, written by the browser when the human drags a
  card to rearrange the grid.** You never set it, but when you rewrite a card
  (status flip, `endedAt`, etc.) keep whatever `order` value is already on it -
  read-modify-write the manifest, don't rebuild agents from scratch, or the human's
  arrangement is lost. New cards need no `order`; the page sorts them to the end.

Append to the `agents` array - never overwrite other agents' entries. Write
the whole file back as valid JSON each time.

## 4. Stream progress - `agents/<id>.log`

Each background agent (or you, on its behalf) appends timestamped lines to its
own log. The card streams them; the newest line is highlighted as the card's
"now" line.

```
[14:03:07] worktree created - agent launching
[14:04:22] read config, mapping the routes now
[14:07:41] tests green - opening the PR
```

The format is `[HH:mm:ss] <message>`, one line per step. Have every agent you
launch append a line at each meaningful step so the human can watch progress
without opening the transcript. Example append:

```bash
printf '[%s] %s\n' "$(date +%H:%M:%S)" "reading the config file" \
  >> "$AGENT_MONITOR_DIR/<group>/agents/castiel.log"
```

## 5. Statuses (card colour)

| `status`             | colour | meaning                         |
|----------------------|--------|---------------------------------|
| `running`            | green  | in progress (blinking marker)   |
| `done`               | blue   | finished OK (gets a **remove** button) |
| `failed` / `stopped` | red    | failed or halted                |
| `draft`              | amber  | a browser-created task not yet launched; Play sets a `playRequestedAt` signal (see Draft tasks below) |

Update the agent's `status` in `manifest.json` when it transitions, and set
`endedAt`. Only `done` cards get a remove button in the UI.

## Draft tasks - the human queues, you launch

The human can define a task in the browser instead of handing it to you in
chat. The **+ new task** button (top-left nav) creates a **draft** card they can
name, describe, give a worktree, and edit in place. A draft is inert: the page
only writes it into `manifest.json` (`status:"draft"`) - nothing runs until the
human presses **Play** on the card.

Play does two things: it renames the card's `id` to a clean slug of its `name`
(so "Castiel" becomes `castiel`; a duplicate name gets `castiel2`, and a blank
name keeps the generated id), and it stamps `playRequestedAt` (an ISO timestamp),
leaving the status as `draft`. The stamp is the launch signal, written once, so a
second Play never queues a duplicate. By the time you see the card, its `id` is
already the clean slug and the log file (if any) has moved to match.

Your side of the loop, as you tail the group:

- **Poll `manifest.json`** for cards with `status:"draft"` that carry a
  `playRequestedAt`. Those are the ones the human wants launched.
- **When you find one, spawn its agent** for that `task` (in its `worktree` if
  set), then rewrite the same card: set `status:"running"` and `startedAt`, and
  **delete the `playRequestedAt` field** so it can't be picked up twice. From
  there it is an ordinary agent card - stream its log as usual, and post an
  `[MGR]` status line so the human sees the launch in the chat.
- **Leave untouched** any draft with **no** `playRequestedAt` - the human is
  still editing it. Never launch a draft on your own.

> **The `id` is already clean - use it as-is.** Play has done the renaming for
> you, so the card arrives with a presentable `id` (a slug of its `name`) that
> already matches its log filename. Do not rename it. Stream from
> `agents/<id>.log`, and key every later update - `status`,
> `startedAt`/`endedAt`, remove - off that same `id`. Set `name` for the human
> to read, but never look a card up by its display name: close one by `name` and
> the match silently fails, leaving it stuck green forever.

## 6. Manager chat protocol - `chat.jsonl`

`chat.jsonl` is append-only JSONL. The browser writes the human's messages;
you tail the file and append your replies. Roles:

- `user` - written by the server when the human sends a message or uploads a
  file. File uploads look like `{"role":"user","text":"file: shot.png (12 KB)","file":"<stamped-name>","ts":...}`; the file is saved under `uploads/` - read it straight off disk.
- `manager` - **your** replies. Append `{"role":"manager","text":"...","ts":"<iso>"}`.
- `typing` - optional "composing" hint. Append `{"role":"typing","text":"","ts":...}` before a slow reply; it is superseded the moment your next `manager` line lands, and the UI shows an animated `. . .` in the meantime.
- `status` - greyed-out in-band note. Use it to record **management actions**
  so the human sees them in the chat: prefix them `[MGR]`, e.g.
  `{"role":"status","text":"[MGR] launched Castiel on route-mapping","ts":...}`.
- `clear` - written when the human clicks **clear**; everything before the last
  `clear` marker becomes an archive. Never truncate the file - keep tailing it.

Conventions:
- **Chunked replies.** For a long answer, append several short `manager` lines
  instead of one giant line - they stream in naturally and read better.
- **Announce management actions** as `[MGR]` `status` lines: spawning, removing,
  reassigning, or stopping an agent.
- Poll / tail `chat.jsonl` for new `user` lines throughout the session and
  answer promptly.

Append a reply (POSIX):

```bash
printf '%s\n' '{"role":"manager","text":"on it - spinning up two agents","ts":"'"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"'"}' \
  >> "$AGENT_MONITOR_DIR/<group>/chat.jsonl"
```

PowerShell:

```powershell
$ts = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.000Z")
$line = @{ role="manager"; text="on it - spinning up two agents"; ts=$ts } | ConvertTo-Json -Compress
Add-Content -Path "$env:AGENT_MONITOR_DIR/<group>/chat.jsonl" -Value $line -Encoding utf8
```

## 7. Autonomous tech-lead mode

The human can hand you a whole goal instead of a single task and ask you to run
it to completion without babysitting. In that mode you act as the tech lead:
decompose the goal, spawn agents, review and integrate their work, verify, and
keep going until the goal is met.

**How it actually keeps running.** A skill cannot loop on its own; the loop is a
Claude Code primitive. Start the run with one of these (the human types it, or
you suggest it):

```text
/goal <the goal is met> or stop after <N> iterations
```

`/goal` re-checks the condition after every turn with a small fast model. While
the condition is false, you continue automatically without waiting for a prompt.
When it is true, the goal clears and the run ends. The `or stop after N` clause
is your safety cap so a run can never spin forever. Use `/loop <prompt>` instead
when the work is poll-shaped (waiting on a build, a deploy, a queue) rather than
end-state-shaped.

**Operating rules while autonomous:**

- **Keep momentum.** Proceed on any reversible decision without asking. Only
  stop for a genuinely destructive or irreversible action (deleting data,
  spending money, publishing something public, an irreversible migration).
- **If you must ask and get no answer, do not stall.** Post the question as a
  `manager` chat line, state the assumption you will proceed on, and continue:
  `"Assuming X unless you say otherwise - continuing."` Momentum beats a blocked
  queue; the human can correct you from the chat bar at any time.
- **One agent per decomposed piece**, isolated in a worktree when they write in
  parallel. Review every agent's result yourself before integrating - never
  merge on an agent's self-report alone. Run the project's tests/guards after
  each integration.
- **Narrate to the board.** Register a card per agent, keep `[MGR]` status lines
  flowing, and post short progress notes to the chat so the human can watch the
  run unfold and step in.
- **Checkpoint often.** After each integrated piece, commit, and drop a
  downloadable report link (`/report?g=<group>&format=md`) so there is always an
  up-to-date record of what the run has done and what remains.
- **Define "done" concretely** at the start (the acceptance condition you put in
  `/goal`), so both you and the evaluator agree on when to stop.

**Reconnecting to a run.** Everything lives on disk, so a run survives the
browser or editor closing. Reopen the session with `claude --continue` (or
`claude --resume`); an active `/goal` is restored for up to 7 days. The server
is detached, so the dashboard keeps serving; if it was stopped, relaunch it and
open the home page (`/`) to jump back into the group.

## 8. Agent name pool

Name agents from this pool (in order); on reuse append a number
(`Castiel` -> `Castiel-2`, id `castiel2`):

```
Castiel  Gabriel  Gadreel  Samandriel  Balthazar  Uriel  Raphael  Michael
Anael    Hannah   Naomi    Muriel      Ephraim    Inias  Hester   Joshua
Benjamin Rachel   Ezekiel  Metatron
```

`id` = lowercase name with no dash (`castiel2`); `name` = display form
(`Castiel-2`).

## 9. Removing & archiving

- When the human clicks **remove** on a `done` card, the server drops that
  agent from `manifest.json` (the log file is kept). You can also remove an
  entry yourself by rewriting `manifest.json`.
- The **clear** button only touches the chat, via a `clear` marker - no files
  are deleted, and the live chat moves to the archive.
- The **archive** view lists past (cleared) chat sessions. Each row can be read,
  deleted on its own, or wiped together via **delete all**; deleting rewrites
  `chat.jsonl` and always keeps the current live chat. This is the one place the
  chat file is trimmed, so re-open your tail afterwards if you keep a handle on
  it.

## Session report

Every group view has a **report.md** / **report.html** link (top-left), and the
home page offers the same per group. It downloads a report of the session: each
agent's status, task, worktree, timing and full log, followed by the chat
transcript. Served by `GET /report?g=<group>&format=md|html` - handy for handing
off or archiving a run outside the dashboard.

## Summary of files (per group)

```
<AGENT_MONITOR_DIR>/<group>/
  manifest.json            # the agent roster (you write; `order` is set by browser drag - preserve it)
  agents/<id>.log          # per-agent [HH:mm:ss] progress stream (you/agents write)
  chat.jsonl               # two-way manager chat (append-only)
  uploads/<stamped-file>   # files the human pastes/uploads
```
