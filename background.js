// Background service worker for LinkedIn DevOps Scanner
// Handles keyboard shortcuts and extension-level events

// Handle keyboard shortcuts
chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-autoscroll') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0] && tabs[0].url && tabs[0].url.includes('linkedin.com')) {
        chrome.tabs.sendMessage(tabs[0].id, {
          action: 'toggleAutoScroll'
        }, (response) => {
          if (chrome.runtime.lastError) {
            console.error('Failed to toggle auto-scroll:', chrome.runtime.lastError);
          } else {
            console.log('Auto-scroll toggled via keyboard shortcut');
          }
        });
      } else {
        console.log('Keyboard shortcut triggered but not on LinkedIn page');
      }
    });
  }
});

// Handle installation and updates
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('Extension installed - showing welcome page');
    chrome.tabs.create({ url: 'welcome.html' });
  } else if (details.reason === 'update') {
    console.log('Extension updated to version', chrome.runtime.getManifest().version);
    chrome.storage.local.get(['lastVersion', 'welcomeCompleted'], (result) => {
      const currentVersion = chrome.runtime.getManifest().version;
      const lastVersion = result.lastVersion;
      if (result.welcomeCompleted && lastVersion && lastVersion !== currentVersion) {
        createWhatsNewNotification(lastVersion, currentVersion);
      }
      chrome.storage.local.set({ lastVersion: currentVersion });
    });
  }
});

function createWhatsNewNotification(oldVersion, newVersion) {
  chrome.storage.local.set({
    showWhatsNew: true,
    whatsNewVersion: newVersion
  });
}

// ---- Scheduled re-scan (stale post detection) --------------------------------

const RESCAN_ALARM = 'devops-rescan-stale';
const RESCAN_PERIOD_MINUTES = 24 * 60;

chrome.alarms.create(RESCAN_ALARM, { periodInMinutes: RESCAN_PERIOD_MINUTES });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== RESCAN_ALARM) return;
  runStaleCheck();
});

async function runStaleCheck() {
  const result = await chrome.storage.local.get(['devopsSavedMatches']);
  const matches = result.devopsSavedMatches || [];
  if (matches.length === 0) return;

  let changed = false;
  for (const match of matches) {
    if (!match.url) continue;
    if (match.status === 'rejected' || match.stale) continue;
    try {
      const res = await fetch(match.url, { method: 'HEAD', credentials: 'omit' });
      if (res.status === 404 || res.status === 410) {
        match.stale = true;
        match.updatedAt = Date.now();
        changed = true;
        console.log('[DevOps Scanner] Stale post detected:', match.url);
      }
    } catch (_) {
      // Network error — skip, don't mark stale on transient failures
    }
  }

  if (changed) {
    await chrome.storage.local.set({ devopsSavedMatches: matches });
  }
}

// ---- Single message listener (reloadKeywords + Notion sync) ------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'reloadKeywords') {
    chrome.tabs.query({ url: 'https://www.linkedin.com/*' }, (tabs) => {
      tabs.forEach(tab => {
        chrome.tabs.sendMessage(tab.id, { action: 'reloadKeywords' }, () => {
          if (chrome.runtime.lastError) {
            console.error('Failed to reload keywords in tab', tab.id, chrome.runtime.lastError);
          }
        });
      });
    });
    sendResponse({ success: true });
    return;
  }

  if (message.action === 'syncMatchToNotion') {
    pushMatchToNotion(message.match).then((res) => {
      // Network/transient failure — queue for retry so the write is never lost
      if (res && res.retryable && message.match && message.match.id) {
        enqueueOutbox({ type: 'push', matchId: message.match.id });
      }
      sendResponse(res);
    });
    return true; // keep channel open for async response
  }

  if (message.action === 'syncNow') {
    pullSyncFromNotion().then(() => drainOutbox());
    sendResponse({ started: true });
    return;
  }
});

// ---- Local AI analysis via Ollama -------------------------------------------
// Calls a local Ollama instance to extract structured fields from a post.
// Returns: { jobTitles, visaSponsorship, confidence }

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
  'For jobTitles: Extract all distinct roles being hired for as an array. If only one role, return a single-element array. If none found, return null.',
  'For visaSponsorship: Extract exactly what visa statuses are mentioned.',
  'Examples: H1B sponsored, No H1B, GC/Citizen only, OPT/CPT accepted, No sponsorship, H1B transfer ok, GC EAD accepted.',
  'If nothing is mentioned return null.',
].join('\n');

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'analyzeWithAI') {
    chrome.storage.local.get(['ollamaUrl', 'ollamaModel'], (result) => {
      const url = (result.ollamaUrl || 'http://localhost:11434').replace(/\/$/, '');
      const model = result.ollamaModel || 'gemma3';
      const startTime = Date.now();

      fetch(`${url}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt: AI_PROMPT(message.text),
          stream: false,
          format: 'json',
        }),
      })
        .then(async r => {
          const rawText = await r.text();
          if (!r.ok) {
            const isContextErr = /context|too long|exceeds/i.test(rawText);
            sendResponse({ error: isContextErr ? 'context_too_long' : `Ollama ${r.status}` });
            return;
          }
          const data = JSON.parse(rawText);
          const timeToProcess = Date.now() - startTime;
          const tokens = (data.prompt_eval_count || 0) + (data.eval_count || 0);
          if (!data.response) {
            sendResponse({ error: 'context_too_long' });
            return;
          }
          try {
            const parsed = JSON.parse(data.response);
            sendResponse({ success: true, analysis: parsed, timeToProcess, model, tokens });
          } catch (_) {
            sendResponse({ error: 'AI returned invalid JSON', raw: data.response });
          }
        })
        .catch(err => sendResponse({ error: err.message }));
    });
    return true;
  }
});

// ---- Atomic saveMatch (prevents multi-tab race on devopsSavedMatches) -------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'saveMatch') {
    chrome.storage.local.get(['devopsSavedMatches'], (result) => {
      const matches = result.devopsSavedMatches || [];
      const match = message.match;
      if (match.url && matches.some(m => m.url === match.url)) {
        sendResponse({ duplicate: true });
        return;
      }
      match.updatedAt = match.updatedAt || Date.now();
      matches.unshift(match);
      if (matches.length > 500) matches.length = 500;
      chrome.storage.local.set({ devopsSavedMatches: matches }, () => {
        if (chrome.runtime.lastError) {
          sendResponse({ error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ saved: true });
        }
      });
    });
    return true;
  }
});

// ---- Atomic updateMatchStatus (prevents multi-tab race on status writes) ----
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'updateMatchStatus') {
    chrome.storage.local.get(['devopsSavedMatches'], (result) => {
      const matches = result.devopsSavedMatches || [];
      const m = matches.find(entry =>
        (message.matchId && entry.id === message.matchId) ||
        (message.url && entry.url === message.url) ||
        (message.snippetPrefix && entry.snippet && entry.snippet.startsWith(message.snippetPrefix))
      );
      if (!m) { sendResponse({ error: 'not found' }); return; }
      m.status = message.status;
      m.updatedAt = Date.now();
      chrome.storage.local.set({ devopsSavedMatches: matches }, () => {
        enqueueOutbox({ type: 'push', matchId: m.id }).then(() => drainOutbox());
        sendResponse({ success: true });
      });
    });
    return true;
  }
});

// ---- Store AI analysis back into the saved match ----------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'storeAIAnalysis') {
    chrome.storage.local.get(['devopsSavedMatches'], (result) => {
      const matches = result.devopsSavedMatches || [];
      const match = matches.find(m => m.id === message.matchId);
      if (!match) { sendResponse({ error: 'match not found' }); return; }
      match.aiAnalysis = message.analysis;
      match.aiAnalyzedAt = Date.now();
      if (message.timeToProcess !== undefined) match.aiTimeToProcess = message.timeToProcess;
      if (message.model) match.aiModel = message.model;
      if (!match.status || match.status === 'new') match.status = 'ai_processed';
      if (message.tokens !== undefined) match.aiTokens = message.tokens;
      match.updatedAt = Date.now();
      chrome.storage.local.set({ devopsSavedMatches: matches }, () => {
        sendResponse({ success: true });
      });
    });
    return true;
  }
});

// ---- Multi-device sync engine ------------------------------------------------
// Notion is the durable source of truth. Every device pushes local mutations
// (with a per-match updatedAt timestamp) and periodically pulls + merges the
// database back. Failed writes go to a persistent outbox and are retried, so
// nothing is lost while offline. Deletes are tombstoned and propagated as page
// archival; remote deletes only flag local copies (notionDeleted), never erase.

const notionHeaders = (token) => ({
  'Authorization': `Bearer ${token}`,
  'Content-Type': 'application/json',
  'Notion-Version': '2022-06-28',
});

const richText = (val) => {
  if (val == null || val === false) return [];
  const str = typeof val === 'string' ? val : String(val);
  if (!str) return [];
  const chunks = [];
  for (let i = 0; i < str.length; i += 2000) {
    chunks.push({ text: { content: str.substring(i, i + 2000) } });
  }
  return chunks;
};

const plainText = (arr) => (arr || []).map(b => b.plain_text || b.text?.content || '').join('');

const toNotionStatus = (s) => {
  if (!s || s === 'new' || s === 'interested') return 'Not started';
  if (s === 'ai_processed') return 'AI Processed';
  if (s === 'applied' || s === 'interviewing') return 'In progress';
  return 'Done'; // offer, rejected, not-interested
};

const fromNotionStatus = (s) => {
  if (s === 'Not started') return 'new';
  if (s === 'AI Processed') return 'ai_processed';
  if (s === 'In progress') return 'applied';
  return null; // 'Done' is ambiguous — keep whatever the local status is
};

// ---- Schema: sync properties auto-added to the Notion database ---------------

const SYNC_PROPS = {
  'Match ID': { rich_text: {} },
  'Local Status': { rich_text: {} },
  'Updated At': { number: {} },
};
let schemaEnsuredFor = null;

async function ensureNotionSchema(token, dbId) {
  if (schemaEnsuredFor === dbId) return true;
  const r = await fetch(`https://api.notion.com/v1/databases/${dbId}`, {
    headers: notionHeaders(token),
  });
  if (!r.ok) throw new Error(`schema check failed: ${r.status}`);
  const db = await r.json();
  const missing = {};
  for (const [name, def] of Object.entries(SYNC_PROPS)) {
    if (!db.properties || !db.properties[name]) missing[name] = def;
  }
  if (Object.keys(missing).length) {
    const pr = await fetch(`https://api.notion.com/v1/databases/${dbId}`, {
      method: 'PATCH',
      headers: notionHeaders(token),
      body: JSON.stringify({ properties: missing }),
    });
    if (!pr.ok) throw new Error(`schema update failed: ${pr.status}`);
  }
  schemaEnsuredFor = dbId;
  return true;
}

// ---- Push ---------------------------------------------------------------------

function buildNotionProperties(match, includeSyncProps) {
  const dateStr = match.timestamp
    ? new Date(match.timestamp).toISOString().split('T')[0]
    : new Date().toISOString().split('T')[0];

  const properties = {
    Name: {
      title: [{ text: { content: match.author || 'Unknown Recruiter' } }],
    },
    ...((match.devopsKeywords || []).length > 0 && { Keywords: { rich_text: richText(match.devopsKeywords.join(', ')) } }),
    Score: {
      number: match.relevanceScore ?? 0,
    },
    Status: {
      status: { name: toNotionStatus(match.status) },
    },
    ...((match.emails || []).length > 0 && { Emails: { rich_text: richText(match.emails.join(', ')) } }),
    Date: {
      date: { start: dateStr },
    },
    Snippet: {
      rich_text: richText(match.fullText || match.snippet || ''),
    },
  };

  if (match.url) properties.URL = { url: match.url };

  // AI-extracted fields (optional — only present if Ollama ran successfully)
  const ai = match.aiAnalysis;
  if (ai) {
    const titles = Array.isArray(ai.jobTitles) ? ai.jobTitles.filter(Boolean) : (ai.jobTitle ? [ai.jobTitle] : []);
    if (titles.length) properties['Job Title'] = { rich_text: richText(titles.join(', ')) };
    properties['VISA'] = { rich_text: richText(ai.visaSponsorship || 'Not mentioned') };
    if (ai.confidence !== undefined) properties['AI Confidence'] = { number: ai.confidence };
  }
  if (match.aiTimeToProcess !== undefined) properties['AI Time (ms)'] = { number: match.aiTimeToProcess };
  if (match.aiModel) properties['AI Model'] = { rich_text: richText(match.aiModel) };
  if (match.aiTokens !== undefined) properties['Tokens'] = { number: match.aiTokens };

  if (includeSyncProps) {
    properties['Match ID'] = { rich_text: richText(match.id) };
    properties['Local Status'] = { rich_text: richText(match.status || 'new') };
    properties['Updated At'] = { number: match.updatedAt || match.timestamp || Date.now() };
  }

  return properties;
}

async function pushMatchToNotion(match) {
  const { notionToken, notionDatabaseId } =
    await chrome.storage.local.get(['notionToken', 'notionDatabaseId']);
  if (!notionToken || !notionDatabaseId) return { skipped: true };

  let schemaOk = false;
  try {
    schemaOk = await ensureNotionSchema(notionToken, notionDatabaseId);
  } catch (e) {
    // Old database without sync props and no permission to add them —
    // push the legacy properties only so the data still lands in Notion
    console.warn('[sync] schema ensure failed:', e.message);
  }

  const properties = buildNotionProperties(match, schemaOk);
  const notionPageId = match.notionPageId;
  const apiUrl = notionPageId
    ? `https://api.notion.com/v1/pages/${notionPageId}`
    : 'https://api.notion.com/v1/pages';
  const body = notionPageId
    ? { properties }
    : { parent: { database_id: notionDatabaseId }, properties };

  try {
    const r = await fetch(apiUrl, {
      method: notionPageId ? 'PATCH' : 'POST',
      headers: notionHeaders(notionToken),
      body: JSON.stringify(body),
    });
    if (r.ok) {
      const data = await r.json();
      await chrome.storage.local.set({ notionLastSync: { ok: true, ts: Date.now(), matchId: match.id } });
      // On first creation, save the Notion page ID back into the match
      if (!notionPageId && data.id) {
        const res = await chrome.storage.local.get(['devopsSavedMatches']);
        const matches = res.devopsSavedMatches || [];
        const m = matches.find(x => x.id === match.id);
        if (m && !m.notionPageId) {
          m.notionPageId = data.id;
          await chrome.storage.local.set({ devopsSavedMatches: matches });
        }
      }
      return { success: true, notionPageId: data.id };
    }
    const t = await r.text();
    // Page was deleted in Notion — mark locally and don't retry as PATCH
    if (r.status === 404 && notionPageId) {
      const res = await chrome.storage.local.get(['devopsSavedMatches']);
      const matches = res.devopsSavedMatches || [];
      const m = matches.find(x => x.id === match.id);
      if (m) {
        m.notionDeleted = true;
        await chrome.storage.local.set({ devopsSavedMatches: matches });
      }
      await chrome.storage.local.set({ notionLastSync: { ok: false, ts: Date.now(), error: `${r.status}: ${t}` } });
      return { error: `${r.status}: ${t}` };
    }
    await chrome.storage.local.set({ notionLastSync: { ok: false, ts: Date.now(), error: `${r.status}: ${t}` } });
    return { error: `${r.status}: ${t}`, retryable: r.status === 429 || r.status >= 500 };
  } catch (err) {
    await chrome.storage.local.set({ notionLastSync: { ok: false, ts: Date.now(), error: err.message } });
    return { error: err.message, retryable: true };
  }
}

// ---- Outbox: persistent retry queue for Notion writes -------------------------

const opSignature = (op) => `${op.type}:${op.matchId || op.notionPageId}`;

async function enqueueOutbox(op) {
  const { notionOutbox } = await chrome.storage.local.get(['notionOutbox']);
  const queue = notionOutbox || [];
  if (queue.some(o => opSignature(o) === opSignature(op))) return;
  queue.push({ ...op, attempts: 0, nextAt: 0 });
  await chrome.storage.local.set({ notionOutbox: queue });
}

let outboxDraining = false;

// Notion allows ~3 req/s; cap each drain so the MV3 worker isn't kept
// alive too long — leftovers are picked up by the next alarm
const OUTBOX_MAX_OPS_PER_DRAIN = 50;
const OUTBOX_OP_SPACING_MS = 350;

async function drainOutbox() {
  if (outboxDraining) return;
  outboxDraining = true;
  try {
    const stored = await chrome.storage.local.get(['notionToken', 'notionDatabaseId', 'notionOutbox']);
    const queue = stored.notionOutbox || [];
    // No credentials yet — keep the queue; it drains once settings sync in
    if (!queue.length || !stored.notionToken || !stored.notionDatabaseId) return;

    const now = Date.now();
    const completed = new Set();
    const backoffs = new Map();
    let processed = 0;

    for (const op of queue) {
      if ((op.nextAt || 0) > now) continue;
      if (processed >= OUTBOX_MAX_OPS_PER_DRAIN) break;
      if (processed > 0) await new Promise(r => setTimeout(r, OUTBOX_OP_SPACING_MS));
      processed++;
      let done = false;

      if (op.type === 'push') {
        const res = await chrome.storage.local.get(['devopsSavedMatches']);
        const match = (res.devopsSavedMatches || []).find(m => m.id === op.matchId);
        if (!match || match.notionDeleted) {
          done = true; // deleted locally or remotely while queued
        } else {
          const result = await pushMatchToNotion(match);
          done = !!(result.success || result.skipped);
        }
      } else if (op.type === 'archive') {
        try {
          const r = await fetch(`https://api.notion.com/v1/pages/${op.notionPageId}`, {
            method: 'PATCH',
            headers: notionHeaders(stored.notionToken),
            body: JSON.stringify({ archived: true }),
          });
          done = r.ok || r.status === 404; // 404 = already gone
        } catch (_) {
          done = false;
        }
      }

      if (done) {
        completed.add(opSignature(op));
      } else {
        const attempts = (op.attempts || 0) + 1;
        backoffs.set(opSignature(op), {
          ...op,
          attempts,
          nextAt: now + Math.min(60000 * 2 ** attempts, 6 * 3600 * 1000),
        });
      }
    }

    // Re-read before writing so ops enqueued during the drain aren't clobbered
    const after = await chrome.storage.local.get(['notionOutbox']);
    const merged = (after.notionOutbox || [])
      .filter(o => !completed.has(opSignature(o)))
      .map(o => backoffs.get(opSignature(o)) || o);
    await chrome.storage.local.set({ notionOutbox: merged });
  } finally {
    outboxDraining = false;
  }
}

// ---- Pull + merge: bring remote changes from other devices into local ----------

function applyRemoteFields(m, props, remoteUpdated) {
  const localStatus = plainText(props['Local Status']?.rich_text);
  const status = localStatus || fromNotionStatus(props.Status?.status?.name);
  if (status) m.status = status;
  const jobTitle = plainText(props['Job Title']?.rich_text);
  const visa = plainText(props['VISA']?.rich_text);
  const confidence = props['AI Confidence']?.number;
  if (jobTitle || visa || confidence != null) {
    m.aiAnalysis = m.aiAnalysis || {};
    if (jobTitle) m.aiAnalysis.jobTitles = jobTitle.split(',').map(s => s.trim()).filter(Boolean);
    if (visa && visa !== 'Not mentioned') m.aiAnalysis.visaSponsorship = visa;
    if (confidence != null) m.aiAnalysis.confidence = confidence;
  }
  m.updatedAt = remoteUpdated;
}

function importMatchFromPage(page, props, remoteUpdated) {
  const fullText = plainText(props.Snippet?.rich_text);
  if (!fullText) return null;
  const keywords = plainText(props.Keywords?.rich_text);
  const m = {
    id: plainText(props['Match ID']?.rich_text) || 'notion:' + page.id,
    notionPageId: page.id,
    author: plainText(props.Name?.title) || 'Unknown',
    fullText,
    snippet: fullText.substring(0, 120),
    url: props.URL?.url || null,
    timestamp: props.Date?.date?.start
      ? new Date(props.Date.date.start).getTime()
      : (page.created_time ? new Date(page.created_time).getTime() : Date.now()),
    devopsKeywords: keywords ? keywords.split(',').map(s => s.trim()).filter(Boolean) : [],
    relevanceScore: props.Score?.number ?? 0,
    status: 'new',
    updatedAt: remoteUpdated,
  };
  applyRemoteFields(m, props, remoteUpdated);
  return m;
}

let pullInProgress = false;

async function pullSyncFromNotion() {
  if (pullInProgress) return;
  pullInProgress = true;
  try {
    const { notionToken, notionDatabaseId } =
      await chrome.storage.local.get(['notionToken', 'notionDatabaseId']);
    if (!notionToken || !notionDatabaseId) return;

    try {
      await ensureNotionSchema(notionToken, notionDatabaseId);
    } catch (e) {
      console.warn('[sync] schema ensure failed during pull:', e.message);
    }

    // Fetch the full database first — no local writes while paginating
    const pages = [];
    let hasMore = true;
    let cursor;
    while (hasMore) {
      const body = { page_size: 100 };
      if (cursor) body.start_cursor = cursor;
      const r = await fetch(`https://api.notion.com/v1/databases/${notionDatabaseId}/query`, {
        method: 'POST',
        headers: notionHeaders(notionToken),
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        await chrome.storage.local.set({ notionLastPull: { ok: false, ts: Date.now(), error: `query ${r.status}` } });
        return;
      }
      const data = await r.json();
      for (const p of (data.results || [])) {
        if (!p.archived) pages.push(p);
      }
      hasMore = data.has_more;
      cursor = data.next_cursor;
    }

    // Single read → merge → write, no awaits in between (avoids clobbering
    // concurrent saves from the message handlers)
    const stored = await chrome.storage.local.get(['devopsSavedMatches', 'devopsTombstones']);
    const matches = stored.devopsSavedMatches || [];
    const tombstones = stored.devopsTombstones || [];
    const tombstonedPageIds = new Set(tombstones.map(t => t.notionPageId).filter(Boolean));
    const activeIds = new Set();
    const pushIds = new Set();
    const archiveIds = [];
    let imported = 0;
    let updated = 0;

    for (const page of pages) {
      activeIds.add(page.id);
      const props = page.properties || {};

      // Deleted on this device while offline — finish the archival
      if (tombstonedPageIds.has(page.id)) {
        archiveIds.push(page.id);
        continue;
      }

      const matchIdProp = plainText(props['Match ID']?.rich_text) || null;
      const urlProp = props.URL?.url || null;
      const remoteUpdated = props['Updated At']?.number
        || (page.last_edited_time ? Date.parse(page.last_edited_time) : 0);

      let m = matches.find(x => x.notionPageId === page.id)
        || (matchIdProp && matches.find(x => x.id === matchIdProp))
        || (urlProp && matches.find(x => x.url === urlProp));

      if (m) {
        if (!m.notionPageId) m.notionPageId = page.id;
        if (m.notionDeleted) delete m.notionDeleted; // page is alive after all
        const localUpdated = m.updatedAt || m.timestamp || 0;
        // Last-write-wins per match, with 1s slack for clock skew
        if (remoteUpdated > localUpdated + 1000) {
          applyRemoteFields(m, props, remoteUpdated);
          updated++;
        } else if (localUpdated > remoteUpdated + 1000) {
          pushIds.add(m.id);
        }
      } else {
        const imp = importMatchFromPage(page, props, remoteUpdated);
        if (imp) {
          matches.unshift(imp);
          imported++;
        }
      }
    }

    for (const m of matches) {
      // Page archived/deleted remotely — flag it, never destroy local data
      if (m.notionPageId && !activeIds.has(m.notionPageId) && !m.notionDeleted) {
        m.notionDeleted = true;
        m.updatedAt = Date.now();
      }
      // Never reached Notion (saved offline, or before creds existed) — push it
      if (!m.notionPageId && !m.notionDeleted) pushIds.add(m.id);
    }

    await chrome.storage.local.set({
      devopsSavedMatches: matches,
      notionLastPull: { ok: true, ts: Date.now(), imported, updated },
    });

    for (const id of pushIds) await enqueueOutbox({ type: 'push', matchId: id });
    for (const pid of archiveIds) await enqueueOutbox({ type: 'archive', notionPageId: pid });
  } catch (e) {
    console.warn('[sync] pull failed:', e.message);
    await chrome.storage.local.set({ notionLastPull: { ok: false, ts: Date.now(), error: e.message } });
  } finally {
    pullInProgress = false;
  }
}

// ---- Atomic delete with tombstones (propagates to Notion + other devices) -----

const TOMBSTONE_TTL_MS = 60 * 24 * 3600 * 1000;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'deleteMatches') {
    chrome.storage.local.get(['devopsSavedMatches', 'devopsTombstones'], (result) => {
      const matches = result.devopsSavedMatches || [];
      const ids = message.clearAll ? matches.map(m => m.id) : (message.ids || []);
      const idSet = new Set(ids);
      const removed = matches.filter(m => idSet.has(m.id));
      const remaining = matches.filter(m => !idSet.has(m.id));
      const now = Date.now();
      const tombstones = (result.devopsTombstones || [])
        .filter(t => now - t.deletedAt < TOMBSTONE_TTL_MS);
      // Only matches that reached Notion need a tombstone — it blocks
      // re-import until the page archival lands
      removed.forEach(m => {
        if (m.notionPageId) tombstones.push({ notionPageId: m.notionPageId, deletedAt: now });
      });
      chrome.storage.local.set({ devopsSavedMatches: remaining, devopsTombstones: tombstones }, () => {
        const archivePromises = removed
          .filter(m => m.notionPageId && !m.notionDeleted)
          .map(m => enqueueOutbox({ type: 'archive', notionPageId: m.notionPageId }));
        Promise.all(archivePromises).then(() => drainOutbox());
        sendResponse({ success: true, deleted: removed.length });
      });
    });
    return true;
  }
});

// ---- Settings mirror: share config across devices via chrome.storage.sync -----

const SYNCED_SETTINGS = ['notionToken', 'notionDatabaseId', 'ollamaUrl', 'ollamaModel', 'customKeywords'];

async function hydrateSettingsFromSync() {
  try {
    const remote = await chrome.storage.sync.get(SYNCED_SETTINGS);
    const local = await chrome.storage.local.get(SYNCED_SETTINGS);
    const updates = {};
    for (const k of SYNCED_SETTINGS) {
      if (local[k] === undefined && remote[k] !== undefined) updates[k] = remote[k];
    }
    if (Object.keys(updates).length) await chrome.storage.local.set(updates);
  } catch (e) {
    console.warn('[sync] settings hydrate failed:', e.message);
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') {
    const updates = {};
    for (const k of SYNCED_SETTINGS) {
      if (k in changes && JSON.stringify(changes[k].newValue) !== JSON.stringify(changes[k].oldValue)) {
        if (changes[k].newValue === undefined) {
          chrome.storage.sync.remove(k);
        } else {
          updates[k] = changes[k].newValue;
        }
      }
    }
    if (Object.keys(updates).length) {
      chrome.storage.sync.set(updates).catch(e =>
        console.warn('[sync] settings mirror failed (quota?):', e.message));
    }
  } else if (area === 'sync') {
    const keys = SYNCED_SETTINGS.filter(k => k in changes);
    if (!keys.length) return;
    chrome.storage.local.get(keys).then(cur => {
      const updates = {};
      for (const k of keys) {
        if (changes[k].newValue !== undefined && JSON.stringify(cur[k]) !== JSON.stringify(changes[k].newValue)) {
          updates[k] = changes[k].newValue;
        }
      }
      if (Object.keys(updates).length) {
        chrome.storage.local.set(updates, () => {
          // Fresh creds from another device — sync immediately
          if ('notionToken' in updates || 'notionDatabaseId' in updates) {
            pullSyncFromNotion().then(() => drainOutbox());
          }
        });
      }
    });
  }
});

// ---- Scheduling ---------------------------------------------------------------

const OUTBOX_ALARM = 'devops-notion-outbox';
const PULL_ALARM = 'devops-notion-pull';

chrome.alarms.create(OUTBOX_ALARM, { periodInMinutes: 5 });
chrome.alarms.create(PULL_ALARM, { periodInMinutes: 10 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === OUTBOX_ALARM) drainOutbox();
  if (alarm.name === PULL_ALARM) pullSyncFromNotion().then(() => drainOutbox());
});

function fullSync() {
  hydrateSettingsFromSync()
    .then(() => pullSyncFromNotion())
    .then(() => drainOutbox());
}

chrome.runtime.onStartup.addListener(fullSync);
chrome.runtime.onInstalled.addListener(fullSync);

console.log('LinkedIn DevOps Scanner background service worker loaded');
