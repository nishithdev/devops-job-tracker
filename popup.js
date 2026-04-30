// Enhanced popup script with auto-scroll toggle, recent matches, and status
// Uses shared utilities from shared/utils.js, shared/formatters.js, and shared/storageUtils.js
let autoScrollActive = false;
let currentSpeedPreset = 'balanced';

function updateStatus(status) {
  const indicator = document.getElementById('status-indicator');
  const text = document.getElementById('status-text');
  
  indicator.className = 'status-indicator';
  
  switch (status) {
    case 'scanning':
      indicator.classList.add('scanning');
      text.textContent = 'Scanning...';
      break;
    case 'paused':
      indicator.classList.add('paused');
      text.textContent = 'Auto-Scroll Paused';
      break;
    case 'idle':
    default:
      indicator.classList.add('idle');
      text.textContent = 'Idle';
      break;
  }
}

function updateStats() {
  safeStorageGet([
    'devopsScanCount',
    'devopsScanAnalyzed',
    'devopsSavedMatches',
    'autoScrollState',
    'speedPreset'
  ]).then((res) => {
    // Update stats
    document.getElementById('analyzed').textContent = res.devopsScanAnalyzed || 0;
    document.getElementById('matches').textContent = res.devopsScanCount || 0;
    const savedMatches = res.devopsSavedMatches || [];
    document.getElementById('saved').textContent = savedMatches.length;
    
    // Update auto-scroll state
    autoScrollActive = res.autoScrollState?.active || false;
    currentSpeedPreset = res.speedPreset || 'balanced';
    
    const toggle = document.getElementById('autoscroll-toggle');
    if (toggle) {
      if (autoScrollActive) {
        toggle.classList.add('active');
        updateStatus('scanning');
      } else {
        toggle.classList.remove('active');
        updateStatus('idle');
      }
    }
    
    // Update speed preset display
    const speedText = currentSpeedPreset.charAt(0).toUpperCase() + currentSpeedPreset.slice(1);
    document.getElementById('speed-preset').textContent = `Speed: ${speedText}`;
    
    // Update recent matches
    updateRecentMatches(savedMatches);
  }).catch((error) => {
    console.error('Popup storage error:', error);
  });
}

function updateRecentMatches(matches) {
  const container = document.getElementById('recent-matches');
  
  if (!matches || matches.length === 0) {
    container.innerHTML = '<div class="empty-state">No matches yet. Start browsing LinkedIn!</div>';
    return;
  }
  
  // Get last 3 matches
  const recentMatches = matches
    .filter(m => !m.duplicateOf) // Exclude duplicates
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 3);
  
  if (recentMatches.length === 0) {
    container.innerHTML = '<div class="empty-state">No matches yet. Start browsing LinkedIn!</div>';
    return;
  }
  
  container.innerHTML = recentMatches.map(match => {
    const keywords = [
      ...(match.devopsKeywords || []).slice(0, 3),
      ...(match.skills || []).slice(0, 2)
    ].slice(0, 3);
    
    // Determine badge type
    const badgeEmoji = match.isHiring ? '🔥 Hiring' : '💼 DevOps';
    const badgeClass = match.isHiring ? 'match-badge-hiring' : 'match-badge-devops';
    
    return `
      <div class="match-card" data-url="${match.url || ''}" onclick="openMatchUrl(this)">
        <div class="match-card-header">
          <span class="match-badge ${badgeClass}">${badgeEmoji}</span>
          <span class="match-author">${escapeHtml(match.author || 'Unknown')}</span>
          <span class="match-time">${formatTimeAgo(match.timestamp)}</span>
        </div>
        <div class="match-snippet">${escapeHtml(match.snippet || match.fullText?.substring(0, 80) || 'No preview available')}</div>
        ${keywords.length > 0 ? `
          <div class="match-keywords">
            ${keywords.map(k => `<span class="keyword-pill">${escapeHtml(k)}</span>`).join('')}
          </div>
        ` : ''}
      </div>
    `;
  }).join('');
}

// Open match URL in new tab
window.openMatchUrl = function(element) {
  const url = element.getAttribute('data-url');
  if (url && url !== 'null' && url !== 'undefined') {
    chrome.tabs.create({ url: url });
  }
};

// Toggle auto-scroll
function toggleAutoScroll() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0] && tabs[0].url.includes('linkedin.com')) {
      chrome.tabs.sendMessage(tabs[0].id, {
        action: 'toggleAutoScroll'
      }, (response) => {
        if (chrome.runtime.lastError) {
          console.error('Failed to toggle auto-scroll:', chrome.runtime.lastError);
          alert('Please refresh the LinkedIn page and try again.');
        } else {
          // Update will come via storage change listener
        }
      });
    } else {
      alert('Please open a LinkedIn page first (feed, groups, or search).');
    }
  });
}

// Clear all matches
function clearAllMatches() {
  if (confirm('Are you sure you want to clear all saved matches? This cannot be undone.')) {
    safeStorageSet({
      devopsSavedMatches: [],
      devopsScanCount: 0
    }).then(() => {
      updateStats();
      alert('All matches cleared successfully!');
    }).catch((error) => {
      console.error('Failed to clear matches:', error);
      alert('Failed to clear matches. Please try again.');
    });
  }
}

// Event listeners
document.getElementById('autoscroll-toggle')?.addEventListener('click', toggleAutoScroll);
document.getElementById('clear-matches')?.addEventListener('click', clearAllMatches);

// Listen for storage changes
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') {
    updateStats();
  }
});

// Check for first-time user
function checkFirstTimeUser() {
  safeStorageGet(['welcomeCompleted']).then((result) => {
    if (!result.welcomeCompleted) {
      // Show welcome page on first install
      chrome.tabs.create({ url: 'welcome.html' });
    }
  }).catch((error) => {
    console.error('Error checking first-time user:', error);
  });
}

// Check for version update (What's New)
function checkVersionUpdate() {
  const currentVersion = chrome.runtime.getManifest().version;
  safeStorageGet(['lastVersion']).then((result) => {
    const lastVersion = result.lastVersion;
    
    if (lastVersion && lastVersion !== currentVersion) {
      // Version updated - show what's new
      // We'll implement this in the next step
      safeStorageSet({ lastVersion: currentVersion });
    } else if (!lastVersion) {
      // First install
      safeStorageSet({ lastVersion: currentVersion });
    }
  }).catch((error) => {
    console.error('Error checking version update:', error);
  });
}

// Initialize
updateStats();
checkFirstTimeUser();
checkVersionUpdate();

// Refresh stats every 2 seconds
// setInterval(updateStats, 2000);
