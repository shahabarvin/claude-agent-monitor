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
