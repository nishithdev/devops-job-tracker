// What's New page script

document.getElementById('close-btn')?.addEventListener('click', () => {
  // Mark as seen
  chrome.storage.local.set({ showWhatsNew: false }, () => {
    window.close();
  });
});

// Auto-close what's new flag after viewing
chrome.storage.local.set({ showWhatsNew: false });
