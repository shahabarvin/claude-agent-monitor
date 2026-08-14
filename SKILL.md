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

Update the agent's `status` in `manifest.json` when it transitions, and set
`endedAt`. Only `done` cards get a remove button in the UI.

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

## 7. Agent name pool

Name agents from this pool (in order); on reuse append a number
(`Castiel` -> `Castiel-2`, id `castiel2`):

```
Castiel  Gabriel  Gadreel  Samandriel  Balthazar  Uriel  Raphael  Michael
Anael    Hannah   Naomi    Muriel      Ephraim    Inias  Hester   Joshua
Benjamin Rachel   Ezekiel  Metatron
```

`id` = lowercase name with no dash (`castiel2`); `name` = display form
(`Castiel-2`).

## 8. Removing & archiving

- When the human clicks **remove** on a `done` card, the server drops that
  agent from `manifest.json` (the log file is kept). You can also remove an
  entry yourself by rewriting `manifest.json`.
- The **archive** and **clear** buttons only touch the chat, via `clear`
  markers - no files are deleted.

## Summary of files (per group)

```
<AGENT_MONITOR_DIR>/<group>/
  manifest.json            # the agent roster (you write)
  agents/<id>.log          # per-agent [HH:mm:ss] progress stream (you/agents write)
  chat.jsonl               # two-way manager chat (append-only)
  uploads/<stamped-file>   # files the human pastes/uploads
```
