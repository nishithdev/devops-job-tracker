// LinkedIn DevOps Scanner - Formatting Utilities
// Functions for formatting time, dates, badges, etc.

/**
 * Format timestamp as relative time (e.g., "2h ago", "5m ago")
 * @param {number} timestamp - Unix timestamp in milliseconds
 * @returns {string} Formatted relative time string
 */
function formatTimeAgo(timestamp) {
  const now = Date.now();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

/**
 * Format timestamp as full date string
 * @param {number} timestamp - Unix timestamp in milliseconds
 * @param {Object} options - Intl.DateTimeFormat options
 * @returns {string} Formatted date string
 */
function formatDate(timestamp, options = {}) {
  const defaults = {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  };
  
  const date = new Date(timestamp);
  return date.toLocaleDateString('en-US', { ...defaults, ...options });
}

/**
 * Create an HTML badge element
 * @param {string} type - Badge type ('hiring', 'devops', 'invalid', 'skill', etc.)
 * @param {string} content - Badge text content
 * @param {Object} options - Additional options (style, className, etc.)
 * @returns {string} HTML string for badge
 */
function createBadge(type, content, options = {}) {
  const className = options.className || `badge badge-${type}`;
  const style = options.style || '';
  const escaped = escapeHtml(content);
  
  return `<span class="${className}" ${style ? `style="${style}"` : ''}>${escaped}</span>`;
}

/**
 * Create multiple badges from an array
 * @param {string[]} items - Array of items to create badges for
 * @param {string} type - Badge type
 * @returns {string} HTML string with all badges
 */
function createBadges(items, type) {
  return items.map(item => createBadge(type, item)).join(' ');
}

/**
 * Format a number with thousands separators
 * @param {number} num - Number to format
 * @returns {string} Formatted number string
 */
function formatNumber(num) {
  return num.toLocaleString('en-US');
}

/**
 * Truncate text to a maximum length with ellipsis
 * @param {string} text - Text to truncate
 * @param {number} maxLength - Maximum length
 * @returns {string} Truncated text
 */
function truncateText(text, maxLength) {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
}
