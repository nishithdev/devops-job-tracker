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

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3747;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'scanner.db');

// ---- Helpers ----------------------------------------------------------------

// Must stay identical to hashText in background.js — cache keys are shared
function hashText(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h) ^ str.charCodeAt(i);
  return (h >>> 0).toString(36);
}

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

  CREATE TABLE IF NOT EXISTS ai_requests (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    hash       TEXT,
    model      TEXT,
    tokens     INTEGER,
    time_ms    INTEGER,
    cached     INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ai_queue (
    hash        TEXT PRIMARY KEY,
    text        TEXT NOT NULL,
    ollama_url  TEXT NOT NULL,
    ollama_model TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_ai_requests_created ON ai_requests(created_at);
  CREATE INDEX IF NOT EXISTS idx_matches_created ON matches(created_at);
  CREATE INDEX IF NOT EXISTS idx_matches_saved_by ON matches(saved_by);
  CREATE INDEX IF NOT EXISTS idx_ai_cache_created ON ai_cache(created_at);
  CREATE INDEX IF NOT EXISTS idx_ai_queue_created ON ai_queue(created_at);
`).catch(err => { console.error('DB init error:', err); process.exit(1); });

// ---- Express ----------------------------------------------------------------

const app = express();
app.use(express.json({ limit: '50mb' }));

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
const eventLog = [];
const EVENT_LOG_MAX = 200;

function logEvent(msg) {
  eventLog.push({ ...msg, _ts: Date.now() });
  if (eventLog.length > EVENT_LOG_MAX) eventLog.shift();
}

wss.on('connection', (ws) => {
  clients.add(ws);
  // Replay recent events so the feed survives refreshes
  if (eventLog.length) ws.send(JSON.stringify({ action: 'replay', events: eventLog }));
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

function broadcast(msg) {
  logEvent(msg);
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
let aiActiveHash = null;
const aiQueue = [];

// Recent failures so pollers can distinguish "failed" from "still pending"
const aiFailures = new Map(); // hash → { error, ts }
const AI_FAILURE_TTL = 10 * 60_000;

function recordAIFailure(hash, error) {
  aiFailures.set(hash, { error, ts: Date.now() });
  for (const [h, f] of aiFailures) {
    if (Date.now() - f.ts > AI_FAILURE_TTL) aiFailures.delete(h);
  }
}

function drainAIQueue() {
  while (aiActive < 1 && aiQueue.length) {
    aiActive++;
    const { hash, text, ollamaUrl, ollamaModel, resolve } = aiQueue.shift();
    aiActiveHash = hash;
    broadcast({ action: 'aiStart', queueDepth: aiQueue.length, hash: hash.slice(0, 8) });
    runOllama(text, ollamaUrl, ollamaModel).then(result => {
      aiActive--;
      aiActiveHash = null;
      // Remove from persistent queue regardless of outcome
      db.run('DELETE FROM ai_queue WHERE hash = ?', [hash]).catch(() => {});
      if (result.success) {
        aiCache.set(hash, result.analysis);
        db.run(
          'INSERT OR REPLACE INTO ai_cache (text_hash, analysis, model, time_ms, tokens, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          [hash, JSON.stringify(result.analysis), result.model, result.timeToProcess, result.tokens, Date.now()]
        ).catch(() => {});
        db.run(
          'INSERT INTO ai_requests (hash, model, tokens, time_ms, cached, created_at) VALUES (?, ?, ?, ?, 0, ?)',
          [hash, result.model, result.tokens, result.timeToProcess, Date.now()]
        ).catch(() => {});
        broadcast({ action: 'aiComplete', model: result.model, timeMs: result.timeToProcess, tokens: result.tokens, cacheSize: aiCache.size });
      } else {
        recordAIFailure(hash, result.error);
        broadcast({ action: 'aiError', error: result.error });
      }
      resolve(result);
      drainAIQueue();
    });
  }
}

// Restore persisted AI queue on startup (survives Docker restarts)
db.all('SELECT hash, text, ollama_url, ollama_model FROM ai_queue ORDER BY created_at').then(rows => {
  if (!rows.length) return;
  console.log(`[DevOps Scanner] Restoring ${rows.length} AI jobs from queue`);
  for (const row of rows) {
    // Skip if already cached
    if (aiCache.has(row.hash)) {
      db.run('DELETE FROM ai_queue WHERE hash = ?', [row.hash]).catch(() => {});
      continue;
    }
    aiQueue.push({
      hash: row.hash,
      text: row.text,
      ollamaUrl: row.ollama_url,
      ollamaModel: row.ollama_model,
      resolve: () => {}, // fire-and-forget on restore
    });
  }
  drainAIQueue();
}).catch(() => {});

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
    const { match, userName } = req.body;
    if (!match?.id) return res.status(400).json({ error: 'missing match.id' });
    // Extension sends notionUserName or stable deviceId UUID — no IP fallback needed
    const resolvedUser = userName || null;
    const notionPageId = match.notionPageId || null;
    const now = Date.now();

    if (match.url) {
      const existing = await db.get('SELECT id, notion_page_id FROM matches WHERE url = ?', [match.url]);
      if (existing) {
        // Backfill notion_page_id when this client knows it and the row doesn't —
        // covers a lost /notion-page-id PATCH (server was down) and a second user
        // whose extension finished the Notion sync first.
        if (!existing.notion_page_id && notionPageId) {
          await db.run('UPDATE matches SET notion_page_id = ?, updated_at = ? WHERE id = ?', [notionPageId, now, existing.id]);
        }
        return res.json({ duplicate: true, matchId: existing.id, notionPageId: existing.notion_page_id || notionPageId });
      }
    }

    await db.run(
      'INSERT OR IGNORE INTO matches (id, url, notion_page_id, saved_by, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [match.id, match.url || null, notionPageId, resolvedUser, JSON.stringify(match), now, now]
    );
    // INSERT OR IGNORE keeps the old row when this id was saved before (retry
    // of a match first saved without a notionPageId) — backfill it.
    if (notionPageId) {
      await db.run('UPDATE matches SET notion_page_id = ?, updated_at = ? WHERE id = ? AND notion_page_id IS NULL', [notionPageId, now, match.id]);
    }

    _chartCache.clear(); // invalidate so next /chart-data fetch reflects this save
    broadcast({ action: 'newMatch', url: match.url, savedBy: resolvedUser });
    res.json({ saved: true, matchId: match.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- Diagnostic post capture --------------------------------------------------
// Extension posts every classified post here when diagnostic capture is enabled
// (Settings → Diagnostics). Appended as JSONL to diagnostics/posts.jsonl so the
// records can be grepped/replayed offline when debugging misclassifications.
const DIAG_DIR  = path.join(__dirname, 'diagnostics');
const DIAG_FILE = path.join(DIAG_DIR, 'posts.jsonl');

app.post('/diag', (req, res) => {
  try {
    if (!req.body || !req.body.time) return res.status(400).json({ error: 'missing record' });
    fs.mkdirSync(DIAG_DIR, { recursive: true });
    fs.appendFileSync(DIAG_FILE, JSON.stringify(req.body) + '\n');
    res.json({ saved: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /diag?limit=N — last N captured records (newest last)
app.get('/diag', (req, res) => {
  try {
    if (!fs.existsSync(DIAG_FILE)) return res.json([]);
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    const lines = fs.readFileSync(DIAG_FILE, 'utf8').trim().split('\n').filter(Boolean);
    res.json(lines.slice(-limit).map(l => JSON.parse(l)));
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
    const { url, matchId, notionPageId } = req.body;
    if (!notionPageId) return res.status(400).json({ error: 'missing notionPageId' });
    await db.run(
      'UPDATE matches SET notion_page_id = ?, updated_at = ? WHERE url = ? OR id = ?',
      [notionPageId, Date.now(), url || null, matchId || null]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /status — update match status in local DB
app.patch('/status', async (req, res) => {
  try {
    const { url, matchId, status } = req.body;
    if (!status) return res.status(400).json({ error: 'missing status' });
    const row = await db.get('SELECT id, data FROM matches WHERE url = ? OR id = ?', [url || null, matchId || null]);
    if (!row) return res.status(404).json({ error: 'match not found' });
    const data = JSON.parse(row.data);
    data.status = status;
    await db.run(
      'UPDATE matches SET data = ?, updated_at = ? WHERE id = ?',
      [JSON.stringify(data), Date.now(), row.id]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /ai — shared Ollama analysis with hash-based dedup
app.post('/ai', async (req, res) => {
  const {
    text, hash, force,
    ollamaUrl   = 'http://localhost:11434',
    ollamaModel = 'qwen2.5:0.5b',
  } = req.body;
  if (!text || !hash) return res.status(400).json({ error: 'missing text or hash' });

  // force = re-scan request: evict cached analysis so the job runs fresh.
  // Must clear before the queued job completes — GET /ai/:hash serves aiCache first.
  if (force) {
    aiCache.delete(hash);
    db.run('DELETE FROM ai_cache WHERE text_hash = ?', [hash]).catch(() => {});
  }

  if (aiCache.has(hash)) {
    const cached = aiCache.get(hash);
    db.run(
      'INSERT INTO ai_requests (hash, model, tokens, time_ms, cached, created_at) VALUES (?, ?, ?, ?, 1, ?)',
      [hash, null, null, null, Date.now()]
    ).catch(() => {});
    return res.json({ success: true, analysis: cached, skipped: true });
  }

  const cleanUrl = ollamaUrl.replace(/\/$/, '');
  // Persist job before enqueuing — survives restart
  await db.run(
    'INSERT OR IGNORE INTO ai_queue (hash, text, ollama_url, ollama_model, created_at) VALUES (?, ?, ?, ?, ?)',
    [hash, text, cleanUrl, ollamaModel, Date.now()]
  ).catch(() => {});

  // Don't hold the HTTP request open for the whole queue — client polls GET /ai/:hash
  if (aiActiveHash !== hash && !aiQueue.some(j => j.hash === hash)) {
    aiFailures.delete(hash); // re-request clears stale failure
    aiQueue.push({ hash, text, ollamaUrl: cleanUrl, ollamaModel, resolve: () => {} });
    drainAIQueue();
  }
  res.status(202).json({ queued: true, hash });
});

// GET /ai/:hash — poll analysis result after a queued POST /ai
app.get('/ai/:hash', (req, res) => {
  const { hash } = req.params;
  if (aiCache.has(hash)) return res.json({ success: true, analysis: aiCache.get(hash) });
  if (aiActiveHash === hash || aiQueue.some(j => j.hash === hash)) return res.json({ pending: true });
  const failure = aiFailures.get(hash);
  if (failure) return res.json({ error: failure.error });
  res.status(404).json({ error: 'unknown hash' });
});

// GET /health
app.get('/health', async (req, res) => {
  try {
    const row = await db.get('SELECT COUNT(*) as n FROM matches');
    res.json({ ok: true, matches: row.n, aiCacheSize: aiCache.size, wsClients: clients.size });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /stats — detailed stats for dashboard
app.get('/stats', async (req, res) => {
  try {
    const todayCutoff = new Date(); todayCutoff.setHours(0,0,0,0);
    const [total, notion, today, byUser] = await Promise.all([
      db.get('SELECT COUNT(*) as n FROM matches'),
      db.get('SELECT COUNT(*) as n FROM matches WHERE notion_page_id IS NOT NULL'),
      db.get('SELECT COUNT(*) as n FROM matches WHERE created_at >= ?', [todayCutoff.getTime()]),
      db.all(`SELECT saved_by, COUNT(*) as n, MAX(created_at) as last_saved,
              SUM(CASE WHEN notion_page_id IS NULL THEN 1 ELSE 0 END) as unsynced
              FROM matches WHERE saved_by IS NOT NULL GROUP BY saved_by ORDER BY n DESC`),
    ]);
    res.json({
      totalMatches: total.n, withNotion: notion.n, todayMatches: today.n,
      aiCacheSize: aiCache.size, aiQueueDepth: aiQueue.length, aiActive: aiActive > 0,
      wsClients: clients.size,
      uptime: Math.floor(process.uptime()),
      byUser,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// In-memory TTL cache for /chart-data — recalculating 4 GROUP BY aggregations every 30s is wasteful
const _chartCache = new Map(); // key: days → { data, expiresAt }
const CHART_CACHE_TTL = 10000; // 10s

// GET /chart-data — time-series and AI breakdown for dashboard charts
app.get('/chart-data', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 14;
    const cached = _chartCache.get(days);
    if (cached && cached.expiresAt > Date.now()) return res.json(cached.data);
    const cutoff = Date.now() - days * 86400000;

    const [saveRows, notionRows, aiRows, modelRows, sourceRows] = await Promise.all([
      db.all(
        `SELECT date(created_at/1000,'unixepoch') as d, COUNT(*) as n
         FROM matches WHERE created_at >= ? GROUP BY d ORDER BY d`,
        [cutoff]
      ),
      db.all(
        `SELECT date(created_at/1000,'unixepoch') as d, COUNT(*) as n
         FROM matches WHERE created_at >= ? AND notion_page_id IS NOT NULL GROUP BY d ORDER BY d`,
        [cutoff]
      ),
      db.all(
        `SELECT date(created_at/1000,'unixepoch') as d,
                COUNT(*) as total,
                SUM(cached) as hits
         FROM ai_requests WHERE created_at >= ? GROUP BY d ORDER BY d`,
        [cutoff]
      ),
      db.all(
        `SELECT model, COUNT(*) as n, AVG(tokens) as avgTokens, AVG(time_ms) as avgMs
         FROM ai_requests WHERE cached=0 AND model IS NOT NULL GROUP BY model ORDER BY n DESC`
      ),
      // All-time saves bucketed by source page (group id / feed / search / jobs),
      // extracted from the sourceUrl stored inside the match JSON
      db.all(
        `SELECT
           CASE
             WHEN json_extract(data,'$.sourceUrl') LIKE '%/groups/%'
               THEN 'group:' || CAST(substr(json_extract(data,'$.sourceUrl'), instr(json_extract(data,'$.sourceUrl'),'/groups/')+8) AS INTEGER)
             WHEN json_extract(data,'$.sourceUrl') LIKE '%/feed%'   THEN 'feed'
             WHEN json_extract(data,'$.sourceUrl') LIKE '%/search%' THEN 'search'
             WHEN json_extract(data,'$.sourceUrl') LIKE '%/jobs%'   THEN 'jobs'
             ELSE 'other'
           END AS source,
           COUNT(*) AS total,
           SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS last7,
           MAX(created_at) AS lastSaved
         FROM matches GROUP BY source ORDER BY total DESC`,
        [Date.now() - 7 * 86400000]
      ),
    ]);

    // Build label array for last N days
    const labels = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      labels.push(d.toISOString().slice(0, 10));
    }
    const toMap = rows => Object.fromEntries(rows.map(r => [r.d, r]));
    const saveMap   = toMap(saveRows);
    const notionMap = toMap(notionRows);
    const aiMap     = toMap(aiRows);

    const payload = {
      labels,
      saves:       labels.map(d => saveMap[d]?.n   || 0),
      notionSynced:labels.map(d => notionMap[d]?.n || 0),
      analyzed:    labels.map(d => aiMap[d]?.total  || 0),
      cacheHits:   labels.map(d => aiMap[d]?.hits   || 0),
      byModel: modelRows.map(r => ({
        model: r.model,
        n: r.n,
        avgTokens: Math.round(r.avgTokens || 0),
        avgMs: Math.round(r.avgMs || 0),
      })),
      bySource: sourceRows,
    };
    _chartCache.set(days, { data: payload, expiresAt: Date.now() + CHART_CACHE_TTL });
    res.json(payload);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- Notion sync reconciliation ----------------------------------------------
// notion_page_id in SQLite is only as fresh as the last PATCH an extension
// managed to deliver, so "unsynced" counts drift after a lost PATCH, a server
// restart mid-sync, or a user without a Notion token. Reconcile re-derives the
// state from Notion itself: backfills rows whose URL already has a page, and
// clears IDs whose page was deleted/archived in Notion.
async function reconcileNotionSync() {
  const token = process.env.NOTION_TOKEN;
  const dbId  = process.env.NOTION_DB_ID;
  if (!token || !dbId) return { skipped: true, reason: 'NOTION_TOKEN and NOTION_DB_ID env vars required on server' };

  const nHeaders = {
    'Authorization': `Bearer ${token}`,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json',
  };

  // One paginated pass over the DB (query returns non-archived pages only)
  const pageIds = new Set();
  const byUrl = new Map();
  let cursor;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, { method: 'POST', headers: nHeaders, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`Notion query ${r.status}: ${await r.text()}`);
    const d = await r.json();
    for (const p of d.results) {
      pageIds.add(p.id);
      const url = p.properties?.URL?.url;
      if (url && !byUrl.has(url)) byUrl.set(url, p.id);
    }
    cursor = d.has_more ? d.next_cursor : null;
  } while (cursor);

  const rows = await db.all('SELECT id, url, notion_page_id FROM matches');
  let backfilled = 0, cleared = 0;
  const now = Date.now();
  for (const row of rows) {
    if (!row.notion_page_id && row.url && byUrl.has(row.url)) {
      await db.run('UPDATE matches SET notion_page_id = ?, updated_at = ? WHERE id = ?', [byUrl.get(row.url), now, row.id]);
      backfilled++;
    } else if (row.notion_page_id && !pageIds.has(row.notion_page_id)) {
      await db.run('UPDATE matches SET notion_page_id = NULL, updated_at = ? WHERE id = ?', [now, row.id]);
      cleared++;
    }
  }

  _chartCache.clear();
  const still = await db.get('SELECT COUNT(*) as n FROM matches WHERE notion_page_id IS NULL');
  return { notionPages: pageIds.size, rows: rows.length, backfilled, cleared, stillUnsynced: still.n };
}

// POST /notion-reconcile — re-derive notion_page_id state from Notion
app.post('/notion-reconcile', async (req, res) => {
  try {
    res.json(await reconcileNotionSync());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Auto-reconcile shortly after startup so unsynced counts are correct even if
// PATCHes were lost while the server was down (no-op without Notion env vars).
setTimeout(() => {
  reconcileNotionSync().then((r) => {
    if (!r.skipped) console.log(`[notion-reconcile] startup: ${r.backfilled} backfilled, ${r.cleared} cleared, ${r.stillUnsynced} still unsynced (${r.rows} rows, ${r.notionPages} Notion pages)`);
  }).catch((err) => console.error('[notion-reconcile] startup failed:', err.message));
}, 5000);

// POST /notion-dedup — find & optionally archive duplicate Notion pages by URL
app.post('/notion-dedup', async (req, res) => {
  const token  = process.env.NOTION_TOKEN;
  const dbId   = process.env.NOTION_DB_ID;
  const dryRun = req.query.dry !== 'false';
  if (!token || !dbId) return res.status(400).json({ error: 'NOTION_TOKEN and NOTION_DB_ID env vars required on server' });

  const nHeaders = {
    'Authorization': `Bearer ${token}`,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json',
  };

  async function fetchAllPages() {
    const pages = []; let cursor;
    do {
      const body = { page_size: 100 };
      if (cursor) body.start_cursor = cursor;
      const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, { method: 'POST', headers: nHeaders, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`Notion query ${r.status}: ${await r.text()}`);
      const d = await r.json();
      pages.push(...d.results);
      cursor = d.has_more ? d.next_cursor : null;
    } while (cursor);
    return pages;
  }

  try {
    const pages = await fetchAllPages();
    const byUrl = new Map();
    for (const p of pages) {
      const url = p.properties?.URL?.url;
      if (!url) continue;
      if (!byUrl.has(url)) byUrl.set(url, []);
      byUrl.get(url).push(p);
    }

    const dupes = [];
    for (const [url, group] of byUrl) {
      if (group.length < 2) continue;
      group.sort((a, b) => new Date(a.created_time) - new Date(b.created_time));
      dupes.push({ url, keep: group[0].id, keepCreated: group[0].created_time, remove: group.slice(1).map(p => ({ id: p.id, created: p.created_time })) });
    }

    if (!dryRun) {
      for (const d of dupes) {
        for (const p of d.remove) {
          const r = await fetch(`https://api.notion.com/v1/pages/${p.id}`, { method: 'PATCH', headers: nHeaders, body: JSON.stringify({ archived: true }) });
          if (!r.ok) throw new Error(`Archive ${p.id} failed ${r.status}: ${await r.text()}`);
        }
      }
    }

    const totalRemoved = dupes.reduce((n, d) => n + d.remove.length, 0);
    res.json({ dryRun, totalPages: pages.length, duplicateGroups: dupes.length, pagesRemoved: totalRemoved, dupes });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /notion-schema — inspect Notion DB property names and types
app.get('/notion-schema', async (req, res) => {
  const token = process.env.NOTION_TOKEN;
  const dbId  = process.env.NOTION_DB_ID;
  if (!token || !dbId) return res.status(400).json({ error: 'NOTION_TOKEN and NOTION_DB_ID env vars required' });

  try {
    const r = await fetch(`https://api.notion.com/v1/databases/${dbId}`, {
      headers: { 'Authorization': `Bearer ${token}`, 'Notion-Version': '2022-06-28' },
    });
    if (!r.ok) throw new Error(`Notion ${r.status}: ${await r.text()}`);
    const d = await r.json();
    const props = Object.entries(d.properties).map(([name, val]) => ({ name, type: val.type }));
    res.json({ databaseTitle: d.title?.[0]?.plain_text, properties: props });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- Notion export/import (CSV round-trip) -----------------------------------

const NOTION_SKIP_TYPES = new Set(['people', 'created_time', 'last_edited_time', 'formula', 'rollup']);

function notionFlattenValue(prop) {
  if (!prop) return '';
  switch (prop.type) {
    case 'title': return prop.title.map(t => t.plain_text).join('');
    case 'rich_text': return prop.rich_text.map(t => t.plain_text).join('');
    case 'select': return prop.select?.name || '';
    case 'status': return prop.status?.name || '';
    case 'multi_select': return prop.multi_select.map(s => s.name).join('; ');
    case 'date': return prop.date ? (prop.date.end ? `${prop.date.start} -> ${prop.date.end}` : prop.date.start) : '';
    case 'url': return prop.url || '';
    case 'email': return prop.email || '';
    case 'phone_number': return prop.phone_number || '';
    case 'number': return prop.number ?? '';
    case 'checkbox': return prop.checkbox ? 'true' : 'false';
    case 'people': return prop.people.map(p => p.name || p.id).join('; ');
    case 'created_time': return prop.created_time || '';
    case 'last_edited_time': return prop.last_edited_time || '';
    default: return '';
  }
}

function notionCsvEscape(value) {
  const s = String(value ?? '');
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function notionBuildPropertyValue(type, rawValue) {
  switch (type) {
    case 'title': return { title: [{ type: 'text', text: { content: rawValue } }] };
    case 'rich_text': return { rich_text: [{ type: 'text', text: { content: rawValue } }] };
    case 'select': return { select: rawValue ? { name: rawValue } : null };
    case 'status': return { status: rawValue ? { name: rawValue } : null };
    case 'multi_select': return { multi_select: rawValue ? rawValue.split(';').map(s => ({ name: s.trim() })).filter(s => s.name) : [] };
    case 'date': {
      if (!rawValue) return { date: null };
      const [start, end] = rawValue.split('->').map(s => s.trim());
      return { date: { start, end: end || null } };
    }
    case 'url': return { url: rawValue || null };
    case 'email': return { email: rawValue || null };
    case 'phone_number': return { phone_number: rawValue || null };
    case 'number': return { number: rawValue === '' ? null : Number(rawValue) };
    case 'checkbox': return { checkbox: rawValue === 'true' };
    default: return null;
  }
}

function notionParseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        if (row.length > 1 || row[0] !== '') rows.push(row);
        row = [];
      } else field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows;
  return body.map(r => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

// GET /notion-export — download all Notion DB pages as CSV (includes page_id for round-trip)
app.get('/notion-export', async (req, res) => {
  const token = process.env.NOTION_TOKEN;
  const dbId  = process.env.NOTION_DB_ID;
  if (!token || !dbId) return res.status(400).json({ error: 'NOTION_TOKEN and NOTION_DB_ID env vars required on server' });

  const nHeaders = { 'Authorization': `Bearer ${token}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' };

  try {
    const pages = []; let cursor;
    do {
      const body = { page_size: 100 };
      if (cursor) body.start_cursor = cursor;
      const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, { method: 'POST', headers: nHeaders, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`Notion query ${r.status}: ${await r.text()}`);
      const d = await r.json();
      pages.push(...d.results);
      cursor = d.has_more ? d.next_cursor : null;
    } while (cursor);

    let csv = '';
    if (pages.length) {
      const columns = Object.keys(pages[0].properties);
      const lines = [['page_id', ...columns].join(',')];
      for (const page of pages) lines.push([page.id, ...columns.map(c => notionCsvEscape(notionFlattenValue(page.properties[c])))].join(','));
      csv = lines.join('\n');
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="notion-export.csv"');
    res.send(csv);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /notion-import — patch Notion pages from a processed CSV (must include page_id column)
// body: { csv: string }, ?dry=true (default) previews changes, ?dry=false applies them
app.post('/notion-import', async (req, res) => {
  const token  = process.env.NOTION_TOKEN;
  const dryRun = req.query.dry !== 'false';
  if (!token) return res.status(400).json({ error: 'NOTION_TOKEN env var required on server' });
  const csvText = req.body?.csv;
  if (!csvText) return res.status(400).json({ error: 'Missing csv in request body' });

  const nHeaders = { 'Authorization': `Bearer ${token}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' };

  try {
    const rows = notionParseCsv(csvText);
    if (rows.length === 0) return res.json({ dryRun, rows: 0, updated: 0, skipped: 0, changes: [] });
    if (!('page_id' in rows[0])) return res.status(400).json({ error: 'CSV missing page_id column' });

    const columns = Object.keys(rows[0]).filter(c => c !== 'page_id');
    const changes = [];
    let updated = 0, skipped = 0;

    for (const row of rows) {
      const pageId = row.page_id;
      if (!pageId) { skipped++; continue; }

      const pr = await fetch(`https://api.notion.com/v1/pages/${pageId}`, { headers: nHeaders });
      if (!pr.ok) throw new Error(`Fetch page ${pageId} failed ${pr.status}: ${await pr.text()}`);
      const page = await pr.json();

      const properties = {};
      for (const col of columns) {
        const existing = page.properties[col];
        if (!existing || NOTION_SKIP_TYPES.has(existing.type)) continue;
        const value = notionBuildPropertyValue(existing.type, row[col]);
        if (value) properties[col] = value;
      }

      if (Object.keys(properties).length === 0) { skipped++; continue; }

      changes.push({ pageId, fields: Object.keys(properties) });
      if (!dryRun) {
        const patchRes = await fetch(`https://api.notion.com/v1/pages/${pageId}`, { method: 'PATCH', headers: nHeaders, body: JSON.stringify({ properties }) });
        if (!patchRes.ok) throw new Error(`Patch ${pageId} failed ${patchRes.status}: ${await patchRes.text()}`);
      }
      updated++;
    }

    res.json({ dryRun, rows: rows.length, updated, skipped, changes });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Cancel flag for notion-fill-ai background job
let _fillAICancelled = false;

// POST /notion-fill-ai/cancel — signal the running fill job to stop
app.post('/notion-fill-ai/cancel', (req, res) => {
  _fillAICancelled = true;
  broadcast({ action: 'notionFillCancelled' });
  res.json({ ok: true });
});

// POST /notion-fill-ai — find Notion pages missing AI Role, run Ollama, update Notion
// ?dry=true (default) → count only; ?dry=false → enqueue and process
app.post('/notion-fill-ai', async (req, res) => {
  const token       = process.env.NOTION_TOKEN;
  const dbId        = process.env.NOTION_DB_ID;
  const ollamaUrl   = (req.body.ollamaUrl   || 'http://localhost:11434').replace(/\/$/, '');
  const ollamaModel = req.body.ollamaModel  || 'qwen2.5:0.5b';
  const aiRoleProp  = req.body.aiRoleProp   || 'AI Role';
  const dryRun      = req.query.dry !== 'false';

  if (!token || !dbId) return res.status(400).json({ error: 'NOTION_TOKEN and NOTION_DB_ID env vars required' });

  const nHeaders = {
    'Authorization': `Bearer ${token}`,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json',
  };

  async function fetchAllPages() {
    const pages = []; let cursor;
    do {
      const body = { page_size: 100 };
      if (cursor) body.start_cursor = cursor;
      const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
        method: 'POST', headers: nHeaders, body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`Notion query ${r.status}: ${await r.text()}`);
      const d = await r.json();
      pages.push(...d.results);
      cursor = d.has_more ? d.next_cursor : null;
    } while (cursor);
    return pages;
  }

  async function ensureAIRoleProperty() {
    const r = await fetch(`https://api.notion.com/v1/databases/${dbId}`, { headers: nHeaders });
    if (!r.ok) throw new Error(`Get DB schema ${r.status}`);
    const schema = await r.json();
    if (!schema.properties?.[aiRoleProp]) {
      const patch = await fetch(`https://api.notion.com/v1/databases/${dbId}`, {
        method: 'PATCH', headers: nHeaders,
        body: JSON.stringify({ properties: { [aiRoleProp]: { rich_text: {} } } }),
      });
      if (!patch.ok) throw new Error(`Create ${aiRoleProp} property ${patch.status}: ${await patch.text()}`);
    }
  }

  function pageIsMissingAIRole(page) {
    const prop = page.properties?.[aiRoleProp];
    if (!prop) return true;
    if (prop.type === 'rich_text') return !prop.rich_text?.length || !prop.rich_text[0]?.plain_text?.trim();
    if (prop.type === 'title')     return !prop.title?.length     || !prop.title[0]?.plain_text?.trim();
    if (prop.type === 'select')    return !prop.select;
    if (prop.type === 'multi_select') return !prop.multi_select?.length;
    return true;
  }

  try {
    const pages = await fetchAllPages();
    const missing = pages.filter(pageIsMissingAIRole);

    if (dryRun) {
      return res.json({ total: pages.length, missingAIRole: missing.length, aiRoleProp, dryRun: true });
    }

    await ensureAIRoleProperty();

    // Reset cancel flag and respond immediately — processing in background
    _fillAICancelled = false;
    res.json({ total: pages.length, missingAIRole: missing.length, enqueuing: true });

    let processed = 0, skipped = 0, errors = 0;
    broadcast({ action: 'notionFillStart', total: missing.length });

    for (const page of missing) {
      if (_fillAICancelled) break;

      const pageUrl = page.properties?.URL?.url;
      const row = pageUrl ? await db.get('SELECT id, data FROM matches WHERE url = ?', [pageUrl]) : null;
      const matchData = row ? JSON.parse(row.data) : null;
      const text = (matchData?.fullText || matchData?.snippet || '').trim();

      if (!text) { skipped++; broadcast({ action: 'notionFillProgress', processed, skipped, errors, total: missing.length }); continue; }

      const hash = hashText(text);

      let analysis = aiCache.get(hash);
      let timeMs = 0, tokens = 0, model = ollamaModel;

      if (!analysis) {
        await db.run(
          'INSERT OR IGNORE INTO ai_queue (hash, text, ollama_url, ollama_model, created_at) VALUES (?, ?, ?, ?, ?)',
          [hash, text, ollamaUrl, ollamaModel, Date.now()]
        ).catch(() => {});

        const result = await new Promise(resolve => {
          aiQueue.push({ hash, text, ollamaUrl, ollamaModel, resolve });
          drainAIQueue();
        });

        if (!result.success) { errors++; broadcast({ action: 'notionFillProgress', processed, skipped, errors, total: missing.length }); continue; }
        analysis   = result.analysis;
        timeMs     = result.timeToProcess || 0;
        tokens     = result.tokens || 0;
        model      = result.model || ollamaModel;
      }

      const titles     = Array.isArray(analysis.jobTitles) ? analysis.jobTitles.filter(Boolean) : [];
      const roleText   = (titles.join(', ') || 'Unknown').substring(0, 2000);
      const confidence = typeof analysis.confidence === 'number' ? analysis.confidence : null;

      // Update SQLite match with AI results (only fields that were missing)
      if (row?.id && matchData) {
        matchData.aiAnalysis    = analysis;
        matchData.aiAnalyzedAt  = Date.now();
        matchData.aiTextHash    = hash;
        matchData.aiTimeToProcess = timeMs;
        matchData.aiTokens      = tokens;
        matchData.aiModel       = model;
        await db.run(
          'UPDATE matches SET data = ?, updated_at = ? WHERE id = ?',
          [JSON.stringify(matchData), Date.now(), row.id]
        ).catch(() => {});
      }

      // Build Notion properties — only AI-related fields
      const notionProps = {
        [aiRoleProp]: { rich_text: [{ text: { content: roleText } }] },
      };
      if (confidence !== null) notionProps['AI Confidence'] = { number: confidence };
      if (tokens)   notionProps['AI Tokens']   = { number: tokens };
      if (timeMs)   notionProps['AI Time (ms)'] = { number: timeMs };
      if (model)    notionProps['AI Model']     = { rich_text: [{ text: { content: model } }] };

      const r = await fetch(`https://api.notion.com/v1/pages/${page.id}`, {
        method: 'PATCH', headers: nHeaders,
        body: JSON.stringify({ properties: notionProps }),
      });

      if (r.ok) { processed++; } else { errors++; }
      broadcast({ action: 'notionFillProgress', processed, skipped, errors, total: missing.length });
    }

    const wasCancelled = _fillAICancelled;
    _fillAICancelled = false;
    broadcast({ action: 'notionFillComplete', processed, skipped, errors, total: missing.length, cancelled: wasCancelled });
    console.log(`[notion-fill-ai] ${wasCancelled ? 'cancelled' : 'done'}: ${processed} updated, ${skipped} skipped, ${errors} errors`);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else console.error('[notion-fill-ai] error after response:', err.message);
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
<title>DevOps Scanner — Server Dashboard</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh}
header{background:#1e293b;border-bottom:1px solid #334155;padding:16px 24px;display:flex;align-items:center;gap:12px}
header h1{font-size:18px;font-weight:700;color:#f8fafc}
.dot{width:10px;height:10px;border-radius:50%;background:#22c55e;animation:pulse 2s infinite;flex-shrink:0}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.dot.offline{background:#ef4444;animation:none}
.uptime{margin-left:auto;font-size:12px;color:#64748b}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;padding:20px 24px}
.card{background:#1e293b;border:1px solid #334155;border-radius:10px;padding:16px}
.card-label{font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px}
.card-value{font-size:32px;font-weight:700;line-height:1}
.card-value.green{color:#22c55e}
.card-value.blue{color:#60a5fa}
.card-value.purple{color:#a78bfa}
.card-value.orange{color:#fb923c}
.card-value.yellow{color:#fbbf24}
.card-sub{font-size:11px;color:#64748b;margin-top:4px}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:0 24px 20px}
@media(max-width:700px){.cols{grid-template-columns:1fr}}
.panel{background:#1e293b;border:1px solid #334155;border-radius:10px;overflow:hidden}
.panel-header{padding:12px 16px;border-bottom:1px solid #334155;font-size:13px;font-weight:600;display:flex;align-items:center;justify-content:space-between}
.panel-header .badge{font-size:10px;background:#334155;color:#94a3b8;padding:2px 8px;border-radius:10px}
.feed{height:320px;overflow-y:auto;padding:8px 0}
.feed-item{padding:8px 16px;border-bottom:1px solid #1e293b;font-size:12px;display:flex;gap:8px;align-items:flex-start;animation:fadeIn .3s}
@keyframes fadeIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
.feed-item .ts{color:#475569;flex-shrink:0;font-size:10px;margin-top:1px;width:54px}
.feed-item .msg{color:#cbd5e1;flex:1;line-height:1.4}
.feed-item .tag{flex-shrink:0;font-size:10px;padding:1px 6px;border-radius:8px;font-weight:600}
.tag-save{background:#14532d;color:#86efac}
.tag-ai{background:#1e1b4b;color:#a5b4fc}
.tag-cache{background:#1c1917;color:#a8a29e}
.tag-err{background:#450a0a;color:#fca5a5}
.tag-dup{background:#1c1917;color:#a8a29e}
.users-list{padding:12px 16px}
.user-row{display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid #0f172a}
.user-row:last-child{border-bottom:none}
.user-avatar{width:28px;height:28px;border-radius:50%;background:#334155;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#94a3b8;flex-shrink:0}
.user-name{font-size:13px;color:#e2e8f0;flex:1}
.user-count{font-size:12px;color:#64748b}
.ai-bar{padding:12px 16px}
.ai-row{display:flex;align-items:center;gap:8px;margin-bottom:8px;font-size:12px}
.ai-row label{color:#64748b;width:80px;flex-shrink:0}
.bar{flex:1;background:#0f172a;border-radius:4px;height:6px;overflow:hidden}
.bar-fill{height:100%;border-radius:4px;transition:width .4s}
.bar-fill.green{background:#22c55e}
.bar-fill.purple{background:#a78bfa}
.charts{display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:0 24px 24px}
@media(max-width:700px){.charts{grid-template-columns:1fr}}
.chart-wrap{position:relative;height:220px}
.chart-empty{display:flex;align-items:center;justify-content:center;height:220px;font-size:12px;color:#475569}
.src-list{padding:12px 16px}
.src-row{display:grid;grid-template-columns:170px 1fr 48px;gap:12px;align-items:center;padding:7px 0;border-bottom:1px solid #0f172a}
.src-row:last-child{border-bottom:none}
.src-row.quiet .bar-fill{background:#f59e0b;opacity:.55}
.src-name{font-size:13px;color:#e2e8f0;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.src-name a{color:#e2e8f0;text-decoration:none}
.src-name a:hover{color:#60a5fa;text-decoration:underline}
.src-meta{font-size:10px;color:#64748b;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.src-bar{height:8px}
.src-count{font-size:13px;font-weight:700;text-align:right;color:#e2e8f0;font-variant-numeric:tabular-nums}
.src-pill{font-size:10px;background:#451a03;color:#fbbf24;padding:1px 8px;border-radius:8px;font-weight:600}
.feed-filters{display:flex;gap:6px;padding:8px 16px;border-bottom:1px solid #334155}
.filter-pill{font-size:10px;padding:2px 10px;border-radius:10px;border:1px solid #334155;color:#64748b;background:none;cursor:pointer;transition:all .15s}
.filter-pill.active{background:#334155;color:#e2e8f0;border-color:#475569}
.range-tabs{display:flex;gap:4px}
.range-tab{font-size:10px;padding:2px 8px;border-radius:6px;border:1px solid #334155;color:#64748b;background:none;cursor:pointer}
.range-tab.active{background:#334155;color:#e2e8f0}
.user-meta{display:flex;flex-direction:column;gap:2px;flex:1}
.user-last{font-size:10px;color:#475569}
.user-notion{font-size:10px}
.notion-ok{color:#22c55e}
.notion-warn{color:#f59e0b}
.ai-progress{margin:8px 16px 4px;height:4px;background:#0f172a;border-radius:2px;overflow:hidden;display:none}
.ai-progress-fill{height:100%;background:#a78bfa;border-radius:2px;transition:width .3s}
.reconnect-count{font-size:11px;color:#64748b;margin-left:8px}
.tools-section{padding:0 24px 24px}
.tools-panel{background:#1e293b;border:1px solid #334155;border-radius:10px;overflow:hidden}
.tools-body{padding:16px}
.tools-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.btn{font-size:12px;font-weight:600;padding:6px 16px;border-radius:6px;border:none;cursor:pointer;transition:opacity .15s}
.btn:disabled{opacity:.4;cursor:default}
.btn-ghost{background:#334155;color:#e2e8f0}
.btn-danger{background:#dc2626;color:#fff}
.dedup-status{font-size:12px;color:#94a3b8;flex:1}
.dedup-results{margin-top:12px;font-size:12px;color:#94a3b8;display:none}
.dedup-results table{width:100%;border-collapse:collapse;margin-top:8px}
.dedup-results td,.dedup-results th{padding:4px 8px;border-bottom:1px solid #334155;text-align:left}
.dedup-results th{color:#64748b;font-size:10px;text-transform:uppercase}
.dedup-results .url-cell{color:#60a5fa;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tool-status-box{margin-top:10px;padding:10px 14px;border-radius:6px;font-size:12px;line-height:1.6;display:none;border:1px solid #334155;background:#0f172a}
.tool-status-box.visible{display:block}
.tool-status-box.running{border-color:#7c3aed;color:#c4b5fd}
.tool-status-box.success{border-color:#16a34a;color:#86efac}
.tool-status-box.error{border-color:#dc2626;color:#fca5a5}
@keyframes spin{to{transform:rotate(360deg)}}
.spinner{display:inline-block;width:10px;height:10px;border:2px solid #475569;border-top-color:#a78bfa;border-radius:50%;animation:spin .7s linear infinite;margin-right:6px;vertical-align:middle}
.tool-progress{height:3px;background:#1e293b;border-radius:2px;margin-top:8px;overflow:hidden;display:none}
.tool-progress-fill{height:100%;background:#7c3aed;border-radius:2px;transition:width .3s}
</style>
</head>
<body>
<header>
  <div class="dot" id="conn-dot"></div>
  <h1>🔍 DevOps Scanner</h1>
  <span class="reconnect-count" id="reconnect-count"></span>
  <span class="uptime" id="uptime-label" title="" style="cursor:default;margin-left:auto"></span>
</header>

<div class="grid">
  <div class="card"><div class="card-label">Total Matches</div><div class="card-value green" id="s-total">—</div><div class="card-sub" id="s-today"></div></div>
  <div class="card"><div class="card-label">Notion Synced</div><div class="card-value blue" id="s-notion">—</div></div>
  <div class="card"><div class="card-label">AI Cache</div><div class="card-value purple" id="s-cache">—</div></div>
  <div class="card"><div class="card-label">Online Users</div><div class="card-value yellow" id="s-clients">—</div></div>
</div>

<div class="cols">
  <div class="panel">
    <div class="panel-header">Live Activity <span class="badge" id="feed-count">0 events</span></div>
    <div class="feed-filters">
      <button class="filter-pill active" data-filter="all">ALL</button>
      <button class="filter-pill" data-filter="tag-save">SAVE</button>
      <button class="filter-pill" data-filter="tag-ai">AI</button>
      <button class="filter-pill" data-filter="tag-err">ERR</button>
    </div>
    <div class="feed" id="feed"></div>
  </div>
  <div>
    <div class="panel" style="margin-bottom:12px">
      <div class="panel-header">Users</div>
      <div class="users-list" id="users-list"><span style="font-size:12px;color:#475569">No data yet</span></div>
    </div>
    <div class="panel">
      <div class="panel-header">AI Engine</div>
      <div class="ai-progress" id="ai-progress"><div class="ai-progress-fill" id="ai-progress-fill" style="width:0%"></div></div>
      <div class="ai-bar" id="ai-bar">
        <div class="ai-row"><label>Status</label><span style="color:#94a3b8" id="s-active">—</span></div>
        <div class="ai-row"><label>Queue</label><span style="color:#94a3b8" id="s-queue-label">—</span></div>
        <div class="ai-row"><label>Cache size</label><span style="color:#94a3b8" id="s-cache-label">—</span></div>
      </div>
    </div>
  </div>
</div>

<div class="charts">
  <div class="panel">
    <div class="panel-header">Jobs: Analyzed vs Saved vs Notion
      <div class="range-tabs">
        <button class="range-tab" data-days="7">7d</button>
        <button class="range-tab active" data-days="14">14d</button>
        <button class="range-tab" data-days="30">30d</button>
      </div>
    </div>
    <div id="chart-jobs-empty" class="chart-empty" style="display:none">No data yet — start scanning on LinkedIn</div>
    <div class="chart-wrap" style="padding:16px"><canvas id="chart-jobs"></canvas></div>
  </div>
  <div class="panel">
    <div class="panel-header">AI: Requests vs Cache Hits
      <div class="range-tabs">
        <button class="range-tab" data-days="7">7d</button>
        <button class="range-tab active" data-days="14">14d</button>
        <button class="range-tab" data-days="30">30d</button>
      </div>
    </div>
    <div id="chart-ai-empty" class="chart-empty" style="display:none">No AI activity yet</div>
    <div class="chart-wrap" style="padding:16px"><canvas id="chart-ai"></canvas></div>
  </div>
  <div class="panel" style="grid-column:1/-1">
    <div class="panel-header">Saves by Source <span class="badge">all time · ⚠ = no saves in 14 days</span></div>
    <div class="src-list" id="src-list"><span style="font-size:12px;color:#475569">No data yet</span></div>
  </div>
</div>

<div class="tools-section">
  <div class="tools-panel">
    <div class="panel-header">Notion Cleanup</div>
    <div class="tools-body">
      <div class="tools-row">
        <button class="btn btn-ghost" id="btn-dry-run" onclick="runDedup(true)">Preview Duplicates</button>
        <button class="btn btn-danger" id="btn-run" onclick="runDedup(false)" disabled>Remove Duplicates</button>
        <button class="btn btn-ghost" id="btn-reconcile" onclick="runReconcile()">Reconcile Sync Status</button>
        <span class="dedup-status" id="dedup-status">Set NOTION_TOKEN + NOTION_DB_ID env vars on server, then preview first.</span>
      </div>
      <div class="tool-status-box" id="dedup-status-box"></div>
      <div class="dedup-results" id="dedup-results"></div>
    </div>
  </div>
  <div class="tools-panel" style="margin-top:12px">
    <div class="panel-header">Notion AI Role Fill</div>
    <div class="tools-body">
      <div class="tools-row" style="margin-bottom:10px;gap:8px;flex-wrap:wrap">
        <button class="btn btn-ghost" onclick="loadNotionSchema()" style="font-size:11px;padding:4px 10px">Inspect Schema</button>
        <label style="font-size:11px;color:#94a3b8;display:flex;align-items:center;gap:4px">
          Job Title prop: <input id="fill-role-prop" value="AI Role" style="background:#0f172a;border:1px solid #334155;color:#e2e8f0;padding:2px 6px;border-radius:4px;font-size:11px;width:120px">
        </label>
      </div>
      <div class="tools-row">
        <button class="btn btn-ghost" id="btn-fill-preview" onclick="runFillAI(true)">Check Missing</button>
        <button class="btn btn-ghost" id="btn-fill-run" onclick="runFillAI(false)" disabled style="background:#7c3aed">Fill Missing AI Roles</button>
        <button class="btn btn-danger" id="btn-fill-stop" onclick="stopFillAI()" disabled>Stop</button>
        <span class="dedup-status" id="fill-status">Inspect schema first to confirm property names, then preview.</span>
      </div>
      <div class="tool-status-box" id="fill-status-box"></div>
      <div class="tool-progress" id="fill-progress"><div class="tool-progress-fill" id="fill-progress-fill" style="width:0%"></div></div>
      <div class="dedup-results" id="fill-results"></div>
    </div>
  </div>
  <div class="tools-panel" style="margin-top:12px">
    <div class="panel-header">Notion Export / Import (CSV)</div>
    <div class="tools-body">
      <div class="tools-row">
        <button class="btn btn-ghost" onclick="exportNotionCsv()">Export to CSV</button>
        <input type="file" id="import-file" accept=".csv" style="font-size:11px;color:#94a3b8">
        <button class="btn btn-ghost" id="btn-import-preview" onclick="runNotionImport(true)">Preview Import</button>
        <button class="btn btn-danger" id="btn-import-run" onclick="runNotionImport(false)" disabled>Apply Import</button>
        <span class="dedup-status" id="import-status">Export, edit the CSV, then re-upload to patch Notion.</span>
      </div>
      <div class="tool-status-box" id="import-status-box"></div>
      <div class="dedup-results" id="import-results"></div>
    </div>
  </div>
</div>

<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
<script>
const WS_URL = 'ws://' + location.host + '/ws';
const STATS_URL = '/stats';
let ws, feedCount = 0, serverStartMs = null;
let activeFeedFilter = 'all';
let chartDays = 14;
let aiQueueTotal = 0, aiQueueDone = 0;
let reconnectTimer = null;

// ---- Helpers ----------------------------------------------------------------
// Escape user-derived values before injecting into innerHTML (userName/URLs come from clients)
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function fmt(ms) {
  if (ms < 1000) return ms + 'ms';
  return (ms/1000).toFixed(1) + 's';
}
function fmtUptime(s) {
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = s%60;
  return h ? h+'h '+m+'m' : m ? m+'m '+sec+'s' : sec+'s';
}
function ago(ts) {
  if (!ts) return '—';
  const d = Math.floor((Date.now()-ts)/1000);
  return d < 60 ? d+'s ago' : d < 3600 ? Math.floor(d/60)+'m ago' : Math.floor(d/3600)+'h ago';
}

// ---- Feed -------------------------------------------------------------------
function addFeedItem(tag, tagClass, msg, tsMs) {
  const feed = document.getElementById('feed');
  feedCount++;
  document.getElementById('feed-count').textContent = feedCount + ' events';
  const ts = new Date(tsMs || Date.now()).toLocaleTimeString('en-US',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const el = document.createElement('div');
  el.className = 'feed-item';
  el.dataset.tag = tagClass;
  el.innerHTML = '<span class="ts">'+ts+'</span><span class="msg">'+msg+'</span><span class="tag '+tagClass+'">'+tag+'</span>';
  if (activeFeedFilter !== 'all' && tagClass !== activeFeedFilter) el.style.display = 'none';
  feed.prepend(el);
  while (feed.children.length > 200) feed.removeChild(feed.lastChild);
}

// Feed filter pills
document.querySelectorAll('.filter-pill').forEach(pill => {
  pill.addEventListener('click', () => {
    document.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
    pill.classList.add('active');
    activeFeedFilter = pill.dataset.filter;
    document.querySelectorAll('.feed-item').forEach(item => {
      item.style.display = (activeFeedFilter === 'all' || item.dataset.tag === activeFeedFilter) ? '' : 'none';
    });
  });
});

// ---- Stats ------------------------------------------------------------------
function loadStats() {
  fetch(STATS_URL).then(r=>r.json()).then(d => {
    document.getElementById('s-total').textContent = d.totalMatches;
    document.getElementById('s-today').textContent = d.todayMatches + ' today';
    document.getElementById('s-notion').textContent = d.withNotion;
    document.getElementById('s-cache').textContent = d.aiCacheSize;
    document.getElementById('s-queue-label').textContent = d.aiQueueDepth;
    document.getElementById('s-cache-label').textContent = d.aiCacheSize;
    document.getElementById('s-active').textContent = d.aiActive ? 'running' : 'idle';
    document.getElementById('s-clients').textContent = d.wsClients;

    // Uptime with exact start time tooltip
    const uptimeEl = document.getElementById('uptime-label');
    uptimeEl.textContent = 'up ' + fmtUptime(d.uptime);
    if (!serverStartMs) serverStartMs = Date.now() - d.uptime * 1000;
    uptimeEl.title = 'Server started: ' + new Date(serverStartMs).toLocaleString();

    // Users — last seen + Notion sync status
    const ul = document.getElementById('users-list');
    if (!d.byUser || d.byUser.length === 0) {
      ul.innerHTML = '<span style="font-size:12px;color:#475569">No saves yet</span>';
    } else {
      ul.innerHTML = d.byUser.map(u => {
        const init = esc((u.saved_by||'?').charAt(0).toUpperCase());
        const notionBadge = u.unsynced > 0
          ? '<span class="user-notion notion-warn">⚠ '+u.unsynced+' unsynced</span>'
          : '<span class="user-notion notion-ok">✓ Notion</span>';
        return '<div class="user-row">'
          + '<div class="user-avatar">'+init+'</div>'
          + '<div class="user-meta">'
          + '<div class="user-name">'+esc(u.saved_by||'Unknown')+'</div>'
          + '<div class="user-last">'+ago(u.last_saved)+' · '+u.n+' saves · '+notionBadge+'</div>'
          + '</div>'
          + '</div>';
      }).join('');
    }
  }).catch(()=>{});
}

// ---- AI queue progress bar --------------------------------------------------
function setAIProgress(queueDepth, active) {
  const bar = document.getElementById('ai-progress');
  const fill = document.getElementById('ai-progress-fill');
  if (active && queueDepth >= 0) {
    bar.style.display = 'block';
    const pct = aiQueueTotal > 0 ? Math.round((aiQueueDone / aiQueueTotal) * 100) : 0;
    fill.style.width = pct + '%';
  } else {
    bar.style.display = 'none';
    aiQueueTotal = 0; aiQueueDone = 0;
  }
}

// ---- WebSocket --------------------------------------------------------------
function startReconnectCountdown(sec) {
  const el = document.getElementById('reconnect-count');
  let t = sec;
  el.textContent = 'reconnecting in ' + t + 's…';
  reconnectTimer = setInterval(() => {
    t--;
    if (t <= 0) { clearInterval(reconnectTimer); el.textContent = ''; }
    else el.textContent = 'reconnecting in ' + t + 's…';
  }, 1000);
}

function connectWS() {
  if (reconnectTimer) { clearInterval(reconnectTimer); reconnectTimer = null; }
  document.getElementById('reconnect-count').textContent = '';
  ws = new WebSocket(WS_URL);
  const dot = document.getElementById('conn-dot');

  ws.onopen = () => {
    dot.className = 'dot';
    serverStartMs = null; // reset so uptime tooltip recalculates
    addFeedItem('CONN', 'tag-ai', 'Connected to server');
    loadStats();
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.action === 'replay') {
      // Render oldest→newest so prepend order is correct
      for (const ev of msg.events) handleEvent(ev, ev._ts);
      return;
    }
    handleEvent(msg, null);
    if (msg.action === 'newMatch') { loadStats(); loadCharts(); }
    if (msg.action === 'aiComplete') loadCharts();
  };

  function handleEvent(msg, ts) {
    if (msg.action === 'newMatch') {
      const by = msg.savedBy ? ' by <b>'+esc(msg.savedBy)+'</b>' : '';
      const urlShort = msg.url ? msg.url.replace('https://www.linkedin.com/','…/') : 'unknown';
      addFeedItem('SAVE', 'tag-save', 'New match'+by+' — <span style="color:#475569">'+esc(urlShort)+'</span>', ts);
    } else if (msg.action === 'aiStart') {
      aiQueueTotal = Math.max(aiQueueTotal, msg.queueDepth + 1);
      addFeedItem('AI', 'tag-ai', 'Ollama started (queue: '+msg.queueDepth+')', ts);
      if (!ts) { document.getElementById('s-queue-label').textContent = msg.queueDepth; document.getElementById('s-active').textContent = 'running'; setAIProgress(msg.queueDepth, true); }
    } else if (msg.action === 'aiComplete') {
      aiQueueDone++;
      addFeedItem('DONE', 'tag-ai', esc(msg.model)+' · '+fmt(msg.timeMs)+' · '+msg.tokens+' tok · cache:'+msg.cacheSize, ts);
      if (!ts) { document.getElementById('s-cache').textContent = msg.cacheSize; document.getElementById('s-cache-label').textContent = msg.cacheSize; document.getElementById('s-active').textContent = 'idle'; setAIProgress(0, false); }
    } else if (msg.action === 'aiError') {
      addFeedItem('ERR', 'tag-err', 'AI error: '+esc(msg.error), ts);
      if (!ts) { document.getElementById('s-active').textContent = 'idle'; setAIProgress(0, false); }
    } else if (msg.action === 'notionFillStart') {
      addFeedItem('FILL', 'tag-ai', 'Notion fill-AI started — '+msg.total+' pages to process', ts);
      if (!ts) { const s = document.getElementById('btn-fill-stop'); if (s) { s.disabled = false; s.textContent = 'Stop'; } }
    } else if (msg.action === 'notionFillProgress' && !ts) {
      const done = msg.processed + msg.skipped + msg.errors;
      const pct  = msg.total ? Math.round((done / msg.total) * 100) : 0;
      setToolStatus('fill-status-box', 'running',
        'Processing ' + done + ' / ' + msg.total + ' — ' +
        '<span style="color:#86efac">' + msg.processed + ' updated</span> · ' +
        '<span style="color:#94a3b8">' + msg.skipped + ' skipped</span>' +
        (msg.errors ? ' · <span style="color:#fca5a5">' + msg.errors + ' errors</span>' : '')
      );
      const fill = document.getElementById('fill-progress-fill');
      if (fill) fill.style.width = pct + '%';
    } else if (msg.action === 'notionFillCancelled' && !ts) {
      setToolStatus('fill-status-box', 'error', '⏹ Stopped by user.');
      const s = document.getElementById('btn-fill-stop'); if (s) { s.disabled = true; s.textContent = 'Stop'; }
    } else if (msg.action === 'notionFillComplete') {
      const label = msg.cancelled ? '⏹ Stopped' : '✓ Done';
      addFeedItem('FILL', msg.cancelled ? 'tag-err' : 'tag-save',
        'Notion fill-AI ' + (msg.cancelled ? 'stopped' : 'done') + ' — '+msg.processed+' updated, '+msg.skipped+' skipped, '+msg.errors+' errors', ts);
      if (!ts) {
        setToolStatus('fill-status-box', msg.cancelled ? 'error' : (msg.errors > 0 ? 'running' : 'success'),
          label + ' — <b>' + msg.processed + '</b> updated, ' + msg.skipped + ' skipped' +
          (msg.errors ? ', <span style="color:#fca5a5">' + msg.errors + ' errors</span>' : '')
        );
        const prog = document.getElementById('fill-progress'); if (prog) prog.style.display = 'none';
        const s = document.getElementById('btn-fill-stop'); if (s) { s.disabled = true; s.textContent = 'Stop'; }
        loadStats();
      }
    }
  }

  ws.onclose = () => {
    dot.className = 'dot offline';
    addFeedItem('DISC', 'tag-err', 'Disconnected');
    startReconnectCountdown(3);
    setTimeout(connectWS, 3000);
  };
  ws.onerror = () => ws.close();
}

// ---- Charts -----------------------------------------------------------------
const CHART_DEFAULTS = {
  responsive: true, maintainAspectRatio: false,
  plugins: { legend: { labels: { color: '#94a3b8', font: { size: 11 } } } },
  scales: {
    x: { ticks: { color: '#64748b', font: { size: 10 }, maxRotation: 45 }, grid: { color: '#1e293b' } },
    y: { ticks: { color: '#64748b', font: { size: 10 } }, grid: { color: '#1e293b' }, beginAtZero: true },
  },
};

let jobChart, aiChart;

function initCharts() {
  const jobCtx = document.getElementById('chart-jobs').getContext('2d');
  jobChart = new Chart(jobCtx, {
    type: 'bar',
    data: { labels: [], datasets: [
      { label: 'Analyzed',     data: [], backgroundColor: 'rgba(167,139,250,0.7)', borderColor: '#a78bfa', borderWidth: 1 },
      { label: 'Saved',        data: [], backgroundColor: 'rgba(34,197,94,0.7)',   borderColor: '#22c55e', borderWidth: 1 },
      { label: 'Notion Synced',data: [], backgroundColor: 'rgba(96,165,250,0.7)',  borderColor: '#60a5fa', borderWidth: 1 },
    ]},
    options: { ...CHART_DEFAULTS },
  });

  const aiCtx = document.getElementById('chart-ai').getContext('2d');
  aiChart = new Chart(aiCtx, {
    type: 'line',
    data: { labels: [], datasets: [
      { label: 'AI Requests', data: [], borderColor: '#a78bfa', backgroundColor: 'rgba(167,139,250,0.1)', fill: true, tension: 0.3 },
      { label: 'Cache Hits',  data: [], borderColor: '#22c55e', backgroundColor: 'rgba(34,197,94,0.1)',   fill: true, tension: 0.3 },
    ]},
    options: { ...CHART_DEFAULTS },
  });
}

function loadCharts() {
  fetch('/chart-data?days='+chartDays).then(r => r.json()).then(d => {
    const shortLabels = d.labels.map(l => l.slice(5));

    const jobsEmpty = d.saves.every(v => v === 0) && d.analyzed.every(v => v === 0);
    document.getElementById('chart-jobs-empty').style.display = jobsEmpty ? 'flex' : 'none';
    document.getElementById('chart-jobs').style.display = jobsEmpty ? 'none' : 'block';

    const aiEmpty = d.analyzed.every(v => v === 0);
    document.getElementById('chart-ai-empty').style.display = aiEmpty ? 'flex' : 'none';
    document.getElementById('chart-ai').style.display = aiEmpty ? 'none' : 'block';

    jobChart.data.labels = shortLabels;
    jobChart.data.datasets[0].data = d.analyzed;
    jobChart.data.datasets[1].data = d.saves;
    jobChart.data.datasets[2].data = d.notionSynced;
    jobChart.update('none');

    aiChart.data.labels = shortLabels;
    aiChart.data.datasets[0].data = d.analyzed;
    aiChart.data.datasets[1].data = d.cacheHits;
    aiChart.update('none');

    renderSources(d.bySource);
  }).catch(() => {});
}

// ---- Saves by Source (LinkedIn groups / feed / search / jobs) -----------------
function renderSources(rows) {
  const el = document.getElementById('src-list');
  if (!el) return;
  if (!rows || rows.length === 0) {
    el.innerHTML = '<span style="font-size:12px;color:#475569">No saves yet</span>';
    return;
  }
  const max = Math.max(...rows.map(r => r.total));
  const quietCutoff = Date.now() - 14 * 86400000;
  el.innerHTML = rows.map(r => {
    const gid = r.source.startsWith('group:') ? esc(r.source.slice(6)) : null;
    const label = gid ? '👥 Group ' + gid
      : r.source === 'feed'   ? '📰 Home Feed'
      : r.source === 'search' ? '🔍 Search'
      : r.source === 'jobs'   ? '💼 Jobs'
      : 'Other pages';
    const name = gid
      ? '<a href="https://www.linkedin.com/groups/' + gid + '/" target="_blank">' + label + '</a>'
      : label;
    const quiet = r.lastSaved && r.lastSaved < quietCutoff;
    const last = r.lastSaved
      ? new Date(r.lastSaved).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      : '—';
    const meta = quiet
      ? 'last save ' + last + ' <span class="src-pill">⚠ empty — 0 in 14d</span>'
      : r.last7 + ' in last 7d · last save ' + last;
    return '<div class="src-row' + (quiet ? ' quiet' : '') + '">'
      + '<div class="src-name">' + name + '<div class="src-meta">' + meta + '</div></div>'
      + '<div class="bar src-bar"><div class="bar-fill green" style="width:' + Math.max(1, Math.round(r.total / max * 100)) + '%"></div></div>'
      + '<div class="src-count">' + r.total + '</div>'
      + '</div>';
  }).join('');
}

// Date range tabs — both chart panels
document.querySelectorAll('.range-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const days = parseInt(tab.dataset.days);
    // Update active state only in parent panel
    tab.closest('.panel').querySelectorAll('.range-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    chartDays = days;
    loadCharts();
  });
});

// Wait for Chart.js to load before init
window.addEventListener('load', () => { initCharts(); loadCharts(); });

connectWS();
setInterval(loadStats, 15000);
setInterval(loadCharts, 30000);

// ---- Tool status helpers ----------------------------------------------------
function setToolStatus(boxId, state, html) {
  const box = document.getElementById(boxId);
  if (!box) return;
  box.className = 'tool-status-box visible ' + state;
  box.innerHTML = state === 'running' ? '<span class="spinner"></span>' + html : html;
}
function clearToolStatus(boxId) {
  const box = document.getElementById(boxId);
  if (box) { box.className = 'tool-status-box'; box.innerHTML = ''; }
}

// ---- Notion sync reconcile ----------------------------------------------------
async function runReconcile() {
  const btn = document.getElementById('btn-reconcile');
  btn.disabled = true;
  setToolStatus('dedup-status-box', 'running', 'Reconciling sync status against Notion…');
  try {
    const r = await fetch('/notion-reconcile', { method: 'POST' });
    const d = await r.json();
    if (!r.ok || d.error) throw new Error(d.error || ('HTTP ' + r.status));
    if (d.skipped) {
      setToolStatus('dedup-status-box', 'error', esc(d.reason));
    } else {
      setToolStatus('dedup-status-box', 'success',
        '✓ Reconciled against ' + d.notionPages + ' Notion pages — <b>' + d.backfilled + '</b> backfilled, <b>' + d.cleared + '</b> cleared (deleted in Notion), ' + d.stillUnsynced + ' of ' + d.rows + ' rows still unsynced');
      loadStats();
      loadCharts();
    }
  } catch (e) {
    setToolStatus('dedup-status-box', 'error', 'Reconcile failed: ' + esc(e.message));
  }
  btn.disabled = false;
}

// ---- Notion Dedup -----------------------------------------------------------
let dedupPreviewData = null;

async function loadNotionSchema() {
  const statusEl  = document.getElementById('fill-status');
  const resultsEl = document.getElementById('fill-results');
  statusEl.textContent = 'Loading Notion schema…';
  resultsEl.style.display = 'none';
  try {
    const r = await fetch('/notion-schema');
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || r.status);
    statusEl.textContent = 'DB: ' + (d.databaseTitle || 'Untitled') + ' — ' + d.properties.length + ' properties found. Set the correct names above.';
    resultsEl.style.display = 'block';
    resultsEl.innerHTML = '<table><tr><th>Property Name</th><th>Type</th></tr>'
      + d.properties.map(p => '<tr><td style="color:#e2e8f0">' + esc(p.name) + '</td><td style="color:#64748b">' + esc(p.type) + '</td></tr>').join('')
      + '</table>';
  } catch (e) {
    statusEl.textContent = '✗ Error: ' + e.message;
  }
}

async function stopFillAI() {
  const btn = document.getElementById('btn-fill-stop');
  btn.disabled = true;
  btn.textContent = 'Stopping…';
  try {
    await fetch('/notion-fill-ai/cancel', { method: 'POST' });
  } catch (e) {
    setToolStatus('fill-status-box', 'error', '✗ Cancel failed: ' + e.message);
  }
}

async function runFillAI(dry) {
  const statusEl   = document.getElementById('fill-status');
  const resultsEl  = document.getElementById('fill-results');
  const btnPrev    = document.getElementById('btn-fill-preview');
  const btnRun     = document.getElementById('btn-fill-run');
  const aiRoleProp = document.getElementById('fill-role-prop').value.trim() || 'AI Role';

  btnPrev.disabled = true;
  btnRun.disabled  = true;
  resultsEl.style.display = 'none';

  if (dry) {
    setToolStatus('fill-status-box', 'running', 'Scanning Notion for missing "' + aiRoleProp + '"…');
    statusEl.textContent = '';
  } else {
    setToolStatus('fill-status-box', 'running', 'Sending job to server…');
  }

  try {
    const r = await fetch('/notion-fill-ai?dry=' + dry, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aiRoleProp }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || r.status);

    if (dry) {
      const pct = d.total ? Math.round((d.missingAIRole / d.total) * 100) : 0;
      const msg = d.missingAIRole === 0
        ? '✓ All ' + d.total + ' pages already have "' + aiRoleProp + '".'
        : d.missingAIRole + ' of ' + d.total + ' pages missing "' + aiRoleProp + '" (' + pct + '%).';
      setToolStatus('fill-status-box', d.missingAIRole === 0 ? 'success' : 'running', msg);
      statusEl.textContent = d.missingAIRole > 0 ? 'Click Fill to process.' : '';
      btnRun.disabled = d.missingAIRole === 0;
      resultsEl.style.display = 'block';
      resultsEl.innerHTML = '<table><tr><th>Metric</th><th>Count</th></tr>'
        + '<tr><td>Total Notion pages</td><td>' + d.total + '</td></tr>'
        + '<tr><td style="color:#f87171">Missing "' + aiRoleProp + '"</td><td style="color:#f87171">' + d.missingAIRole + '</td></tr>'
        + '<tr><td style="color:#22c55e">Already filled</td><td style="color:#22c55e">' + (d.total - d.missingAIRole) + '</td></tr>'
        + '</table>';
    } else {
      // Processing happens in background — status updates come via WebSocket
      const prog = document.getElementById('fill-progress');
      const fill = document.getElementById('fill-progress-fill');
      if (prog) { prog.style.display = 'block'; fill.style.width = '0%'; }
      const stopBtn = document.getElementById('btn-fill-stop');
      if (stopBtn) { stopBtn.disabled = false; stopBtn.textContent = 'Stop'; }
      setToolStatus('fill-status-box', 'running', 'Processing 0 / ' + d.missingAIRole + ' pages via Ollama…');
      statusEl.textContent = 'Watch Live Activity feed for per-page progress.';
    }
  } catch (e) {
    setToolStatus('fill-status-box', 'error', '✗ ' + e.message);
    statusEl.textContent = '';
  }

  btnPrev.disabled = false;
}

async function runDedup(dry) {
  const statusEl  = document.getElementById('dedup-status');
  const resultsEl = document.getElementById('dedup-results');
  const btnDry    = document.getElementById('btn-dry-run');
  const btnRun    = document.getElementById('btn-run');

  btnDry.disabled = true;
  btnRun.disabled = true;
  statusEl.textContent = '';
  resultsEl.style.display = 'none';
  setToolStatus('dedup-status-box', 'running', dry ? 'Scanning Notion for duplicates…' : 'Archiving duplicate pages…');

  try {
    const r = await fetch('/notion-dedup?dry=' + dry, { method: 'POST' });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || r.status);

    if (dry) {
      dedupPreviewData = d;
      if (d.duplicateGroups === 0) {
        setToolStatus('dedup-status-box', 'success', '✓ No duplicates found — ' + d.totalPages + ' pages scanned.');
      } else {
        setToolStatus('dedup-status-box', 'running', 'Found <b>' + d.duplicateGroups + '</b> duplicate group(s), <b>' + d.pagesRemoved + '</b> pages to remove. Review below, then click Remove.');
        btnRun.disabled = false;
        resultsEl.style.display = 'block';
        resultsEl.innerHTML = '<table><tr><th>URL</th><th>Keep (oldest)</th><th>Remove</th></tr>'
          + d.dupes.map(row =>
              '<tr><td class="url-cell" title="'+esc(row.url)+'">'+esc(row.url)+'</td>'
              + '<td style="color:#22c55e;white-space:nowrap">'+row.keepCreated.slice(0,10)+'</td>'
              + '<td style="color:#f87171">'+row.remove.map(p=>p.created.slice(0,10)).join(', ')+'</td></tr>'
            ).join('')
          + '</table>';
      }
    } else {
      dedupPreviewData = null;
      setToolStatus('dedup-status-box', 'success', '✓ Archived <b>' + d.pagesRemoved + '</b> duplicate page(s) from <b>' + d.duplicateGroups + '</b> group(s).');
      resultsEl.style.display = 'none';
      addFeedItem('DEDUP', 'tag-save', 'Notion dedup: removed ' + d.pagesRemoved + ' pages');
      loadStats();
    }
  } catch (e) {
    setToolStatus('dedup-status-box', 'error', '✗ ' + e.message);
  }

  btnDry.disabled = false;
}

// ---- Notion Export/Import ----------------------------------------------------
function exportNotionCsv() {
  window.location.href = '/notion-export';
}

let importCsvText = null;

async function runNotionImport(dry) {
  const statusEl  = document.getElementById('import-status');
  const resultsEl = document.getElementById('import-results');
  const btnPrev   = document.getElementById('btn-import-preview');
  const btnRun    = document.getElementById('btn-import-run');
  const fileInput = document.getElementById('import-file');

  if (fileInput.files[0]) {
    importCsvText = await fileInput.files[0].text();
  }
  if (!importCsvText) {
    setToolStatus('import-status-box', 'error', '✗ Choose a CSV file first.');
    return;
  }

  btnPrev.disabled = true;
  btnRun.disabled = true;
  resultsEl.style.display = 'none';
  setToolStatus('import-status-box', 'running', dry ? 'Previewing changes…' : 'Patching Notion pages…');

  try {
    const r = await fetch('/notion-import?dry=' + dry, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ csv: importCsvText }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || r.status);

    if (dry) {
      setToolStatus('import-status-box', 'running', d.updated + ' of ' + d.rows + ' row(s) have changes, ' + d.skipped + ' unchanged/skipped. Review below, then Apply.');
      statusEl.textContent = 'Click Apply Import to patch Notion.';
      btnRun.disabled = d.updated === 0;
      resultsEl.style.display = 'block';
      resultsEl.innerHTML = '<table><tr><th>Page ID</th><th>Fields to update</th></tr>'
        + d.changes.map(c => '<tr><td style="color:#e2e8f0">' + esc(c.pageId) + '</td><td style="color:#64748b">' + esc(c.fields.join(', ')) + '</td></tr>').join('')
        + '</table>';
    } else {
      setToolStatus('import-status-box', 'success', '✓ Patched <b>' + d.updated + '</b> page(s).');
      resultsEl.style.display = 'none';
      statusEl.textContent = '';
      btnRun.disabled = true;
      addFeedItem('IMPORT', 'tag-save', 'Notion import: patched ' + d.updated + ' pages');
    }
  } catch (e) {
    setToolStatus('import-status-box', 'error', '✗ ' + e.message);
  }

  btnPrev.disabled = false;
}
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
