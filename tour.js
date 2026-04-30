// Interactive Tour System - Lightweight spotlight tour without external dependencies
// This module creates spotlight highlights on LinkedIn pages to guide first-time users

const Tour = {
  currentStep: 0,
  isActive: false,
  overlay: null,
  tooltip: null,
  
  steps: [
    {
      target: null, // No specific target for intro
      title: "Welcome to LinkedIn DevOps Scanner! 👋",
      content: "Let's take a quick tour to show you how everything works. Click Next to begin!",
      position: "center"
    },
    {
      selector: ".feed-shared-update-v2",
      title: "Auto-Detection in Action 🎯",
      content: "As you scroll, the extension automatically scans each post for DevOps keywords and hiring signals. Matched posts get a green outline!",
      position: "left"
    },
    {
      selector: "[data-devops-state='match']",
      title: "Matched Posts 🔥",
      content: "When a post matches, you'll see badges and an 'Open ↗' button. Green badges mean hiring posts, blue badges are DevOps-related content.",
      position: "left",
      fallback: "Look for posts with green outlines when you scroll - those are matches!"
    },
    {
      indicator: true,
      title: "Live Match Counter 📊",
      content: "The counter in the top-right shows how many matches were found. It updates in real-time as you scroll!",
      position: "bottom"
    },
    {
      selector: "#devops-autoscroll-btn",
      title: "Auto-Scroll Feature ⚡",
      content: "Click this button to let the extension automatically scroll and collect matches while you relax. Choose from 5 speed presets!",
      position: "bottom",
      fallback: "Look for the Auto-Scroll button that appears after scrolling a bit."
    },
    {
      target: null,
      title: "Keyboard Shortcut ⌨️",
      content: "Pro tip: Press Ctrl+Shift+S (Mac: Cmd+Shift+S) anytime to toggle auto-scroll on/off!",
      position: "center"
    },
    {
      target: null,
      title: "All Set! 🎉",
      content: "You're ready to find DevOps opportunities! Open the extension popup to view saved matches, customize keywords, or access diagnostics.",
      position: "center"
    }
  ],
  
  init() {
    this.createOverlay();
    this.createTooltip();
  },
  
  createOverlay() {
    this.overlay = document.createElement('div');
    this.overlay.id = 'devops-tour-overlay';
    this.overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.7);
      z-index: 2147483646;
      display: none;
      pointer-events: none;
    `;
  },
  
  createTooltip() {
    this.tooltip = document.createElement('div');
    this.tooltip.id = 'devops-tour-tooltip';
    this.tooltip.style.cssText = `
      position: fixed;
      background: white;
      border-radius: 12px;
      padding: 24px;
      max-width: 400px;
      box-shadow: 0 10px 40px rgba(0,0,0,0.3);
      z-index: 2147483647;
      display: none;
      pointer-events: auto;
    `;
  },
  
  start() {
    if (this.isActive) return;
    
    document.body.appendChild(this.overlay);
    document.body.appendChild(this.tooltip);
    this.isActive = true;
    this.currentStep = 0;
    this.showStep(0);
    
    // Mark tour as started
    chrome.storage.local.set({ tourCompleted: false, tourStarted: true });
  },
  
  showStep(stepIndex) {
    if (stepIndex < 0 || stepIndex >= this.steps.length) {
      this.end();
      return;
    }
    
    const step = this.steps[stepIndex];
    this.currentStep = stepIndex;
    
    // Show overlay
    this.overlay.style.display = 'block';
    
    // Find target element
    let targetElement = null;
    if (step.selector) {
      targetElement = document.querySelector(step.selector);
    }
    
    // Update spotlight
    if (targetElement) {
      this.createSpotlight(targetElement);
    } else {
      this.clearSpotlight();
    }
    
    // Update tooltip
    this.updateTooltip(step, targetElement);
    this.positionTooltip(step, targetElement);
    this.tooltip.style.display = 'block';
  },
  
  createSpotlight(element) {
    const rect = element.getBoundingClientRect();
    const padding = 10;
    
    // Create cutout effect using box-shadow
    const spotlightStyle = `
      position: fixed;
      top: ${rect.top - padding}px;
      left: ${rect.left - padding}px;
      width: ${rect.width + padding * 2}px;
      height: ${rect.height + padding * 2}px;
      box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.7);
      border-radius: 8px;
      z-index: 2147483646;
      pointer-events: none;
    `;
    
    // Remove old spotlight
    const oldSpotlight = document.getElementById('devops-tour-spotlight');
    if (oldSpotlight) oldSpotlight.remove();
    
    // Create new spotlight
    const spotlight = document.createElement('div');
    spotlight.id = 'devops-tour-spotlight';
    spotlight.style.cssText = spotlightStyle;
    document.body.appendChild(spotlight);
    
    // Scroll element into view if needed
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  },
  
  clearSpotlight() {
    const spotlight = document.getElementById('devops-tour-spotlight');
    if (spotlight) spotlight.remove();
  },
  
  updateTooltip(step, targetElement) {
    const progress = `${this.currentStep + 1}/${this.steps.length}`;
    const isFirst = this.currentStep === 0;
    const isLast = this.currentStep === this.steps.length - 1;
    
    this.tooltip.innerHTML = `
      <div style="margin-bottom: 16px;">
        <div style="font-size: 12px; color: #999; margin-bottom: 8px;">${progress}</div>
        <div style="font-size: 20px; font-weight: 700; color: #1565c0; margin-bottom: 8px;">
          ${step.title}
        </div>
        <div style="font-size: 14px; color: #555; line-height: 1.6;">
          ${step.content}
        </div>
        ${step.fallback && !targetElement ? `
          <div style="margin-top: 12px; padding: 10px; background: #fff3e0; border-radius: 6px; font-size: 13px; color: #e65100;">
            💡 ${step.fallback}
          </div>
        ` : ''}
      </div>
      <div style="display: flex; gap: 10px; justify-content: space-between;">
        ${!isFirst ? `
          <button id="tour-prev-btn" style="padding: 10px 20px; background: #e0e0e0; border: none; border-radius: 6px; font-weight: 600; cursor: pointer;">
            ← Previous
          </button>
        ` : '<div></div>'}
        <div style="display: flex; gap: 10px;">
          <button id="tour-skip-btn" style="padding: 10px 20px; background: white; border: 1px solid #ddd; border-radius: 6px; font-weight: 600; cursor: pointer; color: #666;">
            Skip Tour
          </button>
          <button id="tour-next-btn" style="padding: 10px 20px; background: #1565c0; color: white; border: none; border-radius: 6px; font-weight: 600; cursor: pointer;">
            ${isLast ? 'Finish' : 'Next →'}
          </button>
        </div>
      </div>
    `;
    
    // Add event listeners
    const nextBtn = this.tooltip.querySelector('#tour-next-btn');
    const prevBtn = this.tooltip.querySelector('#tour-prev-btn');
    const skipBtn = this.tooltip.querySelector('#tour-skip-btn');
    
    if (nextBtn) {
      nextBtn.addEventListener('click', () => this.next());
    }
    if (prevBtn) {
      prevBtn.addEventListener('click', () => this.previous());
    }
    if (skipBtn) {
      skipBtn.addEventListener('click', () => this.end());
    }
  },
  
  positionTooltip(step, targetElement) {
    if (!targetElement || step.position === 'center') {
      // Center tooltip
      this.tooltip.style.top = '50%';
      this.tooltip.style.left = '50%';
      this.tooltip.style.transform = 'translate(-50%, -50%)';
      this.tooltip.style.bottom = 'auto';
      this.tooltip.style.right = 'auto';
    } else {
      const rect = targetElement.getBoundingClientRect();
      const tooltipRect = this.tooltip.getBoundingClientRect();
      const gap = 20;
      
      // Reset transform
      this.tooltip.style.transform = 'none';
      
      switch (step.position) {
        case 'left':
          this.tooltip.style.top = `${rect.top + rect.height / 2 - tooltipRect.height / 2}px`;
          this.tooltip.style.right = `${window.innerWidth - rect.left + gap}px`;
          this.tooltip.style.left = 'auto';
          this.tooltip.style.bottom = 'auto';
          break;
        case 'right':
          this.tooltip.style.top = `${rect.top + rect.height / 2 - tooltipRect.height / 2}px`;
          this.tooltip.style.left = `${rect.right + gap}px`;
          this.tooltip.style.right = 'auto';
          this.tooltip.style.bottom = 'auto';
          break;
        case 'top':
          this.tooltip.style.bottom = `${window.innerHeight - rect.top + gap}px`;
          this.tooltip.style.left = `${rect.left + rect.width / 2 - tooltipRect.width / 2}px`;
          this.tooltip.style.top = 'auto';
          this.tooltip.style.right = 'auto';
          break;
        case 'bottom':
          this.tooltip.style.top = `${rect.bottom + gap}px`;
          this.tooltip.style.left = `${rect.left + rect.width / 2 - tooltipRect.width / 2}px`;
          this.tooltip.style.right = 'auto';
          this.tooltip.style.bottom = 'auto';
          break;
      }
    }
  },
  
  next() {
    this.showStep(this.currentStep + 1);
  },
  
  previous() {
    this.showStep(this.currentStep - 1);
  },
  
  end() {
    this.isActive = false;
    this.overlay.style.display = 'none';
    this.tooltip.style.display = 'none';
    this.clearSpotlight();
    
    // Mark tour as completed
    chrome.storage.local.set({ tourCompleted: true });
    
    // Clean up
    setTimeout(() => {
      if (this.overlay && this.overlay.parentNode) {
        this.overlay.remove();
      }
      if (this.tooltip && this.tooltip.parentNode) {
        this.tooltip.remove();
      }
    }, 300);
  }
};

// Export for use in content script
if (typeof module !== 'undefined' && module.exports) {
  module.exports = Tour;
}
