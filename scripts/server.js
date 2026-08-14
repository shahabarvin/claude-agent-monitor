// Tiny static server for the agent-monitor dashboard (display-only).
// Serves the dashboard UI + per-group runtime data (manifest, agent logs, chat)
// with no-store caching so the page's 1.5s polling always sees fresh content.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const SCRIPT_DIR = __dirname;                              // scripts/
const ASSET_DIR = path.join(SCRIPT_DIR, '..', 'assets');  // ../assets/ (the UI)

// Runtime data lives here - one sub-directory per group (manifest, agent logs,
// chat.jsonl, uploads). Override the location with the AGENT_MONITOR_DIR env
// var; otherwise it defaults to a groups/ folder beside this script. Nothing
// here is ever hardcoded to a specific project path.
const DATA_DIR = process.env.AGENT_MONITOR_DIR
  ? path.resolve(process.env.AGENT_MONITOR_DIR)
  : path.join(SCRIPT_DIR, 'groups');

const PORT = parseInt(process.env.PORT, 10) || 4599;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
};

// Serve a file only if it resolves inside `base` (path-traversal guard).
function serveFile(res, file, base) {
  const resolved = path.normalize(file);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    res.writeHead(403); return res.end();
  }
  fs.readFile(resolved, (err, data) => {
    if (err) { res.writeHead(404, { 'Cache-Control': 'no-store' }); return res.end('not found'); }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(resolved).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

// ── shared read helpers (used by /groups-list and /report) ───────────────────
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}
function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { return ''; }
}
function readChat(gdir) {
  return readText(path.join(gdir, 'chat.jsonl'))
    .split(/\r?\n/).filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } })
    .filter(Boolean);
}

// Split chat.jsonl into segments the way the page does: each {"role":"clear"}
// marker closes a segment. `segments` are the archived ones (each ended by a
// clear marker); `live` is the current segment after the last clear. Raw line
// text is preserved so a rewrite keeps every message byte-for-byte.
function segmentChat(gdir) {
  const lines = readText(path.join(gdir, 'chat.jsonl')).split(/\r?\n/);
  const segments = [];
  let cur = { lines: [], clear: null };
  for (const line of lines) {
    if (!line.trim()) continue;
    let role = null;
    try { role = JSON.parse(line).role; } catch (e) { role = null; }
    if (role === 'clear') { cur.clear = line; segments.push(cur); cur = { lines: [], clear: null }; }
    else cur.lines.push(line);
  }
  return { segments, live: cur };
}

// Rewrite chat.jsonl. Prefer an atomic temp+rename; but the manager session may
// be tailing the file with an open handle, and Windows can refuse to rename over
// an open file, so fall back to an in-place write (same inode) on failure.
function writeChat(gdir, text) {
  const chatPath = path.join(gdir, 'chat.jsonl');
  const tmp = chatPath + '.tmp-' + process.pid + '-' + Date.now();
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, chatPath);
  } catch (e) {
    try { fs.writeFileSync(chatPath, text); } finally { try { fs.unlinkSync(tmp); } catch (e2) {} }
  }
}
function durationStr(startIso, endIso) {
  if (!startIso) return '';
  const s = new Date(startIso).getTime();
  if (isNaN(s)) return '';
  const e = endIso ? new Date(endIso).getTime() : Date.now();
  let sec = Math.max(0, Math.floor((e - s) / 1000));
  const h = Math.floor(sec / 3600); sec %= 3600;
  const m = Math.floor(sec / 60); const r = sec % 60;
  return (h ? h + 'h' : '') + (h || m ? m + 'm' : '') + r + 's';
}
function statusCounts(agents) {
  let running = 0, done = 0, failed = 0;
  for (const a of agents) {
    if (a.status === 'running') running++;
    else if (a.status === 'done') done++;
    else if (a.status === 'failed' || a.status === 'stopped') failed++;
  }
  return { running, done, failed };
}
// newest mtime across a group's manifest, chat and agent logs = last activity.
function newestMtime(gdir) {
  let last = 0;
  const stamp = (f) => { try { const st = fs.statSync(f); if (st.mtimeMs > last) last = st.mtimeMs; } catch (e) {} };
  stamp(path.join(gdir, 'manifest.json'));
  stamp(path.join(gdir, 'chat.jsonl'));
  try { for (const lf of fs.readdirSync(path.join(gdir, 'agents'))) stamp(path.join(gdir, 'agents', lf)); } catch (e) {}
  if (!last) stamp(gdir);
  return last;
}
// Every group directory under DATA_DIR, with counts + last activity. Only names
// that survive the same [a-zA-Z0-9_-] sanitizing the ?g= param uses are listed,
// so every row is reachable and there is no traversal surface.
function listGroups() {
  let entries = [];
  try { entries = fs.readdirSync(DATA_DIR, { withFileTypes: true }); } catch (e) { return []; }
  const out = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const name = ent.name;
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) continue;
    const gdir = path.join(DATA_DIR, name);
    const man = readJson(path.join(gdir, 'manifest.json')) || {};
    const agents = Array.isArray(man.agents) ? man.agents : [];
    const c = statusCounts(agents);
    const last = newestMtime(gdir);
    out.push({
      name,
      agentCount: agents.length,
      running: c.running, done: c.done, failed: c.failed,
      lastActivity: last ? new Date(last).toISOString() : null,
    });
  }
  out.sort((a, b) => String(b.lastActivity || '').localeCompare(String(a.lastActivity || '')));
  return out;
}

// ── report builders ──────────────────────────────────────────────────────────
const escHtml = (s) => String(s == null ? '' : s)
  .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Load a group's roster (each agent gets its full log on `_log`) plus the chat.
function collectGroup(gdir) {
  const man = readJson(path.join(gdir, 'manifest.json')) || {};
  const agents = Array.isArray(man.agents) ? man.agents : [];
  for (const a of agents) a._log = readText(path.join(gdir, 'agents', String(a.id) + '.log'));
  return { agents, chat: readChat(gdir) };
}

function buildReportMd(name, agents, chat) {
  const L = [];
  L.push('# Agent Monitor report - ' + name);
  L.push('');
  L.push('Generated ' + new Date().toISOString());
  L.push('');
  L.push('## Agents (' + agents.length + ')');
  L.push('');
  if (!agents.length) { L.push('_No agents registered._'); L.push(''); }
  for (const a of agents) {
    L.push('### ' + (a.name || a.id || 'agent') + '  [' + (a.status || 'unknown') + ']');
    L.push('');
    L.push('- Task: ' + (a.task || '-'));
    L.push('- Worktree: ' + (a.worktree || '-'));
    L.push('- Started: ' + (a.startedAt || '-'));
    L.push('- Ended: ' + (a.endedAt || '-'));
    L.push('- Duration: ' + (durationStr(a.startedAt, a.endedAt) || '-'));
    L.push('');
    L.push('Log:');
    L.push('');
    // Indented code block: content cannot break out of it, so no escaping needed.
    const log = (a._log || '').split(/\r?\n/).filter((l) => l.length);
    if (!log.length) L.push('    (no log)');
    else for (const line of log) L.push('    ' + line);
    L.push('');
  }
  L.push('## Chat transcript');
  L.push('');
  const shown = chat.filter((m) => m.role !== 'typing');
  if (!shown.length) L.push('_No chat messages._');
  for (const m of shown) {
    if (m.role === 'clear') { L.push(''); L.push('--- cleared ---'); L.push(''); continue; }
    const who = m.role === 'user' ? 'you' : (m.role === 'status' ? 'status' : (m.role === 'manager' ? 'manager' : m.role));
    const ts = m.ts ? ' · ' + m.ts : '';
    let txt = String(m.text || '').replace(/\r?\n/g, ' ');
    if (m.file) txt += ' [' + m.file + ']';
    const label = m.role === 'status' ? '_' + who + '_' : '**' + who + '**';
    L.push('- ' + label + ts + ' · ' + txt);
  }
  L.push('');
  return L.join('\n');
}

const REPORT_CSS = `
  :root { --ink:#000; --paper:#fff; --dim:#444; --faint:#888;
          --run:#16c73c; --fail:#f01818; --done:#1e5bff;
          --mono: ui-monospace, "Cascadia Mono", Consolas, monospace; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { background:var(--paper); color:var(--ink); font-family:var(--mono);
         font-size:13px; line-height:1.5; padding:24px; max-width:900px; }
  h1 { font-size:18px; text-transform:uppercase; letter-spacing:1px; }
  h2 { font-size:14px; text-transform:uppercase; letter-spacing:1px;
       margin:24px 0 10px; border-bottom:2px solid var(--ink); padding-bottom:4px; }
  .meta { color:var(--dim); font-size:11px; margin-top:4px; }
  .empty { color:var(--faint); }
  .agent { border:2px solid var(--ink); margin-bottom:12px; }
  .ahead { display:flex; align-items:center; gap:10px; padding:6px 10px;
           border-bottom:2px solid var(--ink); }
  .agent.running .ahead { background:var(--run); color:var(--ink); }
  .agent.done .ahead { background:var(--done); color:var(--paper); }
  .agent.failed .ahead, .agent.stopped .ahead { background:var(--fail); color:var(--paper); }
  .aname { font-weight:700; text-transform:uppercase; letter-spacing:.5px; }
  .astatus { margin-left:auto; font-size:10px; font-weight:700; letter-spacing:1.5px; text-transform:uppercase; }
  table.kv { border-collapse:collapse; width:100%; }
  table.kv td { padding:3px 10px; vertical-align:top; border-bottom:1px solid #e6e6e6; }
  table.kv td:first-child { width:90px; color:var(--faint); text-transform:uppercase;
                            font-size:10px; letter-spacing:1px; }
  pre.log { padding:8px 10px; font-size:11.5px; line-height:1.6; white-space:pre-wrap;
            word-break:break-word; background:#f6f6f6; border-top:1px solid var(--ink); }
  .chat > div { padding:4px 0; border-bottom:1px solid #eee; }
  .c-who { font-weight:700; text-transform:uppercase; font-size:10px; letter-spacing:1px; margin-right:8px; }
  .c-user .c-who { color:var(--done); }
  .c-status { color:var(--faint); font-size:11.5px; }
  .c-ts { color:var(--faint); font-size:10px; }
  .c-text { white-space:pre-wrap; word-break:break-word; margin-top:2px; }
  .c-file { color:var(--done); font-weight:700; }
  .c-clear { text-align:center; color:var(--paper); background:var(--ink);
             font-size:10px; letter-spacing:2px; text-transform:uppercase; padding:2px; margin:6px 0; }
`;

function buildReportHtml(name, agents, chat) {
  const P = [];
  P.push('<!doctype html><html lang="en"><head><meta charset="utf-8">');
  P.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
  P.push('<title>agent monitor report · ' + escHtml(name) + '</title>');
  P.push('<style>' + REPORT_CSS + '</style></head><body>');
  P.push('<h1>Agent Monitor report</h1>');
  P.push('<div class="meta">group <b>' + escHtml(name) + '</b> · generated ' + escHtml(new Date().toISOString()) + '</div>');
  P.push('<h2>Agents (' + agents.length + ')</h2>');
  if (!agents.length) P.push('<p class="empty">No agents registered.</p>');
  for (const a of agents) {
    const st = a.status || 'unknown';
    P.push('<section class="agent ' + escHtml(st) + '">');
    P.push('<div class="ahead"><span class="aname">' + escHtml(a.name || a.id || 'agent') +
      '</span><span class="astatus">' + escHtml(st) + '</span></div>');
    P.push('<table class="kv">');
    P.push('<tr><td>task</td><td>' + escHtml(a.task || '-') + '</td></tr>');
    P.push('<tr><td>worktree</td><td>' + escHtml(a.worktree || '-') + '</td></tr>');
    P.push('<tr><td>started</td><td>' + escHtml(a.startedAt || '-') + '</td></tr>');
    P.push('<tr><td>ended</td><td>' + escHtml(a.endedAt || '-') + '</td></tr>');
    P.push('<tr><td>duration</td><td>' + escHtml(durationStr(a.startedAt, a.endedAt) || '-') + '</td></tr>');
    P.push('</table>');
    const log = (a._log || '').split(/\r?\n/).filter((l) => l.length);
    P.push('<pre class="log">' + (log.length ? escHtml(log.join('\n')) : '(no log)') + '</pre>');
    P.push('</section>');
  }
  P.push('<h2>Chat transcript</h2>');
  const shown = chat.filter((m) => m.role !== 'typing');
  if (!shown.length) P.push('<p class="empty">No chat messages.</p>');
  P.push('<div class="chat">');
  for (const m of shown) {
    if (m.role === 'clear') { P.push('<div class="c-clear">cleared</div>'); continue; }
    const who = m.role === 'user' ? 'you' : (m.role === 'status' ? 'status' : (m.role === 'manager' ? 'manager' : escHtml(m.role)));
    const cls = m.role === 'user' ? 'c-user' : (m.role === 'status' ? 'c-status' : 'c-manager');
    const ts = m.ts ? '<span class="c-ts">' + escHtml(m.ts) + '</span>' : '';
    let body = escHtml(String(m.text || ''));
    if (m.file) body += ' <span class="c-file">[' + escHtml(m.file) + ']</span>';
    P.push('<div class="' + cls + '"><span class="c-who">' + who + '</span>' + ts +
      '<div class="c-text">' + body + '</div></div>');
  }
  P.push('</div></body></html>');
  return P.join('\n');
}

http.createServer((req, res) => {
  try {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);

    // Each session gets its own GROUP under <DATA_DIR>/<g>/ - separate
    // manifest, agent logs and chat. The page selects it via ?g=<name>.
    const q = new URLSearchParams(req.url.split('?')[1] || '');
    const g = (q.get('g') || 'main').replace(/[^a-zA-Z0-9_-]/g, '') || 'main';
    const groupDir = path.join(DATA_DIR, g);

    // POST /say?g=<group> - the dashboard's chat box appends a user message to
    // that group's chat.jsonl; the manager session tails the file.
    if (req.method === 'POST' && urlPath === '/say') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 8192) req.destroy(); });
      req.on('end', () => {
        try {
          const text = String(JSON.parse(body).text || '').slice(0, 4000).trim();
          if (text) {
            fs.mkdirSync(groupDir, { recursive: true });
            const line = JSON.stringify({ role: 'user', text, ts: new Date().toISOString() });
            fs.appendFileSync(path.join(groupDir, 'chat.jsonl'), line + '\n');
          }
          res.writeHead(200, { 'Cache-Control': 'no-store' }); res.end('ok');
        } catch (e) { res.writeHead(400); res.end('bad json'); }
      });
      return;
    }

    // POST /clear?g=<group> - appends a clear-marker; the UI hides everything
    // before the LAST marker. No truncation (the manager session tails this
    // file with an open handle), and history stays in the file as archive.
    if (req.method === 'POST' && urlPath === '/clear') {
      try {
        fs.mkdirSync(groupDir, { recursive: true });
        const line = JSON.stringify({ role: 'clear', ts: new Date().toISOString() });
        fs.appendFileSync(path.join(groupDir, 'chat.jsonl'), line + '\n');
        res.writeHead(200, { 'Cache-Control': 'no-store' }); return res.end('ok');
      } catch (e) { res.writeHead(500); return res.end('clear error'); }
    }

    // POST /upload?g=<group>&name=<file> - raw body saved under the group's
    // uploads/ dir; a user-role chat line records it so the manager session's
    // monitor picks it up and can read the file straight off disk.
    if (req.method === 'POST' && urlPath === '/upload') {
      const rawName = (q.get('name') || 'file').split(/[\\/]/).pop();
      const safe = rawName.replace(/[^a-zA-Z0-9._؀-ۿ-]/g, '_').slice(0, 120) || 'file';
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > 25 * 1024 * 1024) { req.destroy(); return; } // 25 MB cap
        chunks.push(c);
      });
      req.on('end', () => {
        try {
          const upDir = path.join(groupDir, 'uploads');
          fs.mkdirSync(upDir, { recursive: true });
          const stamped = Date.now() + '-' + safe;
          fs.writeFileSync(path.join(upDir, stamped), Buffer.concat(chunks));
          const line = JSON.stringify({
            role: 'user',
            text: 'file: ' + safe + ' (' + Math.round(size / 1024) + ' KB)',
            file: stamped,
            ts: new Date().toISOString(),
          });
          fs.appendFileSync(path.join(groupDir, 'chat.jsonl'), line + '\n');
          res.writeHead(200, { 'Cache-Control': 'no-store' }); res.end('ok');
        } catch (e) { res.writeHead(500); res.end('upload error'); }
      });
      return;
    }

    // POST /remove?g=<group>&id=<agentId> - drop a finished agent from that
    // group's manifest so the remove button survives refreshes. Log is kept.
    if (req.method === 'POST' && urlPath === '/remove') {
      const id = q.get('id');
      const manPath = path.join(groupDir, 'manifest.json');
      try {
        const man = JSON.parse(fs.readFileSync(manPath, 'utf8'));
        man.agents = (man.agents || []).filter((a) => a.id !== id);
        fs.writeFileSync(manPath, JSON.stringify(man, null, 2));
        res.writeHead(200, { 'Cache-Control': 'no-store' });
        return res.end('ok');
      } catch (e) {
        res.writeHead(500); return res.end('manifest error');
      }
    }

    // POST /archive-delete?g=<group>&index=<k> - drop one archived chat segment
    // (the k-th non-empty segment before a clear marker, matching the UI index),
    // keeping the other archives and the live chat. Rewrites chat.jsonl.
    if (req.method === 'POST' && urlPath === '/archive-delete') {
      const index = parseInt(q.get('index'), 10);
      try {
        const { segments, live } = segmentChat(groupDir);
        const uiArchives = segments.filter((s) => s.lines.length > 0);
        if (isNaN(index) || index < 0 || index >= uiArchives.length) {
          res.writeHead(400); return res.end('bad index');
        }
        const target = uiArchives[index];
        const out = [];
        for (const seg of segments) {
          if (seg === target) continue;       // drop its lines + its clear marker
          for (const l of seg.lines) out.push(l);
          if (seg.clear) out.push(seg.clear);
        }
        for (const l of live.lines) out.push(l);
        writeChat(groupDir, out.length ? out.join('\n') + '\n' : '');
        res.writeHead(200, { 'Cache-Control': 'no-store' }); return res.end('ok');
      } catch (e) { res.writeHead(500); return res.end('archive delete error'); }
    }

    // POST /archive-delete-all?g=<group> - drop every archived segment and keep
    // only the current live chat.
    if (req.method === 'POST' && urlPath === '/archive-delete-all') {
      try {
        const { live } = segmentChat(groupDir);
        writeChat(groupDir, live.lines.length ? live.lines.join('\n') + '\n' : '');
        res.writeHead(200, { 'Cache-Control': 'no-store' }); return res.end('ok');
      } catch (e) { res.writeHead(500); return res.end('archive delete-all error'); }
    }

    // GET /groups-list - every group under DATA_DIR with counts + last activity.
    // Powers the home / reconnect view when the page is opened without ?g=.
    if (req.method === 'GET' && urlPath === '/groups-list') {
      const body = JSON.stringify(listGroups());
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      return res.end(body);
    }

    // GET /report?g=<group>&format=md|html - a downloadable report of one group:
    // per-agent sections (meta + full log) then the chat transcript. `g` is
    // already sanitized to [a-zA-Z0-9_-] above, so it is safe in the filename.
    if (req.method === 'GET' && urlPath === '/report') {
      let fmt = (q.get('format') || 'md').toLowerCase();
      if (fmt !== 'md' && fmt !== 'html') fmt = 'md';
      const { agents, chat } = collectGroup(groupDir);
      const body = fmt === 'html' ? buildReportHtml(g, agents, chat) : buildReportMd(g, agents, chat);
      res.writeHead(200, {
        'Content-Type': fmt === 'html' ? 'text/html; charset=utf-8' : 'text/markdown; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Disposition': 'attachment; filename="' + g + '-report.' + fmt + '"',
      });
      return res.end(body);
    }

    // ── static GET ────────────────────────────────────────────────────────
    // /                → the dashboard UI (assets/dashboard.html)
    // /groups/<g>/...  → runtime data from DATA_DIR
    // anything else    → other files in assets/
    if (urlPath === '/') {
      return serveFile(res, path.join(ASSET_DIR, 'dashboard.html'), ASSET_DIR);
    }
    if (urlPath.startsWith('/groups/')) {
      const rel = urlPath.slice('/groups/'.length);
      return serveFile(res, path.join(DATA_DIR, rel), DATA_DIR);
    }
    return serveFile(res, path.join(ASSET_DIR, urlPath.slice(1)), ASSET_DIR);
  } catch (e) {
    res.writeHead(500); res.end();
  }
}).listen(PORT, '127.0.0.1', () => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  console.log(`agent monitor on http://127.0.0.1:${PORT}  (data: ${DATA_DIR})`);
});
