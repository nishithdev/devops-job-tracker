// Settings page script
// Uses shared keyword configuration from shared/keywordConfig.js
const DEFAULT_SETTINGS = {
  devopsKeywords: DEFAULT_DEVOPS_KEYWORDS,
  hiringSignals: DEFAULT_HIRING_SIGNALS,
  invalidKeywords: DEFAULT_INVALID_KEYWORDS,
};

let currentSettings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));

// Hit counts loaded from storage (keyword → number of times seen in confirmed matches)
let currentHitCounts = {};

// Disabled keyword sets per category (toggled on/off by the user)
let currentDisabled = {
  devopsKeywords: [],
  hiringSignals: [],
  invalidKeywords: [],
};

// Load settings from storage
function loadSettings() {
  safeStorageGet(['customKeywords', 'keywordHitCounts']).then((result) => {
    if (result.customKeywords) {
      currentSettings = result.customKeywords;
      // Restore disabled state saved alongside keywords
      if (result.customKeywords.disabled) {
        currentDisabled = Object.assign({
          devopsKeywords: [],
          hiringSignals: [],
          invalidKeywords: [],
        }, result.customKeywords.disabled);
      }
    }
    currentHitCounts = result.keywordHitCounts || {};
    renderAllKeywords();
  }).catch((error) => {
    console.error('Failed to load settings:', error);
    renderAllKeywords();
  });
}

// Save settings to storage
function saveSettings() {
  const payload = Object.assign({}, currentSettings, { disabled: currentDisabled });
  safeStorageSet({ customKeywords: payload }).then(() => {
    showSuccessMessage('Settings saved successfully!');
    // Notify content script to reload keywords
    chrome.runtime.sendMessage({ action: 'reloadKeywords' });
  }).catch((error) => {
    console.error('Failed to save settings:', error);
    alert('Failed to save settings. Please try again.');
  });
}

// Reset to defaults
function resetToDefaults() {
  if (confirm('Are you sure you want to reset all keywords to defaults? This cannot be undone.')) {
    currentSettings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    // Also clear all disabled toggles when resetting to defaults
    currentDisabled = { devopsKeywords: [], hiringSignals: [], invalidKeywords: [] };
    saveSettings();
    renderAllKeywords();
  }
}

// Render all keyword groups
function renderAllKeywords() {
  renderKeywords('devopsKeywords', 'devops-keywords', 'devops');
  renderKeywords('hiringSignals', 'hiring-signals', 'hiring');
  renderKeywords('invalidKeywords', 'invalid-keywords', 'exclude');
  updateCounts();
}

// Render keywords for a specific group (with hit count badge + enable/disable toggle)
function renderKeywords(settingKey, containerId, type) {
  const container = document.getElementById(containerId);
  const keywords = currentSettings[settingKey] || [];
  const disabledSet = new Set(currentDisabled[settingKey] || []);

  if (keywords.length === 0) {
    container.innerHTML = '<div class="empty-state">No keywords added yet</div>';
    return;
  }

  container.innerHTML = keywords
    .map((keyword, index) => {
      const isDisabled = disabledSet.has(keyword);
      const hits = currentHitCounts[keyword] || 0;
      const hitBadge = hits > 0
        ? `<span class="keyword-hit-count" title="${hits} match${hits === 1 ? '' : 'es'} seen" style="
            background:rgba(0,0,0,0.18);
            color:inherit;
            border-radius:10px;
            padding:1px 6px;
            font-size:10px;
            font-weight:700;
            margin-left:4px;
            min-width:18px;
            text-align:center;
            display:inline-block;
          ">${hits}</span>`
        : '';
      const toggleTitle = isDisabled ? 'Enable this keyword' : 'Disable this keyword';
      const toggleIcon  = isDisabled ? '○' : '●';
      return `
        <div class="keyword-tag ${type}${isDisabled ? ' keyword-tag--disabled' : ''}" style="${isDisabled ? 'opacity:0.45;text-decoration:line-through;' : ''}">
          ${escapeHtml(keyword)}${hitBadge}
          <button
            onclick="toggleKeyword('${settingKey}', '${keyword.replace(/'/g, "\\'")}')"
            title="${toggleTitle}"
            style="margin-left:4px;background:none;border:none;cursor:pointer;font-size:13px;line-height:1;padding:0 2px;color:inherit;opacity:0.75;"
          >${toggleIcon}</button>
          <button onclick="removeKeyword('${settingKey}', ${index})" title="Remove" style="margin-left:2px;">×</button>
        </div>
      `;
    })
    .join('');
}

// Add keyword(s) to a group
function addKeyword(settingKey, inputId) {
  const input = document.getElementById(inputId);
  const value = input.value.trim();
  
  if (!value) return;
  
  // Split by commas and clean up
  const newKeywords = value
    .split(',')
    .map(k => k.trim().toLowerCase())
    .filter(k => k && !currentSettings[settingKey].includes(k));
  
  if (newKeywords.length === 0) {
    alert('Keyword(s) already exist or invalid');
    return;
  }
  
  currentSettings[settingKey].push(...newKeywords);
  input.value = '';
  renderKeywords(settingKey, getContainerIdFromSetting(settingKey), getTypeFromSetting(settingKey));
  updateCounts();
}

// Remove keyword from a group
window.removeKeyword = function(settingKey, index) {
  currentSettings[settingKey].splice(index, 1);
  renderKeywords(settingKey, getContainerIdFromSetting(settingKey), getTypeFromSetting(settingKey));
  updateCounts();
};

// Toggle a keyword enabled/disabled (does not remove it, just excludes it from scanning)
window.toggleKeyword = function(settingKey, keyword) {
  const disabledList = currentDisabled[settingKey] || [];
  const idx = disabledList.indexOf(keyword);
  if (idx === -1) {
    disabledList.push(keyword);
  } else {
    disabledList.splice(idx, 1);
  }
  currentDisabled[settingKey] = disabledList;
  renderKeywords(settingKey, getContainerIdFromSetting(settingKey), getTypeFromSetting(settingKey));
};

// Helper functions
function getContainerIdFromSetting(settingKey) {
  const map = {
    'devopsKeywords': 'devops-keywords',
    'hiringSignals':  'hiring-signals',
    'invalidKeywords':'invalid-keywords',
  };
  return map[settingKey];
}

function getTypeFromSetting(settingKey) {
  const map = {
    'devopsKeywords': 'devops',
    'hiringSignals':  'hiring',
    'invalidKeywords':'exclude',
  };
  return map[settingKey];
}

function updateCounts() {
  document.getElementById('devops-count').textContent =
    `${currentSettings.devopsKeywords.length} keywords`;
  document.getElementById('hiring-count').textContent =
    `${currentSettings.hiringSignals.length} signals`;
  document.getElementById('invalid-count').textContent =
    `${currentSettings.invalidKeywords.length} keywords`;
}

function showSuccessMessage(message) {
  const msg = document.createElement('div');
  msg.className = 'success-message';
  msg.textContent = message;
  document.body.appendChild(msg);
  setTimeout(() => msg.remove(), 3000);
}

// Event listeners
document.getElementById('btn-save').addEventListener('click', saveSettings);
document.getElementById('btn-reset').addEventListener('click', resetToDefaults);
document.getElementById('btn-reset-confirm').addEventListener('click', resetToDefaults);

document.getElementById('btn-add-devops').addEventListener('click', () =>
  addKeyword('devopsKeywords', 'add-devops'));
document.getElementById('btn-add-hiring').addEventListener('click', () =>
  addKeyword('hiringSignals', 'add-hiring'));
document.getElementById('btn-add-invalid').addEventListener('click', () =>
  addKeyword('invalidKeywords', 'add-invalid'));

// Enter key to add keywords
document.getElementById('add-devops').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') addKeyword('devopsKeywords', 'add-devops');
});
document.getElementById('add-hiring').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') addKeyword('hiringSignals', 'add-hiring');
});
document.getElementById('add-invalid').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') addKeyword('invalidKeywords', 'add-invalid');
});

// Initialize
// ---- Ollama (local AI) -------------------------------------------------------

function loadOllamaSettings() {
  chrome.storage.local.get(['ollamaUrl', 'ollamaModel', 'aiConcurrency'], (result) => {
    if (result.ollamaUrl) document.getElementById('ollama-url').value = result.ollamaUrl;
    if (result.ollamaModel) document.getElementById('ollama-model').value = result.ollamaModel;
    if (result.aiConcurrency) document.getElementById('ollama-concurrency').value = String(result.aiConcurrency);
  });
}

document.getElementById('btn-save-ollama').addEventListener('click', () => {
  const url = document.getElementById('ollama-url').value.trim() || 'http://localhost:11434';
  const model = document.getElementById('ollama-model').value.trim() || 'gemma3';
  const concurrency = parseInt(document.getElementById('ollama-concurrency').value, 10) || 1;
  const status = document.getElementById('ollama-status');
  chrome.storage.local.set({ ollamaUrl: url, ollamaModel: model, aiConcurrency: concurrency }, () => {
    status.textContent = `✅ Saved — ${model} @ ${url} (concurrency: ${concurrency})`;
    status.style.color = '#2e7d32';
    setTimeout(() => { status.textContent = ''; }, 3000);
  });
});

document.getElementById('btn-test-ollama').addEventListener('click', () => {
  const url = (document.getElementById('ollama-url').value.trim() || 'http://localhost:11434').replace(/\/$/, '');
  const model = document.getElementById('ollama-model').value.trim() || 'gemma3';
  const status = document.getElementById('ollama-status');
  status.textContent = `Testing ${model} @ ${url}…`;
  status.style.color = '#757575';

  fetch(`${url}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt: 'Reply with the single word: ok', stream: false }),
  })
    .then(async r => {
      if (r.ok) {
        const d = await r.json();
        status.textContent = `✅ Connected — using ${model} — responded: "${(d.response || '').trim().substring(0, 60)}"`;
        status.style.color = '#2e7d32';
      } else {
        status.textContent = `❌ ${r.status} — is Ollama running and is "${model}" pulled?`;
        status.style.color = '#c62828';
      }
    })
    .catch(err => {
      status.textContent = `❌ ${err.message} — is Ollama running at ${url}?`;
      status.style.color = '#c62828';
    });
});

// ---- Bulk AI processing ------------------------------------------------------

let bulkStopped = false;

async function runBulkAnalysis(matchFilter = null) {
  const progressEl  = document.getElementById('bulk-progress');
  const barEl       = document.getElementById('bulk-progress-bar');
  const textEl      = document.getElementById('bulk-progress-text');
  const startBtn    = document.getElementById('btn-bulk-process');
  const startBtnToday = document.getElementById('btn-bulk-process-today');
  const stopBtn     = document.getElementById('btn-bulk-stop');

  const logEl = document.getElementById('bulk-log');
  const logLine = (msg, type = 'info') => {
    const colors = { info: '#9cdcfe', warn: '#dcdcaa', error: '#f48771', ok: '#4ec994' };
    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    const line = document.createElement('div');
    line.style.color = colors[type] || '#d4d4d4';
    line.textContent = `[${time}] ${msg}`;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  };

  bulkStopped = false;
  startBtn.disabled = true;
  startBtnToday.disabled = true;
  stopBtn.disabled = false;
  stopBtn.style.opacity = '1';
  progressEl.style.display = '';
  logEl.style.display = '';
  logEl.innerHTML = '';
  textEl.textContent = 'Fetching matches from Notion…';
  logLine(matchFilter ? 'Starting AI processing for today\'s posts…' : 'Starting bulk AI processing…');

  // Pull all pages from Notion and merge any that aren't in local storage
  const credsResult = await new Promise(r => chrome.storage.local.get(['notionToken', 'notionDatabaseId', 'devopsSavedMatches'], r));
  let localMatches = credsResult.devopsSavedMatches || [];

  if (credsResult.notionToken && credsResult.notionDatabaseId) {
    try {
      let hasMore = true;
      let cursor = undefined;
      const activeNotionIds = new Set();

      while (hasMore) {
        const body = { page_size: 100 };
        if (cursor) body.start_cursor = cursor;
        const resp = await fetch(`https://api.notion.com/v1/databases/${credsResult.notionDatabaseId}/query`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${credsResult.notionToken}`,
            'Content-Type': 'application/json',
            'Notion-Version': '2022-06-28',
          },
          body: JSON.stringify(body),
        });
        if (!resp.ok) break;
        const data = await resp.json();
        hasMore = data.has_more;
        cursor = data.next_cursor;

        for (const page of (data.results || [])) {
          // Archived = deleted in Notion — treat as source of truth, skip entirely
          if (page.archived) continue;

          activeNotionIds.add(page.id);
          const props = page.properties || {};
          const notionPageId = page.id;

          // Already in local storage — sync Notion AI state back to local
          const existing = localMatches.find(m => m.notionPageId === notionPageId);
          if (existing) {
            const notionJobTitle    = (props['Job Title']?.rich_text   || []).map(b => b.plain_text || '').join('').trim();
            const notionVisa        = (props['VISA']?.rich_text         || []).map(b => b.plain_text || '').join('').trim();
            const notionConfidence  = props['AI Confidence']?.number;
            const missingFields = [
              !notionJobTitle   && 'Job Title',
              !notionVisa       && 'VISA',
              notionConfidence == null && 'AI Confidence',
            ].filter(Boolean);
            if (missingFields.length) {
              existing._missingFields = missingFields;
            } else {
              delete existing._missingFields;
            }
            continue;
          }

          const snippetBlocks = props.Snippet?.rich_text || [];
          const fullText = snippetBlocks.map(b => b.plain_text || b.text?.content || '').join('');
          if (!fullText) continue;
          const nameBlocks = props.Name?.title || [];
          const author = nameBlocks.map(b => b.plain_text || b.text?.content || '').join('') || 'Unknown';
          const urlProp = props.URL?.url || null;
          const ts = page.created_time ? new Date(page.created_time).getTime() : Date.now();
          localMatches.push({
            id: 'notion:' + notionPageId,
            notionPageId,
            author,
            fullText,
            snippet: fullText.substring(0, 120),
            url: urlProp,
            timestamp: ts,
            devopsKeywords: [],
            status: 'new',
          });
        }
      }

      // Mark any local match whose Notion page was deleted/archived
      for (const m of localMatches) {
        if (m.notionPageId && !activeNotionIds.has(m.notionPageId)) {
          m.notionDeleted = true;
        }
      }

      await new Promise(r => chrome.storage.local.set({ devopsSavedMatches: localMatches }, r));
    } catch (e) {
      console.warn('[BulkProcess] Notion fetch failed:', e.message);
      logLine(`Notion fetch error: ${e.message}`, 'error');
    }
  }

  const needsAnalysis = (m) => !m.aiAnalysis || (!m.aiAnalysis._error && !m.aiAnalysis.jobTitles?.length && !m.aiAnalysis.jobTitle) || (m._missingFields && m._missingFields.length > 0);

  const matches = localMatches;
  const deleted  = matches.filter(m => m.notionDeleted).length;
  const analyzed = matches.filter(m => !m.notionDeleted && !needsAnalysis(m)).length;
  const pending  = matches.filter(m => !m.notionDeleted && needsAnalysis(m) && (!matchFilter || matchFilter(m)));

  logLine(`Total: ${matches.length} matches — ${analyzed} analyzed, ${pending.length} pending, ${deleted} deleted/archived`, 'info');

  // Break down pending by which fields are missing
  const fieldCounts = {};
  for (const m of pending) {
    const fields = m._missingFields || ['Job Title', 'VISA', 'AI Confidence'];
    for (const f of fields) fieldCounts[f] = (fieldCounts[f] || 0) + 1;
  }
  if (pending.length > 0) {
    logLine(`Missing field breakdown: ${Object.entries(fieldCounts).map(([f, c]) => `${f} (${c})`).join(', ')}`, 'info');
  }

  if (pending.length === 0) {
    textEl.textContent = '✅ All matches already analyzed.';
    barEl.style.width = '100%';
    logLine('Nothing to process.', 'ok');
    startBtn.disabled = false;
    startBtnToday.disabled = false;
    stopBtn.disabled = true;
    stopBtn.style.opacity = '0.5';
    return;
  }

  logLine(`Starting processing of ${pending.length} match${pending.length !== 1 ? 'es' : ''}…`, 'info');
  let done = 0;
  let errors = 0;

  for (const match of pending) {
    if (bulkStopped) { logLine('Stopped by user.', 'warn'); break; }

    const label = match.author || match.id;
    const missing = match._missingFields && match._missingFields.length ? match._missingFields : null;
    textEl.textContent = `Processing ${done + 1} / ${pending.length} — "${label}"…`;
    logLine(`[${done + 1}/${pending.length}] "${label}" — missing: ${missing ? missing.join(', ') : 'all AI fields'}`, 'warn');

    const text = match.fullText || match.snippet || '';
    if (!text) {
      logLine(`  Skipped — no post text available.`, 'warn');
      done++; continue;
    }

    // AI analysis
    const aiResp = await new Promise(r =>
      chrome.runtime.sendMessage({ action: 'analyzeWithAI', text, matchId: match.id }, r)
    );

    if (aiResp && aiResp.skipped) {
      logLine(`[${done + 1}/${pending.length}] Hash match, skipped re-analysis for "${label}"`, 'ok');
      done++;
      barEl.style.width = `${Math.round(((done) / pending.length) * 100)}%`;
      continue;
    }

    if (aiResp && aiResp.success) {
      // Store AI result and wait for it to flush (merge only missing fields if specified)
      await new Promise(r =>
        chrome.runtime.sendMessage({ action: 'storeAIAnalysis', matchId: match.id, analysis: aiResp.analysis, textHash: aiResp.textHash, timeToProcess: aiResp.timeToProcess, model: aiResp.model, tokens: aiResp.tokens, missingFields: match._missingFields || null }, r)
      );
      // Re-read from storage so notionPageId is included, then PATCH the existing Notion page
      const fresh = await new Promise(r => chrome.storage.local.get(['devopsSavedMatches'], r));
      const freshMatch = (fresh.devopsSavedMatches || []).find(m => m.id === match.id);
      if (freshMatch) {
        const syncResp = await new Promise(r =>
          chrome.runtime.sendMessage({ action: 'syncMatchToNotion', match: freshMatch }, r)
        );
        if (syncResp && syncResp.error) {
          logLine(`[${done + 1}/${pending.length}] Notion sync error for "${label}": ${syncResp.error}`, 'error');
          errors++;
        } else {
          logLine(`[${done + 1}/${pending.length}] OK "${label}" — ${aiResp.tokens ?? '?'} tokens, ${aiResp.timeToProcess ?? '?'}ms`, 'ok');
        }
      }
    } else {
      const errMsg = (aiResp && aiResp.error) || 'no response';
      if (aiResp && aiResp.error === 'context_too_long') {
        await new Promise(r => chrome.runtime.sendMessage({ action: 'storeAIAnalysis', matchId: match.id, analysis: { _error: 'context_too_long' } }, r));
        logLine(`[${done + 1}/${pending.length}] Skipped "${label}" — context too long for model.`, 'warn');
      } else {
        logLine(`[${done + 1}/${pending.length}] AI error for "${label}": ${errMsg}`, 'error');
        errors++;
      }
    }

    done++;
    barEl.style.width = `${Math.round((done / pending.length) * 100)}%`;
  }

  const stopped = bulkStopped ? ' (stopped early)' : '';
  textEl.textContent = `✅ Done — ${done} processed, ${errors} errors${stopped}.`;
  logLine(`Finished: ${done} processed, ${errors} error${errors !== 1 ? 's' : ''}${stopped}.`, errors > 0 ? 'warn' : 'ok');
  startBtn.disabled = false;
  startBtnToday.disabled = false;
  stopBtn.disabled = true;
  stopBtn.style.opacity = '0.5';
}

document.getElementById('btn-bulk-process').addEventListener('click', () => runBulkAnalysis());

document.getElementById('btn-bulk-process-today').addEventListener('click', () => {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const todayEnd   = todayStart + 86400000;
  runBulkAnalysis(m => m.timestamp >= todayStart && m.timestamp < todayEnd);
});

document.getElementById('btn-bulk-stop').addEventListener('click', () => {
  bulkStopped = true;
  document.getElementById('bulk-progress-text').textContent = 'Stopping after current match…';
});

// ---- Notion sync -------------------------------------------------------------

function loadNotionSettings() {
  chrome.storage.local.get(['notionToken', 'notionDatabaseId'], (result) => {
    if (result.notionToken) document.getElementById('notion-token').value = result.notionToken;
    if (result.notionDatabaseId) document.getElementById('notion-database-id').value = result.notionDatabaseId;
  });
}

document.getElementById('btn-save-notion').addEventListener('click', () => {
  const token = document.getElementById('notion-token').value.trim();
  const dbId = document.getElementById('notion-database-id').value.trim();
  const status = document.getElementById('notion-status');
  chrome.storage.local.set({ notionToken: token || null, notionDatabaseId: dbId || null }, () => {
    status.textContent = (token && dbId) ? '✅ Notion credentials saved.' : '🗑️ Notion credentials cleared.';
    status.style.color = '#2e7d32';
    setTimeout(() => { status.textContent = ''; }, 3000);
  });
});

document.getElementById('btn-test-notion').addEventListener('click', () => {
  const token = document.getElementById('notion-token').value.trim();
  const dbId = document.getElementById('notion-database-id').value.trim();
  const status = document.getElementById('notion-status');
  if (!token || !dbId) {
    status.textContent = '⚠️ Enter both the integration token and database ID.';
    status.style.color = '#e65100';
    return;
  }
  status.textContent = 'Testing connection…';
  status.style.color = '#757575';

  // Test by fetching the database metadata
  fetch(`https://api.notion.com/v1/databases/${dbId}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Notion-Version': '2022-06-28',
    },
  })
    .then(async r => {
      if (r.ok) {
        const data = await r.json();
        const name = data.title?.[0]?.plain_text || 'Untitled';
        status.textContent = `✅ Connected to database: "${name}"`;
        status.style.color = '#2e7d32';
      } else {
        const t = await r.text();
        status.textContent = `❌ ${r.status}: ${t}`;
        status.style.color = '#c62828';
      }
    })
    .catch(err => {
      status.textContent = `❌ ${err.message}`;
      status.style.color = '#c62828';
    });
});

loadSettings();
loadOllamaSettings();
loadNotionSettings();
