// Background service worker for LinkedIn DevOps Scanner
// Handles keyboard shortcuts and extension-level events

// ---- Device identity --------------------------------------------------------
// Stable UUID per Chrome profile — used as saved_by fallback when no userName set
function _ensureDeviceId() {
  chrome.storage.local.get(['deviceId'], (s) => {
    if (!s.deviceId) {
      const id = crypto.randomUUID();
      chrome.storage.local.set({ deviceId: id });
      console.log('[DevOps Scanner] Device ID assigned:', id);
    }
  });
}
_ensureDeviceId();

// ---- Save write lock — prevents multi-tab race on same URL ------------------
const _savingUrls = new Set();

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
    chrome.storage.local.set({ lastVersion: chrome.runtime.getManifest().version });
  }
});

// ---- Scheduled tasks --------------------------------------------------------

const NOTION_RETRY_ALARM  = 'devops-notion-retry';
const SERVER_SYNC_ALARM   = 'devops-server-sync';

chrome.alarms.create(NOTION_RETRY_ALARM, { periodInMinutes: 5 });
chrome.alarms.create(SERVER_SYNC_ALARM,  { periodInMinutes: 2 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === NOTION_RETRY_ALARM) runNotionRetryQueue();
  if (alarm.name === SERVER_SYNC_ALARM)  runServerSyncQueue();
});

// ---- Notion retry queue (exponential backoff, max 3 attempts) ---------------

const NOTION_RETRY_DELAY = 5 * 60_000; // 5m, max 2 attempts then drop
const NOTION_RETRY_MAX   = 2;

async function _enqueueNotionRetry(matchId) {
  const s = await chrome.storage.local.get(['notionSyncQueue']);
  const queue = s.notionSyncQueue || [];
  if (queue.some(e => e.matchId === matchId)) return;
  queue.push({ matchId, attempts: 0, nextRetry: Date.now() + NOTION_RETRY_DELAY });
  await chrome.storage.local.set({ notionSyncQueue: queue });
}

async function runNotionRetryQueue() {
  const s = await chrome.storage.local.get(['notionSyncQueue', 'devopsSavedMatches']);
  const queue = s.notionSyncQueue || [];
  if (!queue.length) return;

  const now = Date.now();
  const ready = queue.filter(e => e.nextRetry <= now);
  if (!ready.length) return;

  const matches = s.devopsSavedMatches || [];
  const remaining = queue.filter(e => e.nextRetry > now);

  for (const entry of ready) {
    const match = matches.find(m => m.id === entry.matchId);
    if (!match) continue;

    const result = await _syncMatchToNotion(match);
    if (result.success || result.skipped) continue;

    entry.attempts++;
    if (entry.attempts >= NOTION_RETRY_MAX) continue; // drop after 2 attempts
    entry.nextRetry = now + NOTION_RETRY_DELAY;
    remaining.push(entry);
  }

  await chrome.storage.local.set({ notionSyncQueue: remaining });
}

// ---- Server sync retry queue ------------------------------------------------

const SERVER_SYNC_DELAYS = [2 * 60_000, 10 * 60_000, 30 * 60_000]; // 2m, 10m, 30m

async function _enqueueServerSync(match) {
  const s = await chrome.storage.local.get(['serverSyncQueue']);
  const queue = s.serverSyncQueue || [];
  if (queue.some(e => e.match.id === match.id)) return;
  queue.push({ match, attempts: 0, nextRetry: Date.now() + SERVER_SYNC_DELAYS[0] });
  await chrome.storage.local.set({ serverSyncQueue: queue });
  console.log('[DevOps Scanner] Queued for server sync:', match.id);
  // Notify content scripts so they can show the "Local only" pill
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, {
        action: 'serverSyncQueued',
        matchId: match.id,
        url: match.url,
      }).catch(() => {});
    }
  });
}

async function runServerSyncQueue() {
  const s = await chrome.storage.local.get(['serverSyncQueue', 'localServerUrl', 'notionUserName', 'devopsSavedMatches']);
  const queue = s.serverSyncQueue || [];
  if (!queue.length || !s.localServerUrl) return;

  const now = Date.now();
  const ready = queue.filter(e => e.nextRetry <= now);
  if (!ready.length) return;

  const remaining = queue.filter(e => e.nextRetry > now);

  const savedMatches = s.devopsSavedMatches || [];
  for (const entry of ready) {
    try {
      // Use fresh match from storage so notionPageId synced since enqueue is included
      const fresh = savedMatches.find(m => m.id === entry.match.id);
      const matchToSend = fresh || entry.match;
      const r = await fetch(`${s.localServerUrl}/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ match: matchToSend, userName: s.notionUserName || null }),
      });
      if (r.ok) {
        console.log('[DevOps Scanner] Server sync retry succeeded:', entry.match.id);
        // Notify content scripts so they can update the "Local only" pill
        chrome.tabs.query({}, (tabs) => {
          for (const tab of tabs) {
            chrome.tabs.sendMessage(tab.id, {
              action: 'serverSyncComplete',
              matchId: entry.match.id,
              url: entry.match.url,
            }).catch(() => {});
          }
        });
        continue; // don't re-add to remaining
      }
    } catch (_) {}

    entry.attempts++;
    if (entry.attempts < SERVER_SYNC_DELAYS.length) {
      entry.nextRetry = now + SERVER_SYNC_DELAYS[entry.attempts];
      remaining.push(entry);
    } else {
      console.log('[DevOps Scanner] Server sync retry exhausted, dropping:', entry.match.id);
    }
  }

  await chrome.storage.local.set({ serverSyncQueue: remaining });
}

// ---- Badge count (new matches since last popup open) ------------------------

async function _incrementBadge() {
  const s = await chrome.storage.local.get(['badgeCount']);
  const next = (s.badgeCount || 0) + 1;
  await chrome.storage.local.set({ badgeCount: next });
  chrome.action.setBadgeText({ text: String(next) });
  chrome.action.setBadgeBackgroundColor({ color: '#1976d2' });
}

async function _clearBadge() {
  await chrome.storage.local.set({ badgeCount: 0 });
  chrome.action.setBadgeText({ text: '' });
}

// Restore badge on SW restart
chrome.storage.local.get(['badgeCount'], (s) => {
  const count = s.badgeCount || 0;
  if (count > 0) {
    chrome.action.setBadgeText({ text: String(count) });
    chrome.action.setBadgeBackgroundColor({ color: '#1976d2' });
  }
});

// Queries Notion for an existing page matching a LinkedIn post URL.
// Returns the page object or null.
async function queryNotionByUrl(url, token, databaseId) {
  try {
    const r = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28',
      },
      body: JSON.stringify({
        filter: { property: 'URL', url: { equals: url } },
        page_size: 1,
      }),
    });
    if (!r.ok) return null;
    const data = await r.json();
    return data.results?.[0] || null;
  } catch (_) {
    return null;
  }
}

// ---- Single message dispatch table ------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.action) {
    case 'reloadKeywords':   return handleReloadKeywords(message, sendResponse);
    case 'syncMatchToNotion': return handleSyncMatchToNotion(message, sendResponse);
    case 'analyzeWithAI':    return handleAnalyzeWithAI(message, sendResponse);
    case 'saveMatch':        return handleSaveMatch(message, sendResponse);
    case 'updateMatchStatus': return handleUpdateMatchStatus(message, sendResponse);
    case 'storeAIAnalysis':  return handleStoreAIAnalysis(message, sendResponse);
    case 'clearBadge':       _clearBadge(); sendResponse({ ok: true }); return;
  }
});

function handleReloadKeywords(message, sendResponse) {
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
}

function handleSyncMatchToNotion(message, sendResponse) {
  _syncMatchToNotion(message.match).then(sendResponse);
  return true; // keep channel open for async response
}

async function _syncMatchToNotion(match) {
  const stored = await new Promise(r =>
    chrome.storage.local.get(['notionToken', 'notionDatabaseId', 'notionUserName'], r)
  );
  const { notionToken, notionDatabaseId, notionUserName } = stored;
  if (!notionToken || !notionDatabaseId) return { skipped: true };

  const saveNotionStatus = (entry) => chrome.storage.local.set({ notionLastSync: entry });

  const toNotionStatus = (s) => {
    if (!s || s === 'new' || s === 'interested') return 'Not started';
    if (s === 'ai_processed') return 'AI Processed';
    if (s === 'applied' || s === 'interviewing') return 'In progress';
    return 'Done';
  };

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

  const dateStr = match.timestamp
    ? new Date(match.timestamp).toISOString().split('T')[0]
    : new Date().toISOString().split('T')[0];

  const buildProperties = () => {
    const props = {
      Name:   { title: [{ text: { content: match.author || 'Unknown Recruiter' } }] },
      Score:  { number: match.relevanceScore ?? 0 },
      Status: { status: { name: toNotionStatus(match.status) } },
      Date:   { date: { start: dateStr } },
      Snippet: { rich_text: richText(match.fullText || match.snippet || '') },
    };
    if ((match.devopsKeywords || []).length > 0) props.Keywords = { rich_text: richText(match.devopsKeywords.join(', ')) };
    if ((match.emails || []).length > 0) props.Emails = { rich_text: richText(match.emails.join(', ')) };
    if (match.url) props.URL = { url: match.url };
    if (notionUserName) props['Saved By'] = { rich_text: richText(notionUserName) };

    const ai = match.aiAnalysis;
    if (ai) {
      const titles = Array.isArray(ai.jobTitles) ? ai.jobTitles.filter(Boolean) : (ai.jobTitle ? [ai.jobTitle] : []);
      if (titles.length) props['Job Title'] = { rich_text: richText(titles.join(', ')) };
      props['VISA'] = { rich_text: richText(ai.visaSponsorship || 'Not mentioned') };
      if (ai.confidence !== undefined) props['AI Confidence'] = { number: ai.confidence };
    }
    if (match.aiTimeToProcess !== undefined) props['AI Time (ms)'] = { number: match.aiTimeToProcess };
    if (match.aiModel) props['AI Model'] = { rich_text: richText(match.aiModel) };
    if (match.aiTokens !== undefined) props['Tokens'] = { number: match.aiTokens };
    return props;
  };

  // Resolve notionPageId: use local cache, or query Notion by URL (multi-user dedup)
  let notionPageId = match.notionPageId;
  if (!notionPageId && match.url) {
    const existing = await queryNotionByUrl(match.url, notionToken, notionDatabaseId);
    if (existing) {
      notionPageId = existing.id;
      // Store it locally so future calls skip the query
      chrome.storage.local.get(['devopsSavedMatches'], (res) => {
        const matches = res.devopsSavedMatches || [];
        const m = matches.find(m => m.id === match.id);
        if (m) { m.notionPageId = notionPageId; chrome.storage.local.set({ devopsSavedMatches: matches }); }
      });
    }
  }

  const properties = buildProperties();
  const apiUrl    = notionPageId ? `https://api.notion.com/v1/pages/${notionPageId}` : 'https://api.notion.com/v1/pages';
  const apiMethod = notionPageId ? 'PATCH' : 'POST';
  const body      = notionPageId ? { properties } : { parent: { database_id: notionDatabaseId }, properties };

  try {
    const r = await fetch(apiUrl, {
      method: apiMethod,
      headers: {
        'Authorization': `Bearer ${notionToken}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28',
      },
      body: JSON.stringify(body),
    });

    if (r.ok) {
      const data = await r.json();
      saveNotionStatus({ ok: true, ts: Date.now(), matchId: match.id });
      if (data.id) {
        chrome.storage.local.get(['devopsSavedMatches', 'localServerUrl'], (res) => {
          const matches = res.devopsSavedMatches || [];
          const m = matches.find(m => m.id === match.id);
          if (m) { m.notionPageId = data.id; chrome.storage.local.set({ devopsSavedMatches: matches }); }
          // Relay notionPageId to server so other users can find it on dedup
          if (res.localServerUrl && match.url) {
            fetch(`${res.localServerUrl}/notion-page-id`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ url: match.url, matchId: match.id, notionPageId: data.id }),
            }).catch(() => {});
          }
        });
      }
      return { success: true, notionPageId: data.id };
    }

    const errText = await r.text();
    // 404 on PATCH = page deleted in Notion — clear local ID and retry as POST
    if (r.status === 404 && notionPageId) {
      chrome.storage.local.get(['devopsSavedMatches'], (res) => {
        const matches = res.devopsSavedMatches || [];
        const m = matches.find(m => m.id === match.id);
        if (m) { delete m.notionPageId; chrome.storage.local.set({ devopsSavedMatches: matches }); }
      });
      // Retry once as a fresh POST
      return _syncMatchToNotion({ ...match, notionPageId: undefined });
    }
    saveNotionStatus({ ok: false, ts: Date.now(), error: `${r.status}: ${errText}` });
    if (match.id) _enqueueNotionRetry(match.id);
    return { error: `${r.status}: ${errText}` };
  } catch (err) {
    saveNotionStatus({ ok: false, ts: Date.now(), error: err.message });
    if (match.id) _enqueueNotionRetry(match.id);
    return { error: err.message };
  }
}

// ---- Text hash (djb2) -------------------------------------------------------
function hashText(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h) ^ str.charCodeAt(i);
  return (h >>> 0).toString(36);
}

// ---- AI concurrency queue ---------------------------------------------------
let _aiActive = 0;
const _aiQueue = [];

function _drainAIQueue() {
  chrome.storage.local.get(['aiConcurrency'], (s) => {
    const limit = Math.max(1, Math.min(3, s.aiConcurrency || 1));
    while (_aiActive < limit && _aiQueue.length) {
      _aiActive++;
      const { text, resolve } = _aiQueue.shift();
      _runOllamaRequest(text).then(result => {
        _aiActive--;
        resolve(result);
        _drainAIQueue();
      });
    }
  });
}

function _enqueueAI(text) {
  return new Promise(resolve => {
    _aiQueue.push({ text, resolve });
    _drainAIQueue();
  });
}

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

async function _runOllamaRequest(text) {
  const s = await new Promise(r => chrome.storage.local.get(['ollamaUrl', 'ollamaModel'], r));
  const url = (s.ollamaUrl || 'http://localhost:11434').replace(/\/$/, '');
  const model = s.ollamaModel || 'gemma3';
  const startTime = Date.now();
  try {
    const r = await fetch(`${url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: AI_PROMPT(text), stream: false, format: 'json' }),
    });
    const rawText = await r.text();
    if (!r.ok) {
      const isContextErr = /context|too long|exceeds/i.test(rawText);
      return { error: isContextErr ? 'context_too_long' : `Ollama ${r.status}` };
    }
    const data = JSON.parse(rawText);
    const timeToProcess = Date.now() - startTime;
    const tokens = (data.prompt_eval_count || 0) + (data.eval_count || 0);
    if (!data.response) return { error: 'context_too_long' };
    try {
      const parsed = JSON.parse(data.response);
      return { success: true, analysis: parsed, timeToProcess, model, tokens };
    } catch (_) {
      return { error: 'AI returned invalid JSON', raw: data.response };
    }
  } catch (err) {
    return { error: err.message };
  }
}

function handleAnalyzeWithAI(message, sendResponse) {
  const text = message.text || '';
  const incomingHash = hashText(text);

  chrome.storage.local.get(['localServerUrl', 'ollamaUrl', 'ollamaModel', 'devopsSavedMatches'], async (s) => {
    // Check local cache first regardless of server
    if (message.matchId) {
      const match = (s.devopsSavedMatches || []).find(m => m.id === message.matchId);
      if (match && match.aiTextHash === incomingHash && match.aiAnalysis && !match.aiAnalysis._error) {
        sendResponse({ success: true, analysis: match.aiAnalysis, skipped: true });
        return;
      }
    }

    // Server path: shared queue + hash cache
    if (s.localServerUrl) {
      try {
        const r = await fetch(`${s.localServerUrl}/ai`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text, hash: incomingHash,
            ollamaUrl: s.ollamaUrl || 'http://localhost:11434',
            ollamaModel: s.ollamaModel || 'gemma3',
          }),
        });
        const result = await r.json();
        if (result.success) result.textHash = incomingHash;
        sendResponse(result);
        return;
      } catch (_) {
        // Fall through to local Ollama
      }
    }

    // Local fallback
    _enqueueAI(text).then(result => {
      if (result.success) result.textHash = incomingHash;
      sendResponse(result);
    });
  });
  return true;
}

// ---- Atomic saveMatch — local-first, parallel background sync ---------------
// Priority: local storage (instant) → server + Notion fire in parallel after respond
function handleSaveMatch(message, sendResponse) {
  chrome.storage.local.get(['localServerUrl', 'notionUserName', 'devopsSavedMatches', 'deviceId'], (s) => {
    const match = message.match;
    const existing = s.devopsSavedMatches || [];

    // Layer 1 dedup: URL match in local storage (same Chrome profile)
    if (match.url && existing.some(m => m.url === match.url)) {
      sendResponse({ duplicate: true });
      return;
    }

    // Write lock: prevent two tabs saving same URL simultaneously
    if (match.url && _savingUrls.has(match.url)) {
      sendResponse({ duplicate: true });
      return;
    }
    if (match.url) _savingUrls.add(match.url);

    // Stable identity: notionUserName > deviceId UUID > anonymous
    const userName = s.notionUserName || s.deviceId || null;

    // Save locally — respond immediately, don't wait for server or Notion
    existing.unshift(match);
    if (existing.length > 500) existing.length = 500;
    chrome.storage.local.set({ devopsSavedMatches: existing }, () => {
      if (match.url) _savingUrls.delete(match.url);

      if (chrome.runtime.lastError) {
        sendResponse({ error: chrome.runtime.lastError.message });
        return;
      }
      _incrementBadge();
      sendResponse({ saved: true }); // instant — content.js unblocked now

      // Fire server POST in background (non-blocking)
      if (s.localServerUrl) {
        fetch(`${s.localServerUrl}/save`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ match, userName }),
        }).then(r => r.json()).then(data => {
          if (data.duplicate && data.notionPageId) {
            // Another device already saved — pull their notionPageId into local
            chrome.storage.local.get(['devopsSavedMatches'], (res) => {
              const matches = res.devopsSavedMatches || [];
              const m = matches.find(m => m.url === match.url || m.id === match.id);
              if (m && !m.notionPageId) {
                m.notionPageId = data.notionPageId;
                chrome.storage.local.set({ devopsSavedMatches: matches });
              }
            });
          }
        }).catch(() => _enqueueServerSync(match)); // server offline — retry queue
      }
    });
  });
  return true;
}

// ---- Atomic updateMatchStatus (prevents multi-tab race on status writes) ----
function handleUpdateMatchStatus(message, sendResponse) {
  chrome.storage.local.get(['devopsSavedMatches'], (result) => {
    const matches = result.devopsSavedMatches || [];
    const m = matches.find(entry =>
      (message.matchId && entry.id === message.matchId) ||
      (message.url && entry.url === message.url) ||
      (message.snippetPrefix && entry.snippet && entry.snippet.startsWith(message.snippetPrefix))
    );
    if (!m) { sendResponse({ error: 'not found' }); return; }
    m.status = message.status;
    chrome.storage.local.set({ devopsSavedMatches: matches }, () => {
      sendResponse({ success: true });
    });
  });
  return true;
}

// ---- Store AI analysis back into the saved match ----------------------------
function handleStoreAIAnalysis(message, sendResponse) {
  chrome.storage.local.get(['devopsSavedMatches'], (result) => {
    const matches = result.devopsSavedMatches || [];
    const match = matches.find(m => m.id === message.matchId);
    if (!match) { sendResponse({ error: 'match not found' }); return; }

    const incoming = message.analysis || {};
    const missingFields = message.missingFields; // null = full replace, array = merge only these
    if (missingFields && missingFields.length && match.aiAnalysis && !match.aiAnalysis._error) {
      const existing = match.aiAnalysis;
      if (missingFields.includes('Job Title')) {
        existing.jobTitles = incoming.jobTitles;
        existing.jobTitle  = incoming.jobTitle;
      }
      if (missingFields.includes('VISA'))          existing.visaSponsorship = incoming.visaSponsorship;
      if (missingFields.includes('AI Confidence')) existing.confidence      = incoming.confidence;
      match.aiAnalysis = existing;
    } else {
      match.aiAnalysis = incoming;
    }
    delete match._missingFields;
    match.aiAnalyzedAt = Date.now();
    if (message.textHash) match.aiTextHash = message.textHash;
    if (message.timeToProcess !== undefined) match.aiTimeToProcess = message.timeToProcess;
    if (message.model) match.aiModel = message.model;
    if (!match.status || match.status === 'new') match.status = 'ai_processed';
    if (message.tokens !== undefined) match.aiTokens = message.tokens;
    chrome.storage.local.set({ devopsSavedMatches: matches }, () => {
      sendResponse({ success: true });
    });
  });
  return true;
}

// ---- WebSocket client (real-time cross-user match push) ---------------------

let _ws = null;
let _wsReconnectTimer = null;
let _wsWasConnected = false;
let _wsReconnectAttempts = 0;

function _connectWS(serverUrl) {
  if (_ws && (_ws.readyState === WebSocket.CONNECTING || _ws.readyState === WebSocket.OPEN)) return;
  const wsUrl = serverUrl.replace(/^http/, 'ws') + '/ws';
  try {
    _ws = new WebSocket(wsUrl);
  } catch (_) { return; }

  _ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.action === 'newMatch' && msg.url) {
        chrome.tabs.query({ url: 'https://www.linkedin.com/*' }, (tabs) => {
          tabs.forEach(tab => {
            chrome.tabs.sendMessage(tab.id, {
              action: 'matchSavedByOther',
              url: msg.url,
              savedBy: msg.savedBy || null,
            }, () => { chrome.runtime.lastError; /* suppress */ });
          });
        });
      }
    } catch (_) {}
  };

  _ws.onopen = () => {
    _wsWasConnected = true;
    _wsReconnectAttempts = 0;
    chrome.notifications.clear('server-reconnect-failed');
  };

  _ws.onclose = () => {
    if (_wsWasConnected) {
      _wsWasConnected = false;
      _wsReconnectAttempts = 0;
      chrome.notifications.create('server-disconnect', {
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: 'Job Tracker: Server disconnected',
        message: 'Lost connection to local server. Reconnecting…',
        priority: 1,
      });
    } else {
      _wsReconnectAttempts++;
      // Notify at 3, 10, 30 attempts (~15s, ~50s, ~2.5min)
      if (_wsReconnectAttempts === 3 || _wsReconnectAttempts === 10 || _wsReconnectAttempts === 30) {
        chrome.notifications.create('server-reconnect-failed', {
          type: 'basic',
          iconUrl: 'icons/icon48.png',
          title: 'Job Tracker: Server still unreachable',
          message: `Reconnect attempt ${_wsReconnectAttempts} failed. Notion sync and AI processing are paused.`,
          priority: 2,
        });
      }
    }
    _ws = null;
    clearTimeout(_wsReconnectTimer);
    _wsReconnectTimer = setTimeout(() => {
      chrome.storage.local.get(['localServerUrl'], (s) => {
        if (s.localServerUrl) _connectWS(s.localServerUrl);
      });
    }, 5000);
  };

  _ws.onerror = () => _ws && _ws.close();
}

// Connect on startup if server URL is configured
chrome.storage.local.get(['localServerUrl'], (s) => {
  if (s.localServerUrl) _connectWS(s.localServerUrl);
});

// Reconnect when server URL changes via settings
chrome.storage.onChanged.addListener((changes) => {
  if (changes.localServerUrl) {
    if (_ws) { _ws.onclose = null; _ws.close(); _ws = null; }
    clearTimeout(_wsReconnectTimer);
    if (changes.localServerUrl.newValue) _connectWS(changes.localServerUrl.newValue);
  }
});

console.log('LinkedIn DevOps Scanner background service worker loaded');
