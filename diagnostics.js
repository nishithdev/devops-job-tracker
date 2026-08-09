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
    'devopsScanLast',
    'devopsDiagPosts',
    'devopsStatsDaily',
    'devopsKeywordStats',
    'customKeywords'
  ]).then((result) => {
    allLogs = result.devopsScanDebugLog || [];

    // Update stats
    document.getElementById('stat-analyzed').textContent = result.devopsScanAnalyzed || 0;
    document.getElementById('stat-matches').textContent = result.devopsScanCount || 0;
    document.getElementById('stat-logs').textContent = allLogs.length;
    document.getElementById('stat-diag').textContent = (result.devopsDiagPosts || []).length;
    
    // Update timestamp
    const lastUpdate = result.devopsScanLast 
      ? new Date(result.devopsScanLast).toLocaleString()
      : 'Never';
    document.getElementById('last-update').textContent = `Last scan: ${lastUpdate}`;

    renderDailyStats(result.devopsStatsDaily || {});
    renderKeywordStats(result.devopsKeywordStats || {}, result.customKeywords);
    renderLogs();
  }).catch((error) => {
    console.error('Load error:', error);
    extensionContextValid = false;
    showContextInvalidError();
  });
}

// ---- Stats: matches per day (last 14 days) ----------------------------------
// Data comes from content.js flushClassifyStats → storage key devopsStatsDaily:
// { 'YYYY-MM-DD': { scanned, matched } }
function renderDailyStats(daily) {
  const container = document.getElementById('daily-rows');
  const days = Object.keys(daily).sort().slice(-14);
  if (days.length === 0) {
    container.innerHTML = '<div class="empty-state">No scan data yet — browse LinkedIn with the extension on</div>';
    return;
  }

  const maxScanned = Math.max(...days.map((d) => daily[d].scanned), 1);
  container.innerHTML = days.slice().reverse().map((day) => {
    const { scanned, matched } = daily[day];
    const rate = scanned ? Math.round((matched / scanned) * 100) : 0;
    const scannedPct = Math.round((scanned / maxScanned) * 100);
    const matchedPct = Math.round((matched / maxScanned) * 100);
    return `
      <div class="daily-row">
        <span class="daily-date">${day}</span>
        <div class="daily-bar-track">
          <div class="daily-bar-scanned" style="width:${scannedPct}%"></div>
          <div class="daily-bar-matched" style="width:${matchedPct}%"></div>
        </div>
        <span class="daily-counts">${matched} / ${scanned} <span class="rate">${rate}%</span></span>
      </div>
    `;
  }).join('');
}

// ---- Keyword effectiveness ---------------------------------------------------
// devopsKeywordStats: { keyword: { m: matchFires, s: skipFires, inv: invalidBlocks } }
// Effective keyword lists come from shared/keywordConfig.js resolveKeywords(),
// so never-fired ("dead") keywords show up even with zero stats.
const NOISY_MIN_FIRES = 10;   // don't call a keyword noisy on tiny samples
const NOISY_MAX_MATCH_PCT = 20;

function renderKeywordStats(kwStats, customKeywords) {
  const wrap = document.getElementById('kw-table-wrap');
  const summary = document.getElementById('kw-summary');
  const lists = resolveKeywords(customKeywords);

  const rows = [];
  const addRows = (keywords, cat) => {
    keywords.forEach((k) => {
      const st = kwStats[k] || { m: 0, s: 0, inv: 0 };
      const isInvalidCat = cat === 'invalid';
      const fires = isInvalidCat ? (st.inv || 0) : st.m + st.s;
      const matchPct = !isInvalidCat && fires > 0 ? Math.round((st.m / fires) * 100) : null;
      let status = 'ok';
      if (fires === 0) status = 'dead';
      else if (!isInvalidCat && fires >= NOISY_MIN_FIRES && matchPct < NOISY_MAX_MATCH_PCT) status = 'noisy';
      rows.push({ k, cat, m: st.m, s: st.s, inv: st.inv || 0, fires, matchPct, status });
    });
  };
  addRows(lists.devopsKeywords, 'devops');
  addRows(lists.hiringSignals, 'hiring');
  addRows(lists.invalidKeywords, 'invalid');

  const deadCount = rows.filter((r) => r.status === 'dead').length;
  const noisyCount = rows.filter((r) => r.status === 'noisy').length;
  summary.innerHTML = `
    <span>${rows.length} keywords</span>
    <span><span class="badge badge-noisy">noisy</span> ${noisyCount} — fires often, rarely in matches</span>
    <span><span class="badge badge-dead">dead</span> ${deadCount} — never fired</span>
  `;

  if (rows.every((r) => r.fires === 0)) {
    wrap.innerHTML = '<div class="empty-state">No keyword data yet — browse LinkedIn with the extension on</div>';
    return;
  }

  // Noisy first (worth pruning), then by fire volume; dead tail sorted A-Z.
  const order = { noisy: 0, ok: 1, dead: 2 };
  rows.sort((a, b) =>
    order[a.status] - order[b.status] ||
    b.fires - a.fires ||
    a.k.localeCompare(b.k)
  );

  const badge = { ok: 'badge-ok', dead: 'badge-dead', noisy: 'badge-noisy' };
  wrap.innerHTML = `
    <table class="kw-table">
      <thead>
        <tr>
          <th>Keyword</th><th>Category</th>
          <th class="kw-num">In Matches</th><th class="kw-num">In Skips</th>
          <th class="kw-num">Match %</th><th>Status</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((r) => `
          <tr>
            <td class="kw-name">${escapeHtml(r.k)}</td>
            <td class="cat-${r.cat}">${r.cat}</td>
            <td class="kw-num">${r.cat === 'invalid' ? `${r.inv} blocked` : r.m}</td>
            <td class="kw-num">${r.cat === 'invalid' ? '—' : r.s}</td>
            <td class="kw-num">${r.matchPct === null ? '—' : r.matchPct + '%'}</td>
            <td><span class="badge ${badge[r.status]}">${r.status}</span></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
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

function exportDiagPosts() {
  safeStorageGet(['devopsDiagPosts']).then((result) => {
    const posts = result.devopsDiagPosts || [];
    if (!posts.length) {
      alert('No captured posts. Enable diagnostic capture in Settings first.');
      return;
    }
    const blob = new Blob([JSON.stringify(posts, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `devops-scanner-diag-posts-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }).catch((error) => {
    console.error('Export diag posts error:', error);
  });
}

// Event listeners
document.getElementById('btn-refresh').addEventListener('click', loadData);
document.getElementById('btn-export-diag').addEventListener('click', exportDiagPosts);
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
          changes.devopsScanCount || changes.devopsScanLast || changes.devopsDiagPosts ||
          changes.devopsStatsDaily || changes.devopsKeywordStats) {
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
