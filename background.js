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

      const richText = (str) => {
        if (!str) return [];
        // Notion rich_text items max 2000 chars each; split into chunks
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
        Keywords: {
          rich_text: richText((match.devopsKeywords || []).join(', ')),
        },
        Score: {
          number: match.relevanceScore ?? 0,
        },
        Status: {
          status: { name: toNotionStatus(match.status) },
        },
        Emails: {
          rich_text: richText((match.emails || []).join(', ')),
        },
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
        if (ai.jobTitle)          properties['Job Title']        = { rich_text: richText(ai.jobTitle) };
        if (ai.experienceLevel)   properties['Experience Level'] = { rich_text: richText(ai.experienceLevel) };
        if (ai.visaSponsorship)   properties['VISA']             = { rich_text: richText(ai.visaSponsorship) };
        if (ai.confidence !== undefined) properties['AI Confidence'] = { number: ai.confidence };
      }

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
            if (!notionPageId && data.id) {
              chrome.storage.local.get(['devopsSavedMatches'], (res) => {
                const matches = res.devopsSavedMatches || [];
                const m = matches.find(m => m.id === match.id);
                if (m) {
                  m.notionPageId = data.id;
                  chrome.storage.local.set({ devopsSavedMatches: matches });
                }
              });
            }
            sendResponse({ success: true, notionPageId: data.id });
          } else {
            const t = await r.text();
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

// ---- Local AI analysis via Ollama -------------------------------------------
// Calls a local Ollama instance to extract structured fields from a post.
// Returns: { jobTitle, experienceLevel, visaSponsorship, confidence }

const AI_PROMPT = (text) => [
  'You are a job post analyzer. Analyze the following LinkedIn post and extract structured information.',
  'Respond ONLY with a valid JSON object - no markdown, no explanation, no code fences.',
  'Post text:',
  text.substring(0, 1500),
  'JSON schema to fill:',
  '{',
  '  "jobTitle": "exact role title or null",',
  '  "experienceLevel": "junior | mid | senior | lead | any | null",',
  '  "visaSponsorship": "short summary or null",',
  '  "confidence": 0-100',
  '}',
  'For visaSponsorship: Extract exactly what visa statuses are mentioned.',
  'Examples: H1B sponsored, No H1B, GC/Citizen only, OPT/CPT accepted, No sponsorship, H1B transfer ok, GC EAD accepted.',
  'If nothing is mentioned return null.',
].join('\n');

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'analyzeWithAI') {
    chrome.storage.local.get(['ollamaUrl', 'ollamaModel'], (result) => {
      const url = (result.ollamaUrl || 'http://localhost:11434').replace(/\/$/, '');
      const model = result.ollamaModel || 'gemma3';

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
          if (!r.ok) { sendResponse({ error: `Ollama ${r.status}` }); return; }
          const data = await r.json();
          try {
            const parsed = JSON.parse(data.response);
            sendResponse({ success: true, analysis: parsed });
          } catch (_) {
            sendResponse({ error: 'AI returned invalid JSON', raw: data.response });
          }
        })
        .catch(err => sendResponse({ error: err.message }));
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
      chrome.storage.local.set({ devopsSavedMatches: matches }, () => {
        sendResponse({ success: true });
      });
    });
    return true;
  }
});

console.log('LinkedIn DevOps Scanner background service worker loaded');
