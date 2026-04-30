// Background service worker for LinkedIn DevOps Scanner
// Handles keyboard shortcuts and extension-level events

// Handle keyboard shortcuts
chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-autoscroll') {
    // Get the active tab
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0] && tabs[0].url && tabs[0].url.includes('linkedin.com')) {
        // Send message to content script to toggle auto-scroll
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
        // Show notification that user needs to be on LinkedIn
        console.log('Keyboard shortcut triggered but not on LinkedIn page');
      }
    });
  }
});

// Handle installation and updates
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('Extension installed - showing welcome page');
    // Open welcome page on first install
    chrome.tabs.create({ url: 'welcome.html' });
  } else if (details.reason === 'update') {
    console.log('Extension updated to version', chrome.runtime.getManifest().version);
    // Check if we should show "What's New"
    chrome.storage.local.get(['lastVersion', 'welcomeCompleted'], (result) => {
      const currentVersion = chrome.runtime.getManifest().version;
      const lastVersion = result.lastVersion;
      
      // Only show what's new if they've completed welcome before
      if (result.welcomeCompleted && lastVersion && lastVersion !== currentVersion) {
        // Create what's new notification
        createWhatsNewNotification(lastVersion, currentVersion);
      }
      
      // Update version
      chrome.storage.local.set({ lastVersion: currentVersion });
    });
  }
});

// Create "What's New" notification
function createWhatsNewNotification(oldVersion, newVersion) {
  // Store notification flag
  chrome.storage.local.set({
    showWhatsNew: true,
    whatsNewVersion: newVersion
  });
}

// Handle messages from content scripts and popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'reloadKeywords') {
    // Broadcast to all LinkedIn tabs to reload keywords
    chrome.tabs.query({ url: 'https://www.linkedin.com/*' }, (tabs) => {
      tabs.forEach(tab => {
        chrome.tabs.sendMessage(tab.id, { action: 'reloadKeywords' }, (response) => {
          if (chrome.runtime.lastError) {
            console.error('Failed to reload keywords in tab', tab.id, chrome.runtime.lastError);
          }
        });
      });
    });
    sendResponse({ success: true });
  }
  
  return true; // Keep message channel open for async response
});

console.log('LinkedIn DevOps Scanner background service worker loaded');
