// LinkedIn DevOps Scanner - Modal Factory
// Unified modal creation with configurable options

/**
 * Create a modal dialog with overlay
 * @param {Object} config - Modal configuration
 * @param {string} config.icon - Emoji icon to display
 * @param {string} config.title - Modal title
 * @param {string} config.message - Modal message text
 * @param {Array} config.buttons - Array of button configurations
 * @param {Function} config.onClose - Optional callback when modal is closed
 * @param {Object} config.styles - Optional custom styles
 * @returns {HTMLElement} The overlay element
 */
function createModal(config) {
  const {
    icon = '💡',
    title = 'Notification',
    message = '',
    buttons = [],
    onClose = null,
    styles = {}
  } = config;
  
  // Ensure animations are added only once
  ensureModalAnimations();
  
  // Create modal overlay
  const overlay = document.createElement('div');
  overlay.className = 'devops-scan-modal-overlay';
  overlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.5);
    z-index: 999999;
    display: flex;
    align-items: center;
    justify-content: center;
    animation: fadeIn 0.3s ease-in;
    ${styles.overlay || ''}
  `;
  
  // Create modal content
  const modal = document.createElement('div');
  modal.className = 'devops-scan-modal';
  modal.style.cssText = `
    background: white;
    border-radius: 8px;
    padding: 24px;
    max-width: 400px;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
    text-align: center;
    animation: slideDown 0.3s ease-out;
    ${styles.modal || ''}
  `;
  
  // Icon
  const iconEl = document.createElement('div');
  iconEl.style.cssText = `
    font-size: 48px;
    margin-bottom: 16px;
    ${styles.icon || ''}
  `;
  iconEl.textContent = icon;
  
  // Title
  const titleEl = document.createElement('h2');
  titleEl.style.cssText = `
    margin: 0 0 12px 0;
    font-size: 20px;
    font-weight: 600;
    color: #333;
    ${styles.title || ''}
  `;
  titleEl.textContent = title;
  
  // Message
  const messageEl = document.createElement('p');
  messageEl.style.cssText = `
    margin: 0 0 24px 0;
    font-size: 14px;
    color: #666;
    line-height: 1.5;
    ${styles.message || ''}
  `;
  messageEl.innerHTML = message;
  
  // Buttons container
  const buttonsContainer = document.createElement('div');
  buttonsContainer.style.cssText = `
    display: flex;
    gap: 12px;
    justify-content: center;
    ${styles.buttonsContainer || ''}
  `;
  
  // Create buttons
  buttons.forEach(btnConfig => {
    const btn = createModalButton(btnConfig, overlay, onClose);
    buttonsContainer.appendChild(btn);
  });
  
  // Assemble modal
  modal.appendChild(iconEl);
  modal.appendChild(titleEl);
  modal.appendChild(messageEl);
  if (buttons.length > 0) {
    modal.appendChild(buttonsContainer);
  }
  
  overlay.appendChild(modal);
  
  return overlay;
}

/**
 * Create a button for the modal
 * @param {Object} btnConfig - Button configuration
 * @param {HTMLElement} overlay - Overlay element to remove on click
 * @param {Function} onClose - Callback when modal closes
 * @returns {HTMLElement} Button element
 */
function createModalButton(btnConfig, overlay, onClose) {
  const {
    label = 'OK',
    icon = '',
    onClick = null,
    variant = 'primary', // 'primary', 'secondary', 'danger'
    closeOnClick = true
  } = btnConfig;
  
  const btn = document.createElement('button');
  btn.textContent = icon ? `${icon} ${label}` : label;
  
  // Button styles based on variant
  const variantStyles = {
    primary: {
      background: '#2e7d32',
      hover: '#1b5e20'
    },
    secondary: {
      background: '#424242',
      hover: '#616161'
    },
    danger: {
      background: '#d32f2f',
      hover: '#b71c1c'
    }
  };
  
  const colors = variantStyles[variant] || variantStyles.primary;
  
  btn.style.cssText = `
    padding: 12px 24px;
    background: ${colors.background};
    color: white;
    border: none;
    border-radius: 4px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.2s;
  `;
  
  btn.addEventListener('mouseenter', () => {
    btn.style.background = colors.hover;
  });
  btn.addEventListener('mouseleave', () => {
    btn.style.background = colors.background;
  });
  
  btn.addEventListener('click', () => {
    if (onClick) {
      onClick();
    }
    
    if (closeOnClick) {
      closeModal(overlay, onClose);
    }
  });
  
  return btn;
}

/**
 * Close and remove a modal
 * @param {HTMLElement} overlay - Overlay element to remove
 * @param {Function} onClose - Optional callback when closed
 */
function closeModal(overlay, onClose) {
  if (overlay && overlay.parentNode) {
    overlay.parentNode.removeChild(overlay);
  }
  if (onClose) {
    onClose();
  }
}

/**
 * Show a modal (convenience wrapper)
 * @param {Object} config - Modal configuration
 */
function showModal(config) {
  const overlay = createModal(config);
  document.body.appendChild(overlay);
  return overlay;
}

/**
 * Ensure modal animations are added to the page (only once)
 */
function ensureModalAnimations() {
  if (document.querySelector('style[data-devops-scan-modal-animations]')) {
    return; // Already added
  }
  
  const style = document.createElement('style');
  style.setAttribute('data-devops-scan-modal-animations', 'true');
  style.textContent = `
    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    @keyframes slideDown {
      from { 
        opacity: 0;
        transform: translateY(-20px);
      }
      to { 
        opacity: 1;
        transform: translateY(0);
      }
    }
  `;
  document.head.appendChild(style);
}
