// DevOps Scanner — local coordination server
// Handles dedup, shared AI queue, SQLite persistence, WebSocket push.
// Notion sync remains in the extension (token stays on each user's machine).
//
// Usage: node server.js
// Default port: 3747

'use strict';

const express    = require('express');
const { WebSocketServer } = require('ws');
const sqlite3    = require('sqlite3').verbose();
const http       = require('http');
const path       = require('path');
const fs         = require('fs');

const PORT    = process.env.PORT ? parseInt(process.env.PORT) : 3747;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'scanner.db');
const PEERS   = (process.env.PEERS || '').split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);

// ---- Database ---------------------------------------------------------------

const _db = new sqlite3.Database(DB_PATH);

// Thin promise wrappers so routes stay readable
const db = {
  run:  (sql, params = []) => new Promise((res, rej) => _db.run(sql, params, function(err) { if (err) rej(err); else res({ lastID: this.lastID, changes: this.changes }); })),
  get:  (sql, params = []) => new Promise((res, rej) => _db.get(sql, params, (err, row) => err ? rej(err) : res(row))),
  all:  (sql, params = []) => new Promise((res, rej) => _db.all(sql, params, (err, rows) => err ? rej(err) : res(rows))),
  exec: (sql)              => new Promise((res, rej) => _db.exec(sql, err => err ? rej(err) : res())),
};

db.exec(`
  PRAGMA journal_mode=WAL;
  CREATE TABLE IF NOT EXISTS matches (
    id           TEXT    PRIMARY KEY,
    url          TEXT    UNIQUE,
    notion_page_id TEXT,
    saved_by     TEXT,
    data         TEXT    NOT NULL,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_matches_url ON matches(url);

  CREATE TABLE IF NOT EXISTS ai_cache (
    text_hash  TEXT    PRIMARY KEY,
    analysis   TEXT    NOT NULL,
    model      TEXT,
    time_ms    INTEGER,
    tokens     INTEGER,
    created_at INTEGER NOT NULL
  );
`).catch(err => { console.error('DB init error:', err); process.exit(1); });

// ---- Express ----------------------------------------------------------------

const app = express();
app.use(express.json({ limit: '4mb' }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ---- WebSocket --------------------------------------------------------------

const server = http.createServer(app);
const wss    = new WebSocketServer({ server });
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

function broadcast(msg) {
  const str = JSON.stringify(msg);
  for (const client of clients) {
    if (client.readyState === 1 /* OPEN */) client.send(str);
  }
}

// ---- Shared AI queue --------------------------------------------------------

const aiCache = new Map(); // hash → analysis (in-memory, backed by SQLite)

// Pre-load cache from DB so restarts don't re-analyze old posts
db.all('SELECT text_hash, analysis FROM ai_cache').then(rows => {
  for (const row of rows) {
    try { aiCache.set(row.text_hash, JSON.parse(row.analysis)); } catch (_) {}
  }
  console.log(`AI cache pre-loaded: ${aiCache.size} entries`);
}).catch(() => {});

let aiActive = 0;
const aiQueue = [];
let aiErrorCount = 0;
let duplicatesBlocked = 0;

// ---- Peer federation --------------------------------------------------------

async function peerFetch(peerUrl, path, method, body) {
  try {
    const r = await fetch(`${peerUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(5000),
    });
    return r.ok ? await r.json() : null;
  } catch (_) { return null; }
}

async function forwardToPeers(path, method, body) {
  if (!PEERS.length) return;
  await Promise.allSettled(PEERS.map(peer => peerFetch(peer, path, method, body)));
}

// Pull all matches from a peer that this server doesn't have yet
async function syncFromPeer(peerUrl) {
  const lastRow = await db.get('SELECT MAX(updated_at) as t FROM matches');
  const since = lastRow?.t || 0;
  const data = await peerFetch(peerUrl, `/sync?since=${since}`, 'GET');
  if (!data?.matches?.length) return 0;
  let inserted = 0;
  for (const row of data.matches) {
    try {
      const r = await db.run(
        'INSERT OR IGNORE INTO matches (id, url, notion_page_id, saved_by, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [row.id, row.url, row.notion_page_id || null, row.saved_by || null, row.data, row.created_at, row.updated_at]
      );
      if (r.changes > 0) inserted++;
    } catch (_) {}
    // Sync notion_page_id for rows we already have but peer has synced
    if (row.notion_page_id) {
      await db.run(
        'UPDATE matches SET notion_page_id = ?, updated_at = ? WHERE (url = ? OR id = ?) AND notion_page_id IS NULL',
        [row.notion_page_id, row.updated_at, row.url, row.id]
      ).catch(() => {});
    }
  }
  console.log(`[peer] synced ${inserted} new matches from ${peerUrl}`);
  return inserted;
}

// Run startup sync after DB is ready
setTimeout(async () => {
  if (!PEERS.length) return;
  console.log(`[peer] syncing from ${PEERS.length} peer(s): ${PEERS.join(', ')}`);
  for (const peer of PEERS) await syncFromPeer(peer);
}, 2000);

function drainAIQueue() {
  while (aiActive < 1 && aiQueue.length) {
    aiActive++;
    const { hash, text, ollamaUrl, ollamaModel, resolve } = aiQueue.shift();
    broadcast({ action: 'aiStart', queueDepth: aiQueue.length, hash: hash.slice(0, 8) });
    const startTime = Date.now();
    runOllama(text, ollamaUrl, ollamaModel).then(result => {
      aiActive--;
      if (result.success) {
        aiCache.set(hash, result.analysis);
        db.run(
          'INSERT OR REPLACE INTO ai_cache (text_hash, analysis, model, time_ms, tokens, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          [hash, JSON.stringify(result.analysis), result.model, result.timeToProcess, result.tokens, Date.now()]
        ).catch(() => {});
        broadcast({ action: 'aiComplete', model: result.model, timeMs: result.timeToProcess, tokens: result.tokens, cacheSize: aiCache.size });
      } else {
        aiErrorCount++;
        broadcast({ action: 'aiError', error: result.error, totalErrors: aiErrorCount });
      }
      resolve(result);
      drainAIQueue();
    });
  }
}

const AI_PROMPT = (text) => [
  'You are a job post analyzer. Analyze the following LinkedIn post and extract structured information.',
  'Respond ONLY with a valid JSON object - no markdown, no explanation, no code fences.',
  'Post text:',
  text.substring(0, 1500),
  'JSON schema to fill:',
  '{',
  '  "jobTitles": ["role1", "role2"] or null,',
  '  "visaSponsorship": "short summary or null",',
  '  "confidence": 0-100',
  '}',
  'For jobTitles: Extract all distinct roles as an array. If none, return null.',
  'For visaSponsorship: Extract exactly what visa statuses are mentioned. If none, return null.',
].join('\n');

async function runOllama(text, baseUrl, model) {
  const startTime = Date.now();
  try {
    const r = await fetch(`${baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: AI_PROMPT(text), stream: false, format: 'json' }),
    });
    const rawText = await r.text();
    if (!r.ok) {
      return { error: /context|too long|exceeds/i.test(rawText) ? 'context_too_long' : `Ollama ${r.status}` };
    }
    const data = JSON.parse(rawText);
    if (!data.response) return { error: 'context_too_long' };
    const parsed = JSON.parse(data.response);
    return {
      success: true,
      analysis: parsed,
      timeToProcess: Date.now() - startTime,
      model,
      tokens: (data.prompt_eval_count || 0) + (data.eval_count || 0),
    };
  } catch (err) {
    return { error: err.message };
  }
}

// ---- Routes -----------------------------------------------------------------

// POST /save — atomic dedup + persist
app.post('/save', async (req, res) => {
  try {
    const { match, userName, fromPeer } = req.body;
    if (!match?.id) return res.status(400).json({ error: 'missing match.id' });

    if (match.url) {
      const existing = await db.get('SELECT id, notion_page_id FROM matches WHERE url = ?', [match.url]);
      if (existing) {
        if (!fromPeer) duplicatesBlocked++;
        return res.json({ duplicate: true, matchId: existing.id, notionPageId: existing.notion_page_id || null });
      }
    }

    const now = Date.now();
    await db.run(
      'INSERT OR IGNORE INTO matches (id, url, saved_by, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [match.id, match.url || null, userName || null, JSON.stringify(match), now, now]
    );

    broadcast({ action: 'newMatch', url: match.url, savedBy: userName || null });
    res.json({ saved: true, matchId: match.id });

    // Forward to peers async after responding — don't block the caller
    if (!fromPeer) forwardToPeers('/save', 'POST', { match, userName, fromPeer: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /sync — peer pull: all rows updated since ?since=<timestamp>
app.get('/sync', async (req, res) => {
  try {
    const since = parseInt(req.query.since) || 0;
    const rows = await db.all(
      'SELECT id, url, notion_page_id, saved_by, data, created_at, updated_at FROM matches WHERE updated_at > ? ORDER BY updated_at ASC',
      [since]
    );
    res.json({ matches: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /matches — recent matches (for local cache rebuild on extension load)
app.get('/matches', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 200, 500);
    const rows = await db.all(
      'SELECT id, url, notion_page_id, saved_by, data FROM matches ORDER BY created_at DESC LIMIT ?',
      [limit]
    );
    res.json(rows.map(r => {
      const d = JSON.parse(r.data);
      return { ...d, notionPageId: r.notion_page_id || d.notionPageId, savedBy: r.saved_by };
    }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /notion-page-id — store notionPageId once extension Notion sync completes
app.patch('/notion-page-id', async (req, res) => {
  try {
    const { url, matchId, notionPageId, fromPeer } = req.body;
    if (!notionPageId) return res.status(400).json({ error: 'missing notionPageId' });
    await db.run(
      'UPDATE matches SET notion_page_id = ?, updated_at = ? WHERE url = ? OR id = ?',
      [notionPageId, Date.now(), url || null, matchId || null]
    );
    res.json({ success: true });
    if (!fromPeer) forwardToPeers('/notion-page-id', 'PATCH', { url, matchId, notionPageId, fromPeer: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /status — update match status in local DB
app.patch('/status', async (req, res) => {
  try {
    const { url, matchId, status } = req.body;
    if (!status) return res.status(400).json({ error: 'missing status' });
    await db.run(
      'UPDATE matches SET updated_at = ? WHERE url = ? OR id = ?',
      [Date.now(), url || null, matchId || null]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /ai — shared Ollama analysis with hash-based dedup
app.post('/ai', async (req, res) => {
  const {
    text, hash,
    ollamaUrl   = 'http://localhost:11434',
    ollamaModel = 'gemma3',
  } = req.body;
  if (!text || !hash) return res.status(400).json({ error: 'missing text or hash' });

  if (aiCache.has(hash)) {
    return res.json({ success: true, analysis: aiCache.get(hash), skipped: true });
  }

  const result = await new Promise(resolve => {
    aiQueue.push({ hash, text, ollamaUrl: ollamaUrl.replace(/\/$/, ''), ollamaModel, resolve });
    drainAIQueue();
  });

  res.json(result);
});

// GET /health
app.get('/health', async (req, res) => {
  try {
    const row = await db.get('SELECT COUNT(*) as n FROM matches');
    res.json({ ok: true, matches: row.n, aiCacheSize: aiCache.size, wsClients: clients.size, peers: PEERS.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /stats — detailed stats for dashboard
app.get('/stats', async (req, res) => {
  try {
    const todayCutoff = new Date(); todayCutoff.setHours(0,0,0,0);
    const since24h = Date.now() - 24 * 60 * 60 * 1000;
    const [total, notion, today, byUser, hourlyRows] = await Promise.all([
      db.get('SELECT COUNT(*) as n FROM matches'),
      db.get('SELECT COUNT(*) as n FROM matches WHERE notion_page_id IS NOT NULL'),
      db.get('SELECT COUNT(*) as n FROM matches WHERE created_at >= ?', [todayCutoff.getTime()]),
      db.all('SELECT saved_by, COUNT(*) as n, MAX(created_at) as last_saved FROM matches WHERE saved_by IS NOT NULL GROUP BY saved_by ORDER BY n DESC'),
      db.all('SELECT created_at FROM matches WHERE created_at >= ? ORDER BY created_at ASC', [since24h]),
    ]);

    // Bucket into 24 hourly slots
    const hourly = new Array(24).fill(0);
    const now = Date.now();
    for (const { created_at } of hourlyRows) {
      const hoursAgo = Math.floor((now - created_at) / (60 * 60 * 1000));
      if (hoursAgo >= 0 && hoursAgo < 24) hourly[23 - hoursAgo]++;
    }

    let dbSize = 0;
    try { dbSize = fs.statSync(DB_PATH).size; } catch (_) {}

    res.json({
      totalMatches: total.n, withNotion: notion.n, todayMatches: today.n,
      notSynced: total.n - notion.n,
      notionSyncPct: total.n > 0 ? Math.round((notion.n / total.n) * 100) : 0,
      aiCacheSize: aiCache.size, aiQueueDepth: aiQueue.length, aiActive: aiActive > 0,
      aiErrors: aiErrorCount,
      duplicatesBlocked,
      dbSize,
      wsClients: clients.size,
      uptime: Math.floor(process.uptime()),
      peers: PEERS,
      byUser,
      hourlyMatches: hourly,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /ollama-status — check if Ollama is reachable and list models
app.get('/ollama-status', async (req, res) => {
  const { ollamaUrl = 'http://localhost:11434' } = req.query;
  try {
    const r = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return res.json({ reachable: false });
    const data = await r.json();
    res.json({ reachable: true, models: (data.models || []).map(m => m.name) });
  } catch (_) {
    res.json({ reachable: false, models: [] });
  }
});

// GET /dashboard — real-time web dashboard
app.get('/dashboard', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(DASHBOARD_HTML(PORT));
});
app.get('/', (req, res) => res.redirect('/dashboard'));

function DASHBOARD_HTML(port) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DevOps Scanner — Dashboard</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh}
header{background:#1e293b;border-bottom:1px solid #334155;padding:16px 24px;display:flex;align-items:center;gap:12px}
header h1{font-size:18px;font-weight:700;color:#f8fafc}
.dot{width:10px;height:10px;border-radius:50%;background:#22c55e;animation:pulse 2s infinite;flex-shrink:0}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.dot.offline{background:#ef4444;animation:none}
.header-meta{margin-left:auto;font-size:11px;color:#64748b;display:flex;gap:16px}
.grid{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;padding:20px 24px 0}
@media(max-width:900px){.grid{grid-template-columns:repeat(3,1fr)}}
.card{background:#1e293b;border:1px solid #334155;border-radius:10px;padding:16px}
.card-label{font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px}
.card-value{font-size:30px;font-weight:700;line-height:1}
.card-value.green{color:#22c55e}
.card-value.blue{color:#60a5fa}
.card-value.purple{color:#a78bfa}
.card-value.yellow{color:#fbbf24}
.card-value.red{color:#f87171}
.card-sub{font-size:11px;color:#64748b;margin-top:4px}
.card-sub.warn{color:#fbbf24}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:12px 24px 20px}
@media(max-width:700px){.cols{grid-template-columns:1fr}}
.panel{background:#1e293b;border:1px solid #334155;border-radius:10px;overflow:hidden}
.panel-header{padding:12px 16px;border-bottom:1px solid #334155;font-size:13px;font-weight:600;display:flex;align-items:center;justify-content:space-between}
.panel-header .badge{font-size:10px;background:#334155;color:#94a3b8;padding:2px 8px;border-radius:10px}
.feed{height:300px;overflow-y:auto;padding:8px 0}
.feed-item{padding:7px 12px 7px 0;border-bottom:1px solid #1e293b;font-size:12px;display:flex;gap:8px;align-items:flex-start;animation:fadeIn .3s;border-left:3px solid transparent}
@keyframes fadeIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
.feed-item .ts{color:#475569;flex-shrink:0;font-size:10px;margin-top:1px;width:54px;padding-left:10px}
.feed-item .msg{color:#cbd5e1;flex:1;line-height:1.4}
.feed-item .label{flex-shrink:0;font-size:10px;font-weight:600;width:34px;text-align:right}
.tag-save{border-left-color:#22c55e}.tag-save .label{color:#22c55e}
.tag-ai{border-left-color:#a78bfa}.tag-ai .label{color:#a78bfa}
.tag-err{border-left-color:#f87171}.tag-err .label{color:#f87171}
.tag-conn{border-left-color:#38bdf8}.tag-conn .label{color:#38bdf8}
.users-list{padding:10px 16px}
.user-row{display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid #0f172a}
.user-row:last-child{border-bottom:none}
.user-avatar{width:28px;height:28px;border-radius:50%;background:#334155;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#94a3b8;flex-shrink:0}
.user-name{font-size:13px;color:#e2e8f0;flex:1}
.user-meta{text-align:right}
.user-count{font-size:12px;color:#64748b}
.user-last{font-size:10px;color:#475569}
.ai-section{padding:12px 16px}
.ai-row{display:flex;align-items:center;gap:8px;margin-bottom:8px;font-size:12px}
.ai-row label{color:#64748b;width:100px;flex-shrink:0}
.ai-divider{border:none;border-top:1px solid #334155;margin:10px 0}
.bar{flex:1;background:#0f172a;border-radius:4px;height:6px;overflow:hidden}
.bar-fill{height:100%;border-radius:4px;transition:width .4s}
.bar-fill.blue{background:#60a5fa}
.ollama-badge{display:inline-flex;align-items:center;gap:5px;font-size:11px;padding:2px 8px;border-radius:10px;font-weight:600}
.ollama-badge.ok{background:#14532d;color:#86efac}
.ollama-badge.err{background:#450a0a;color:#fca5a5}
.sparkline-wrap{padding:10px 16px 14px}
.spark-label{font-size:10px;color:#475569;margin-top:6px}
canvas#sparkline{width:100%;height:48px;display:block}
</style>
</head>
<body>
<header>
  <div class="dot" id="conn-dot"></div>
  <h1>🔍 DevOps Scanner</h1>
  <div class="header-meta">
    <span id="uptime-label"></span>
    <span id="dbsize-label"></span>
    <span id="peers-label"></span>
  </div>
</header>

<div class="grid">
  <div class="card"><div class="card-label">Total Matches</div><div class="card-value green" id="s-total">—</div><div class="card-sub" id="s-today"></div></div>
  <div class="card"><div class="card-label">Notion Synced</div><div class="card-value blue" id="s-notion">—</div><div class="card-sub" id="s-notion-sub"></div></div>
  <div class="card"><div class="card-label">AI Cache</div><div class="card-value purple" id="s-cache">—</div></div>
  <div class="card"><div class="card-label">AI Errors</div><div class="card-value red" id="s-aierrors">—</div></div>
  <div class="card"><div class="card-label">Online Users</div><div class="card-value yellow" id="s-clients">—</div></div>
</div>

<div class="cols">
  <div class="panel">
    <div class="panel-header">Live Activity <span class="badge" id="feed-count">0 events</span></div>
    <div class="feed" id="feed"></div>
  </div>
  <div style="display:flex;flex-direction:column;gap:12px">
    <div class="panel">
      <div class="panel-header">Saves — last 24h</div>
      <div class="sparkline-wrap">
        <canvas id="sparkline" height="48"></canvas>
        <div class="spark-label" id="spark-label"></div>
      </div>
    </div>
    <div class="panel">
      <div class="panel-header">Users</div>
      <div class="users-list" id="users-list"><span style="font-size:12px;color:#475569">No data yet</span></div>
    </div>
    <div class="panel">
      <div class="panel-header">AI Engine</div>
      <div class="ai-section">
        <div class="ai-row"><label>Ollama</label><span id="ollama-badge"><span class="ollama-badge err">checking…</span></span></div>
        <div class="ai-row"><label>Models</label><span style="color:#94a3b8;font-size:11px" id="lbl-models">—</span></div>
        <div class="ai-row"><label>Notion sync</label><div class="bar"><div class="bar-fill blue" id="bar-notion" style="width:0%"></div></div><span id="lbl-notion-bar" style="font-size:11px;color:#64748b;width:32px;text-align:right">—</span></div>
        <hr class="ai-divider">
        <div class="ai-row"><label>Queue depth</label><span style="color:#fb923c;font-weight:700" id="s-queue">—</span><span style="color:#64748b;font-size:11px;margin-left:8px" id="s-queue-status"></span></div>
        <div class="ai-row"><label>Duplicates</label><span style="color:#64748b" id="s-dups">—</span></div>
        <div class="ai-row"><label>Last job</label><span style="color:#94a3b8" id="lbl-lastjob">—</span></div>
        <div class="ai-row"><label>Last model</label><span style="color:#94a3b8" id="lbl-model">—</span></div>
        <div class="ai-row"><label>Last tokens</label><span style="color:#94a3b8" id="lbl-tokens">—</span></div>
      </div>
    </div>
  </div>
</div>

<script>
const WS_URL = 'ws://' + location.host + '/ws';
let ws, feedCount = 0;

function fmt(ms) {
  if (ms < 1000) return ms + 'ms';
  return (ms/1000).toFixed(1) + 's';
}
function fmtUptime(s) {
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = s%60;
  return h ? h+'h '+m+'m' : m ? m+'m '+sec+'s' : sec+'s';
}
function fmtSize(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024*1024) return (b/1024).toFixed(1) + ' KB';
  return (b/(1024*1024)).toFixed(2) + ' MB';
}
function ago(ts) {
  const d = Math.floor((Date.now()-ts)/1000);
  return d < 60 ? d+'s ago' : d < 3600 ? Math.floor(d/60)+'m ago' : Math.floor(d/3600)+'h ago';
}

function addFeedItem(tag, tagClass, msg) {
  const feed = document.getElementById('feed');
  feedCount++;
  document.getElementById('feed-count').textContent = feedCount + ' events';
  const ts = new Date().toLocaleTimeString('en-US',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const el = document.createElement('div');
  el.className = 'feed-item ' + tagClass;
  el.innerHTML = '<span class="ts">'+ts+'</span><span class="msg">'+msg+'</span><span class="label">'+tag+'</span>';
  feed.prepend(el);
  while (feed.children.length > 200) feed.removeChild(feed.lastChild);
}

function drawSparkline(hourly) {
  const canvas = document.getElementById('sparkline');
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.offsetWidth, H = 48;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const max = Math.max(...hourly, 1);
  const barW = Math.floor(W / hourly.length) - 1;
  ctx.clearRect(0, 0, W, H);
  hourly.forEach((v, i) => {
    const bh = Math.max(2, Math.round((v / max) * (H - 6)));
    const x = i * (barW + 1);
    ctx.fillStyle = i >= hourly.length - 3 ? '#22c55e' : '#334155';
    ctx.beginPath();
    ctx.roundRect(x, H - bh, barW, bh, 2);
    ctx.fill();
  });
  const total = hourly.reduce((a,b)=>a+b,0);
  document.getElementById('spark-label').textContent = total + ' saves · peak ' + max + '/hr';
}

async function checkPeers(peers) {
  if (!peers || !peers.length) {
    document.getElementById('peers-label').textContent = '';
    return;
  }
  const results = await Promise.all(peers.map(async p => {
    try {
      const r = await fetch(p + '/health', { signal: AbortSignal.timeout(3000) });
      return { url: p, ok: r.ok };
    } catch (_) { return { url: p, ok: false }; }
  }));
  const online = results.filter(r => r.ok).length;
  const label = document.getElementById('peers-label');
  label.textContent = 'peers: ' + online + '/' + peers.length;
  label.style.color = online === peers.length ? '#64748b' : '#f87171';
}

function loadOllamaStatus() {
  fetch('/ollama-status').then(r => r.json()).then(d => {
    const badge = document.getElementById('ollama-badge');
    badge.innerHTML = d.reachable
      ? '<span class="ollama-badge ok">● online</span>'
      : '<span class="ollama-badge err">✕ unreachable</span>';
    document.getElementById('lbl-models').textContent = d.reachable ? ((d.models||[]).join(', ') || 'none') : '—';
  }).catch(()=>{});
}

function loadStats() {
  fetch('/stats').then(r=>r.json()).then(d => {
    document.getElementById('s-total').textContent = d.totalMatches;
    document.getElementById('s-today').textContent = d.todayMatches + ' today';
    document.getElementById('s-notion').textContent = d.withNotion;
    document.getElementById('s-notion-sub').textContent = d.notionSyncPct + '% synced' + (d.notSynced > 0 ? ' · ' + d.notSynced + ' pending' : '');
    if (d.notSynced > 0) document.getElementById('s-notion-sub').className = 'card-sub warn';
    else document.getElementById('s-notion-sub').className = 'card-sub';
    document.getElementById('s-cache').textContent = d.aiCacheSize;
    document.getElementById('s-aierrors').textContent = d.aiErrors;
    document.getElementById('s-clients').textContent = d.wsClients;
    document.getElementById('s-queue').textContent = d.aiQueueDepth;
    document.getElementById('s-queue-status').textContent = d.aiActive ? 'running' : d.aiQueueDepth > 0 ? 'queued' : 'idle';
    document.getElementById('s-dups').textContent = d.duplicatesBlocked + ' blocked';
    document.getElementById('uptime-label').textContent = 'up ' + fmtUptime(d.uptime);
    document.getElementById('dbsize-label').textContent = fmtSize(d.dbSize || 0);
    document.getElementById('bar-notion').style.width = d.notionSyncPct + '%';
    document.getElementById('lbl-notion-bar').textContent = d.notionSyncPct + '%';

    const ul = document.getElementById('users-list');
    if (!d.byUser || d.byUser.length === 0) {
      ul.innerHTML = '<span style="font-size:12px;color:#475569">No saves yet</span>';
    } else {
      ul.innerHTML = d.byUser.map(u => {
        const init = (u.saved_by||'?').charAt(0).toUpperCase();
        const lastSeen = u.last_saved ? ago(u.last_saved) : '—';
        return '<div class="user-row"><div class="user-avatar">'+init+'</div><div class="user-name">'+(u.saved_by||'Unknown')+'</div><div class="user-meta"><div class="user-count">'+u.n+' saves</div><div class="user-last">'+lastSeen+'</div></div></div>';
      }).join('');
    }

    if (d.hourlyMatches) drawSparkline(d.hourlyMatches);
    if (d.peers) checkPeers(d.peers);
  }).catch(()=>{});
}

function connectWS() {
  ws = new WebSocket(WS_URL);
  const dot = document.getElementById('conn-dot');

  ws.onopen = () => {
    dot.className = 'dot';
    addFeedItem('CONN', 'tag-conn', 'Connected to server');
    loadStats();
    loadOllamaStatus();
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.action === 'newMatch') {
      const by = msg.savedBy ? ' by <b>'+msg.savedBy+'</b>' : '';
      const urlShort = msg.url ? msg.url.replace('https://www.linkedin.com/','…/') : 'unknown';
      addFeedItem('SAVE', 'tag-save', 'New match'+by+' — <span style="color:#475569">'+urlShort+'</span>');
      loadStats();
    } else if (msg.action === 'aiStart') {
      addFeedItem('AI', 'tag-ai', 'Ollama started · queue: '+msg.queueDepth);
      document.getElementById('s-queue').textContent = msg.queueDepth;
      document.getElementById('s-queue-status').textContent = 'running';
    } else if (msg.action === 'aiComplete') {
      const t = fmt(msg.timeMs);
      addFeedItem('DONE', 'tag-ai', msg.model+' · '+t+' · '+msg.tokens+' tok');
      document.getElementById('s-cache').textContent = msg.cacheSize;
      document.getElementById('s-queue-status').textContent = 'idle';
      document.getElementById('lbl-lastjob').textContent = t;
      document.getElementById('lbl-model').textContent = msg.model;
      document.getElementById('lbl-tokens').textContent = msg.tokens;
    } else if (msg.action === 'aiError') {
      addFeedItem('ERR', 'tag-err', 'AI error: '+msg.error);
      document.getElementById('s-queue-status').textContent = 'idle';
      document.getElementById('s-aierrors').textContent = msg.totalErrors || '?';
    }
  };

  ws.onclose = () => {
    dot.className = 'dot offline';
    addFeedItem('DISC', 'tag-err', 'Disconnected — reconnecting…');
    setTimeout(connectWS, 3000);
  };
  ws.onerror = () => ws.close();
}

connectWS();
setInterval(loadStats, 15000);
setInterval(loadOllamaStatus, 30000);
</script>
</body>
</html>`;
}

// ---- Start ------------------------------------------------------------------

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[DevOps Scanner] Server listening on port ${PORT}`);
  console.log(`[DevOps Scanner] DB: ${DB_PATH}`);
  console.log(`[DevOps Scanner] Health: http://localhost:${PORT}/health`);
});
