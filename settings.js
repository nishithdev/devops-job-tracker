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
loadNotionSettings();
