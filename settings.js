// Settings page script
// Uses shared keyword configuration from shared/keywordConfig.js
const DEFAULT_SETTINGS = {
  devopsKeywords: DEFAULT_DEVOPS_KEYWORDS,
  hiringSignals: DEFAULT_HIRING_SIGNALS,
  invalidKeywords: DEFAULT_INVALID_KEYWORDS,
  skills: DEFAULT_SKILLS
};

let currentSettings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));

// Load settings from storage
function loadSettings() {
  safeStorageGet(['customKeywords']).then((result) => {
    if (result.customKeywords) {
      currentSettings = result.customKeywords;
    }
    renderAllKeywords();
  }).catch((error) => {
    console.error('Failed to load settings:', error);
    renderAllKeywords();
  });
}

// Save settings to storage
function saveSettings() {
  safeStorageSet({ customKeywords: currentSettings }).then(() => {
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
    saveSettings();
    renderAllKeywords();
  }
}

// Render all keyword groups
function renderAllKeywords() {
  renderKeywords('devopsKeywords', 'devops-keywords', 'devops');
  renderKeywords('hiringSignals', 'hiring-signals', 'hiring');
  renderKeywords('invalidKeywords', 'invalid-keywords', 'exclude');
  renderKeywords('skills', 'skills-keywords', 'skill');
  updateCounts();
}

// Render keywords for a specific group
function renderKeywords(settingKey, containerId, type) {
  const container = document.getElementById(containerId);
  const keywords = currentSettings[settingKey] || [];
  
  if (keywords.length === 0) {
    container.innerHTML = '<div class="empty-state">No keywords added yet</div>';
    return;
  }
  
  container.innerHTML = keywords
    .map((keyword, index) => `
      <div class="keyword-tag ${type}">
        ${escapeHtml(keyword)}
        <button onclick="removeKeyword('${settingKey}', ${index})" title="Remove">×</button>
      </div>
    `)
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

// Helper functions
function getContainerIdFromSetting(settingKey) {
  const map = {
    'devopsKeywords': 'devops-keywords',
    'hiringSignals': 'hiring-signals',
    'invalidKeywords': 'invalid-keywords',
    'skills': 'skills-keywords'
  };
  return map[settingKey];
}

function getTypeFromSetting(settingKey) {
  const map = {
    'devopsKeywords': 'devops',
    'hiringSignals': 'hiring',
    'invalidKeywords': 'exclude',
    'skills': 'skill'
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
  document.getElementById('skills-count').textContent = 
    `${currentSettings.skills.length} skills`;
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
document.getElementById('btn-add-skill').addEventListener('click', () => 
  addKeyword('skills', 'add-skill'));

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
document.getElementById('add-skill').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') addKeyword('skills', 'add-skill');
});

// Initialize
loadSettings();
