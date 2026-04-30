// Diagnostics page script
// Uses shared utilities from shared/utils.js and shared/storageUtils.js
let allLogs = [];
let extensionContextValid = true;

function showContextInvalidError() {
  const container = document.getElementById('log-entries');
  container.innerHTML = `
    <div style="padding:40px;text-align:center;">
      <h2 style="color:#d32f2f;margin-bottom:12px;">Extension Context Invalidated</h2>
      <p style="color:#999;margin-bottom:20px;">The extension was reloaded or updated.</p>
      <button onclick="window.location.reload()" style="padding:10px 20px;background:#2e7d32;color:white;border:none;border-radius:6px;cursor:pointer;font-size:14px;">
        Reload This Page
      </button>
    </div>
  `;
  // Clear intervals
  if (window.refreshInterval) clearInterval(window.refreshInterval);
}

function loadData() {
  if (!isContextValid()) {
    extensionContextValid = false;
    showContextInvalidError();
    return;
  }
  
  safeStorageGet([
    'devopsScanDebugLog',
    'devopsScanAnalyzed',
    'devopsScanCount',
    'devopsScanLast'
  ]).then((result) => {
    allLogs = result.devopsScanDebugLog || [];
    
    // Update stats
    document.getElementById('stat-analyzed').textContent = result.devopsScanAnalyzed || 0;
    document.getElementById('stat-matches').textContent = result.devopsScanCount || 0;
    document.getElementById('stat-logs').textContent = allLogs.length;
    
    // Update timestamp
    const lastUpdate = result.devopsScanLast 
      ? new Date(result.devopsScanLast).toLocaleString()
      : 'Never';
    document.getElementById('last-update').textContent = `Last scan: ${lastUpdate}`;
    
    renderLogs();
  }).catch((error) => {
    console.error('Load error:', error);
    extensionContextValid = false;
    showContextInvalidError();
  });
}

function renderLogs(filter = '') {
  const container = document.getElementById('log-entries');
  
  let logs = allLogs;
  if (filter) {
    const lowerFilter = filter.toLowerCase();
    logs = allLogs.filter(entry => 
      entry.message.toLowerCase().includes(lowerFilter) ||
      entry.time.toLowerCase().includes(lowerFilter)
    );
  }
  
  if (logs.length === 0) {
    container.innerHTML = '<div class="empty-state">No log entries' + 
      (filter ? ' matching filter' : '') + '</div>';
    return;
  }
  
  // Reverse to show newest first
  const html = logs.slice().reverse().map(entry => {
    const time = new Date(entry.time).toLocaleTimeString();
    return `
      <div class="log-entry">
        <span class="log-time">${time}</span>
        <span class="log-message">${escapeHtml(entry.message)}</span>
      </div>
    `;
  }).join('');
  
  container.innerHTML = html;
}

function clearLogs() {
  if (!isContextValid()) {
    extensionContextValid = false;
    showContextInvalidError();
    return;
  }
  
  if (!confirm('Clear all debug logs? This cannot be undone.')) return;
  
  safeStorageSet({ devopsScanDebugLog: [] }).then(() => {
    allLogs = [];
    renderLogs();
    document.getElementById('stat-logs').textContent = '0';
  }).catch((error) => {
    console.error('Clear logs error:', error);
    extensionContextValid = false;
    showContextInvalidError();
  });
}

function exportLogs() {
  const data = {
    exportedAt: new Date().toISOString(),
    stats: {
      analyzed: parseInt(document.getElementById('stat-analyzed').textContent),
      matches: parseInt(document.getElementById('stat-matches').textContent),
      logEntries: allLogs.length
    },
    logs: allLogs
  };
  
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `devops-scanner-logs-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// Event listeners
document.getElementById('btn-refresh').addEventListener('click', loadData);
document.getElementById('btn-clear').addEventListener('click', clearLogs);
document.getElementById('btn-export').addEventListener('click', exportLogs);

let filterTimeout;
document.getElementById('filter-input').addEventListener('input', (e) => {
  clearTimeout(filterTimeout);
  filterTimeout = setTimeout(() => {
    renderLogs(e.target.value);
  }, 300);
});

// Listen for storage changes and update instantly
try {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (!isContextValid()) {
      extensionContextValid = false;
      return;
    }
    if (areaName === 'local') {
      // Reload if any relevant key changed
      if (changes.devopsScanDebugLog || changes.devopsScanAnalyzed || 
          changes.devopsScanCount || changes.devopsScanLast) {
        loadData();
      }
    }
  });
} catch (e) {
  console.error('Failed to setup storage listener:', e);
  extensionContextValid = false;
  showContextInvalidError();
}

// Auto-refresh every 5 seconds as backup
window.refreshInterval = setInterval(() => {
  if (isContextValid()) {
    loadData();
  }
}, 5000);

// Initial load
loadData();
