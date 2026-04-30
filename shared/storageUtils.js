// LinkedIn DevOps Scanner - Storage Utilities
// Wrapper functions for chrome.storage API with error handling

/**
 * Safely get data from chrome.storage.local (Promise-based)
 * @param {string|string[]|null} keys - Storage key(s) to retrieve
 * @returns {Promise<Object>} Promise resolving to the storage result
 */
function safeStorageGet(keys) {
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.get(keys, (result) => {
        if (chrome.runtime.lastError) {
          console.error('[storage] Get error:', chrome.runtime.lastError);
          reject(chrome.runtime.lastError);
          return;
        }
        resolve(result);
      });
    } catch (e) {
      console.error('[storage] Get exception:', e);
      reject(e);
    }
  });
}

/**
 * Safely set data in chrome.storage.local (Promise-based)
 * @param {Object} data - Data to store
 * @returns {Promise<void>} Promise resolving when data is stored
 */
function safeStorageSet(data) {
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.set(data, () => {
        if (chrome.runtime.lastError) {
          console.error('[storage] Set error:', chrome.runtime.lastError);
          reject(chrome.runtime.lastError);
          return;
        }
        resolve();
      });
    } catch (e) {
      console.error('[storage] Set exception:', e);
      reject(e);
    }
  });
}

/**
 * Safely remove data from chrome.storage.local (Promise-based)
 * @param {string|string[]} keys - Storage key(s) to remove
 * @returns {Promise<void>} Promise resolving when data is removed
 */
function safeStorageRemove(keys) {
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.remove(keys, () => {
        if (chrome.runtime.lastError) {
          console.error('[storage] Remove error:', chrome.runtime.lastError);
          reject(chrome.runtime.lastError);
          return;
        }
        resolve();
      });
    } catch (e) {
      console.error('[storage] Remove exception:', e);
      reject(e);
    }
  });
}

/**
 * Create a storage change listener with filtering
 * @param {string[]} watchKeys - Keys to watch (null = all keys)
 * @param {Function} callback - Callback function (changes, areaName)
 * @returns {Function} The actual listener function (for removal)
 */
function createStorageObserver(watchKeys, callback) {
  const listener = (changes, areaName) => {
    if (areaName !== 'local') return;
    
    // If watchKeys is null, call callback for all changes
    if (!watchKeys) {
      callback(changes, areaName);
      return;
    }
    
    // Filter changes to only watched keys
    const relevantChanges = {};
    let hasRelevantChanges = false;
    
    Object.keys(changes).forEach(key => {
      if (watchKeys.includes(key)) {
        relevantChanges[key] = changes[key];
        hasRelevantChanges = true;
      }
    });
    
    if (hasRelevantChanges) {
      callback(relevantChanges, areaName);
    }
  };
  
  chrome.storage.onChanged.addListener(listener);
  return listener;
}

/**
 * Remove a storage change listener
 * @param {Function} listener - The listener function to remove
 */
function removeStorageObserver(listener) {
  chrome.storage.onChanged.removeListener(listener);
}

/**
 * Get storage data with default values
 * @param {Object} defaults - Object mapping keys to default values
 * @param {Function} callback - Callback with merged result
 */
function getWithDefaults(defaults, callback) {
  const keys = Object.keys(defaults);
  safeStorageGet(keys, (result) => {
    const merged = { ...defaults, ...result };
    callback(merged);
  });
}
