// LinkedIn DevOps Scanner - Shared Utilities
// Common utility functions used across multiple files

/**
 * Escape HTML special characters to prevent XSS
 * @param {string} text - Text to escape
 * @returns {string} Escaped HTML
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Create a regex pattern with word boundaries
 * @param {string} keyword - Keyword to create regex for
 * @returns {RegExp} Compiled regex with word boundaries
 */
function createWordBoundaryRegex(keyword) {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b(${escaped})\\b`, 'gi');
}

/**
 * Debounce a function call
 * @param {Function} fn - Function to debounce
 * @param {number} delay - Delay in milliseconds
 * @returns {Function} Debounced function
 */
function debounce(fn, delay) {
  let timeout;
  return function(...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn.apply(this, args), delay);
  };
}

/**
 * Bind multiple event listeners at once
 * @param {Object} mapping - Object mapping element IDs to handler functions
 */
function bindEvents(mapping) {
  Object.entries(mapping).forEach(([id, handler]) => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('click', handler);
    }
  });
}

/**
 * Create a DOM element with options
 * @param {string} tag - HTML tag name
 * @param {Object} options - Element options (className, style, textContent, etc.)
 * @returns {HTMLElement} Created element
 */
function createElement(tag, options = {}) {
  const el = document.createElement(tag);
  
  if (options.className) el.className = options.className;
  if (options.id) el.id = options.id;
  if (options.textContent) el.textContent = options.textContent;
  if (options.innerHTML) el.innerHTML = options.innerHTML;
  
  if (options.style) {
    if (typeof options.style === 'string') {
      el.style.cssText = options.style;
    } else {
      Object.assign(el.style, options.style);
    }
  }
  
  if (options.attrs) {
    Object.entries(options.attrs).forEach(([key, value]) => {
      el.setAttribute(key, value);
    });
  }
  
  if (options.events) {
    Object.entries(options.events).forEach(([event, handler]) => {
      el.addEventListener(event, handler);
    });
  }
  
  return el;
}

/**
 * Safely parse JSON with error handling
 * @param {string} jsonString - JSON string to parse
 * @param {*} defaultValue - Default value if parsing fails
 * @returns {*} Parsed object or default value
 */
function safeJsonParse(jsonString, defaultValue = null) {
  try {
    return JSON.parse(jsonString);
  } catch (e) {
    console.error('[utils] JSON parse error:', e);
    return defaultValue;
  }
}

/**
 * Normalize text: lowercase + collapse all whitespace variants (including
 * non-breaking spaces common in LinkedIn's DOM) to single spaces.
 * @param {string} s
 * @returns {string}
 */
function normalizeText(s) {
  return (s || '').toLowerCase().replace(/[\s ]+/g, ' ').trim();
}

/**
 * Check if extension context is still valid
 * @returns {boolean} True if context is valid
 */
function isContextValid() {
  try {
    // Try to access chrome.runtime
    return !!(chrome && chrome.runtime && chrome.runtime.id);
  } catch (e) {
    return false;
  }
}

/**
 * Log a debug message with consistent formatting
 * @param {string} component - Component name (e.g., 'popup', 'content')
 * @param {string} message - Debug message
 * @param  {...any} args - Additional arguments to log
 */
function debugLog(component, message, ...args) {
  const style = 'background:#1976d2;color:#fff;padding:2px 6px;border-radius:3px;font-weight:bold';
  console.log(`%c[${component}]`, style, message, ...args);
}
