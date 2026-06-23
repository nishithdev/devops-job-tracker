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
    const toNotionStatus = (s) => {
      if (!s || s === 'new' || s === 'interested') return 'Not started';
      if (s === 'ai_processed') return 'AI Processed';
      if (s === 'applied' || s === 'interviewing') return 'In progress';
      return 'Done'; // offer, rejected, not-interested
    };
    chrome.storage.local.get(['notionToken', 'notionDatabaseId'], (result) => {
      const { notionToken, notionDatabaseId } = result;
      if (!notionToken || !notionDatabaseId) { sendResponse({ skipped: true }); return; }

      const match = message.match;
      const dateStr = match.timestamp
        ? new Date(match.timestamp).toISOString().split('T')[0]
        : new Date().toISOString().split('T')[0];

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

      const saveNotionStatus = (entry) =>
        chrome.storage.local.set({ notionLastSync: entry });

      // If we already have a Notion page ID for this match, PATCH it instead of creating a new page
      const notionPageId = match.notionPageId;
      const apiUrl    = notionPageId
        ? `https://api.notion.com/v1/pages/${notionPageId}`
        : 'https://api.notion.com/v1/pages';
      const apiMethod = notionPageId ? 'PATCH' : 'POST';
      const body      = notionPageId
        ? { properties }
        : { parent: { database_id: notionDatabaseId }, properties };

      fetch(apiUrl, {
        method: apiMethod,
        headers: {
          'Authorization': `Bearer ${notionToken}`,
          'Content-Type': 'application/json',
          'Notion-Version': '2022-06-28',
        },
        body: JSON.stringify(body),
      })
        .then(async r => {
          if (r.ok) {
            const data = await r.json();
            saveNotionStatus({ ok: true, ts: Date.now(), matchId: match.id });
            // On first creation, save the Notion page ID back into the match
            if (data.id) {
              chrome.storage.local.get(['devopsSavedMatches'], (res) => {
                const matches = res.devopsSavedMatches || [];
                const m = matches.find(m => m.id === match.id);
                if (m) {
                  m.notionPageId = data.id;
                  delete m.notionDeleted;
                  chrome.storage.local.set({ devopsSavedMatches: matches });
                }
              });
            }
            sendResponse({ success: true, notionPageId: data.id });
          } else {
            const t = await r.text();
            // Page was deleted in Notion — mark locally and don't retry as PATCH
            if (r.status === 404 && notionPageId) {
              chrome.storage.local.get(['devopsSavedMatches'], (res) => {
                const matches = res.devopsSavedMatches || [];
                const m = matches.find(m => m.id === match.id);
                if (m) {
                  m.notionDeleted = true;
                  chrome.storage.local.set({ devopsSavedMatches: matches });
                }
              });
            }
            saveNotionStatus({ ok: false, ts: Date.now(), error: `${r.status}: ${t}` });
            sendResponse({ error: `${r.status}: ${t}` });
          }
        })
        .catch(err => {
          saveNotionStatus({ ok: false, ts: Date.now(), error: err.message });
          sendResponse({ error: err.message });
        });
    });
    return true; // keep channel open for async response
  }
});

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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'analyzeWithAI') {
    const text = message.text || '';
    const incomingHash = hashText(text);

    // Skip if caller supplied matchId and hash matches stored hash
    if (message.matchId) {
      chrome.storage.local.get(['devopsSavedMatches'], (res) => {
        const match = (res.devopsSavedMatches || []).find(m => m.id === message.matchId);
        if (match && match.aiTextHash === incomingHash && match.aiAnalysis && !match.aiAnalysis._error) {
          sendResponse({ success: true, analysis: match.aiAnalysis, skipped: true });
          return;
        }
        _enqueueAI(text).then(result => {
          if (result.success) result.textHash = incomingHash;
          sendResponse(result);
        });
      });
    } else {
      _enqueueAI(text).then(result => {
        if (result.success) result.textHash = incomingHash;
        sendResponse(result);
      });
    }
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
      chrome.storage.local.set({ devopsSavedMatches: matches }, () => {
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

      const incoming = message.analysis || {};
      const missingFields = message.missingFields; // null = full replace, array = merge only these
      if (missingFields && missingFields.length && match.aiAnalysis && !match.aiAnalysis._error) {
        // Merge only the fields that were missing — leave others intact
        const existing = match.aiAnalysis;
        if (missingFields.includes('Job Title')) {
          existing.jobTitles = incoming.jobTitles;
          existing.jobTitle  = incoming.jobTitle;
        }
        if (missingFields.includes('VISA'))         existing.visaSponsorship = incoming.visaSponsorship;
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
});

console.log('LinkedIn DevOps Scanner background service worker loaded');
