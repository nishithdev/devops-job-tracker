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

      const richText = (str) => str ? [{ text: { content: str.substring(0, 2000) } }] : [];

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
          rich_text: richText(match.snippet || ''),
        },
      };

      if (match.url) properties.URL = { url: match.url };

      const body = { parent: { database_id: notionDatabaseId }, properties };

      const saveNotionStatus = (entry) =>
        chrome.storage.local.set({ notionLastSync: entry });

      fetch('https://api.notion.com/v1/pages', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${notionToken}`,
          'Content-Type': 'application/json',
          'Notion-Version': '2022-06-28',
        },
        body: JSON.stringify(body),
      })
        .then(async r => {
          if (r.ok) {
            saveNotionStatus({ ok: true, ts: Date.now(), matchId: match.id });
            sendResponse({ success: true });
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

console.log('LinkedIn DevOps Scanner background service worker loaded');
