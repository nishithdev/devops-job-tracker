// LinkedIn DevOps Role Scanner - content script
// Scans posts on the feed and content search pages, marks matches, and adds
// an "Open in new tab" button to each.

// ---- SMOKE TEST (top-level, runs immediately) ----
console.log(
  "%c[devops-scan] CONTENT SCRIPT INJECTED",
  "background:#2e7d32;color:#fff;padding:2px 6px;border-radius:3px;font-weight:bold"
);
try {
  const _smokeBanner = document.createElement("div");
  _smokeBanner.id = "devops-scan-smoke";
  _smokeBanner.textContent = "DevOps Scanner: content script is loaded";
  _smokeBanner.style.cssText =
    "position:fixed;top:0;left:0;right:0;background:#2e7d32;color:#fff;font:14px/1.4 sans-serif;padding:6px 12px;z-index:2147483647;text-align:center";
  
  const removeBanner = () => {
    if (_smokeBanner && _smokeBanner.parentNode) {
      _smokeBanner.remove();
    }
  };
  
  if (document.body) {
    document.body.appendChild(_smokeBanner);
    setTimeout(removeBanner, 3000);
  } else {
    const addWhenReady = () => {
      if (document.body) {
        document.body.appendChild(_smokeBanner);
        setTimeout(removeBanner, 3000);
      }
    };
    if (document.readyState === 'loading') {
      document.addEventListener("DOMContentLoaded", addWhenReady, { once: true });
    } else {
      // DOM already loaded but body not available yet - wait a tick
      setTimeout(addWhenReady, 0);
    }
  }
} catch (e) {
  console.error("[devops-scan] smoke test failed", e);
}
// ---- END SMOKE TEST ----

(() => {
  "use strict";

  // ---- Match configuration -------------------------------------------------
  // A post matches when it contains at least one DEVOPS keyword. Posts with
  // HIRING signals get a stronger badge (🔥 Hiring), while posts with just
  // DevOps keywords show a blue DevOps badge.
  
  // Active keywords (loaded from storage or defaults from shared/keywordConfig.js)
  let DEVOPS_KEYWORDS = [...DEFAULT_DEVOPS_KEYWORDS];
  let HIRING_SIGNALS = [...DEFAULT_HIRING_SIGNALS];
  let EXCLUDE_KEYWORDS = [...DEFAULT_EXCLUDE_KEYWORDS];
  let INVALID_KEYWORDS = [...DEFAULT_INVALID_KEYWORDS];
  let SKILLS = [...DEFAULT_SKILLS];
  
  // Load custom keywords from storage
  function loadCustomKeywords() {
    chrome.storage.local.get(['customKeywords'], (result) => {
      if (result.customKeywords) {
        DEVOPS_KEYWORDS = result.customKeywords.devopsKeywords || DEFAULT_DEVOPS_KEYWORDS;
        HIRING_SIGNALS = result.customKeywords.hiringSignals || DEFAULT_HIRING_SIGNALS;
        EXCLUDE_KEYWORDS = result.customKeywords.invalidKeywords || DEFAULT_EXCLUDE_KEYWORDS;
        INVALID_KEYWORDS = result.customKeywords.invalidKeywords || DEFAULT_INVALID_KEYWORDS;
        SKILLS = result.customKeywords.skills || DEFAULT_SKILLS;
        
        dbg("Custom keywords loaded from settings");
        dbg("DevOps keywords:", DEVOPS_KEYWORDS.length);
        dbg("Hiring signals:", HIRING_SIGNALS.length);
        dbg("Exclude keywords:", EXCLUDE_KEYWORDS.length);
        dbg("Skills:", SKILLS.length);
      } else {
        dbg("Using default keywords (no custom settings found)");
      }
    });
  }
  
  // Load keywords on init
  loadCustomKeywords();

  const MARK_ATTR = "data-devops-scanner";
  const MATCH_CLASS = "devops-scan-match";
  const BTN_CLASS = "devops-scan-open-btn";
  const BADGE_CLASS = "devops-scan-badge";

  // Selectors for posts. LinkedIn changes class names often, so we use
  // stable data-testid attributes when available, and cast a wide net otherwise.
  // We dedupe later by walking up to the closest "post" container.
  const POST_SELECTORS = [
    // New LinkedIn feed (2024+) uses data-testid
    "[data-testid='expandable-text-box']",
    // Legacy selectors (groups, older layouts)
    "[data-urn*=':activity:']",
    "[data-urn*=':share:']",
    "[data-urn*=':ugcPost:']",
    "div.feed-shared-update-v2",
    "div.fie-impression-container",
    "div.update-components-update-v2",
    "div.scaffold-finite-scroll__content > div",
  ];

  // When we find a candidate, walk up to the nearest stable post root so
  // multiple inner-element matches collapse to one post.
  // For new LinkedIn, we walk up from expandable-text-box to the post card.
  const POST_ROOT_SELECTORS = [
    "div.feed-shared-update-v2",
    "div.fie-impression-container",
    "div.update-components-update-v2",
    "[data-urn*=':activity:']",
    "[data-urn*=':share:']",
    "[data-urn*=':ugcPost:']",
  ];

  const DEBUG = true;
  const debugLog = []; // Circular buffer for persistent log review
  const MAX_LOG_ENTRIES = 200;

  function dbg(...args) {
    if (!DEBUG) return;
    console.log("[devops-scan]", ...args);
    
    // Store in circular buffer
    const entry = {
      time: new Date().toISOString(),
      message: args.map(a => {
        if (typeof a === 'object' && a !== null) {
          // For DOM elements, store a simple descriptor
          if (a instanceof Element) {
            return `<${a.tagName.toLowerCase()}${a.className ? '.' + a.className.split(' ').join('.') : ''}${a.id ? '#' + a.id : ''}>`;
          }
          return JSON.stringify(a);
        }
        return String(a);
      }).join(' ')
    };
    
    debugLog.push(entry);
    if (debugLog.length > MAX_LOG_ENTRIES) {
      debugLog.shift(); // Remove oldest
    }
    
    // Persist to storage (throttled via timeout to avoid excessive writes)
    clearTimeout(dbg._saveTimer);
    dbg._saveTimer = setTimeout(() => {
      try {
        if (chrome.storage && chrome.storage.local) {
          chrome.storage.local.set({ devopsScanDebugLog: debugLog }, () => {
            if (chrome.runtime.lastError) {
              // Silently handle - extension may have been reloaded
            }
          });
        }
      } catch (e) {
        // Extension context invalidated - skip storage
      }
    }, 1000);
  }

  // ---- Helpers -------------------------------------------------------------
  const lower = (s) => (s || "").toLowerCase();

  function findAny(haystack, needles) {
    return needles.find((n) => {
      // Use word boundary matching for short keywords (3 chars or less)
      // to avoid false positives:
      //   "sre" should NOT match "insure", "ensure", "disrespect"
      //   "aks" should NOT match "tasks", "breaks", "speaks"
      //   "eks" should NOT match "weeks", "seeks", "cheeks"
      //   "gke" should NOT match "gke" within other words
      if (n.length <= 3 && /^[a-z0-9]+$/.test(n)) {
        // Create regex with word boundaries: \bsre\b
        const regex = new RegExp(`\\b${n}\\b`, 'i');
        return regex.test(haystack);
      }
      // For longer keywords and phrases, use simple substring match
      // Note: EXCLUDE_KEYWORDS are intentionally specific phrases (e.g., "online course"
      // instead of just "course") to avoid false positives like "Concourse" (CI/CD tool)
      return haystack.includes(n);
    });
  }

  function findAll(haystack, needles) {
    // Returns ALL matching keywords (not just the first one)
    return needles.filter((n) => {
      if (n.length <= 3 && /^[a-z0-9]+$/.test(n)) {
        const regex = new RegExp(`\\b${n}\\b`, 'i');
        return regex.test(haystack);
      }
      return haystack.includes(n);
    });
  }

  function classify(text) {
    const t = lower(text);
    
    // Safety check: reject empty or very short text
    if (!text || text.trim().length < 20) {
      if (DEBUG) {
        dbg("SKIP: text too short (len=" + text.length + ")");
      }
      return { match: false };
    }
    
    // First check for excluded keywords - filter out training/courses/bootcamps
    const excludeHit = findAny(t, EXCLUDE_KEYWORDS);
    if (excludeHit) {
      if (DEBUG) {
        dbg("SKIP: excluded keyword found:", excludeHit);
        dbg("Full text:", text);
      }
      return { match: false };
    }
    
    // Find ALL matching DevOps keywords (not just the first one)
    const devopsHits = findAll(t, DEVOPS_KEYWORDS);
    if (devopsHits.length === 0) {
      // Check if hiring signal exists (for debugging false positives)
      const hiringOnly = findAny(t, HIRING_SIGNALS);
      if (hiringOnly && DEBUG) {
        dbg("SKIP: hiring signal only (no devops keyword):", hiringOnly);
        dbg("Full text:", text);
      }
      return { match: false };
    }
    
    const hiringHit = findAny(t, HIRING_SIGNALS);
    
    // ONLY match posts with hiring signals - skip DevOps-only content
    if (!hiringHit) {
      if (DEBUG) {
        dbg("SKIP: DevOps keyword found but no hiring signal");
        dbg("DevOps keywords:", devopsHits.join(', '));
        dbg("Full text:", text);
      }
      return { match: false };
    }
    
    // Check for invalid keywords (USC only, no sponsorship, etc.)
    const invalidHit = findAny(t, INVALID_KEYWORDS);
    
    // Extract matched skills
    const matchedSkills = SKILLS.filter(skill => {
      if (skill.length <= 3 && /^[a-z0-9]+$/.test(skill)) {
        const regex = new RegExp(`\\b${skill}\\b`, 'i');
        return regex.test(t);
      }
      return t.includes(skill);
    });
    
    // Only match posts with both DevOps keywords AND hiring signals
    if (DEBUG) {
      // Create highlighted version of text for debugging
      let highlightedText = text;
      
      // Highlight DevOps keywords in yellow
      devopsHits.forEach(keyword => {
        const regex = new RegExp(`\\b(${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\b`, 'gi');
        highlightedText = highlightedText.replace(regex, '🟡$1🟡');
      });
      
      // Highlight hiring signal in green
      if (hiringHit) {
        const regex = new RegExp(`\\b(${hiringHit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\b`, 'gi');
        highlightedText = highlightedText.replace(regex, '🟢$1🟢');
      }
      
      // Highlight invalid keyword in orange
      if (invalidHit) {
        const regex = new RegExp(`\\b(${invalidHit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\b`, 'gi');
        highlightedText = highlightedText.replace(regex, '🟠$1🟠');
      }
      
      dbg("=== MATCH FOUND ===");
      dbg("DevOps keywords:", devopsHits.join(', '));
      dbg("Hiring signal:", hiringHit);
      dbg("Invalid keyword:", invalidHit || "none");
      dbg("Skills:", matchedSkills.join(', ') || "none");
      dbg("--- FULL POST TEXT (with highlights) ---");
      dbg(highlightedText);
      dbg("--- END POST TEXT ---");
    }
    return { match: true, devopsHits, hiringHit, invalidHit, skills: matchedSkills };
  }

  function getPostText(postEl) {
    // Pull from all known body containers and join. innerText gets the
    // visible text including the expanded "see more" content once shown,
    // and textContent is a fallback that includes hidden nodes too.
    const bodySelectors = [
      "[data-testid='expandable-text-box']", // New feed layout (2024+)
      ".feed-shared-update-v2__description",
      ".update-components-text",
      ".feed-shared-text",
      ".feed-shared-inline-show-more-text",
      ".update-components-update-v2__commentary",
      "[data-test-id='main-feed-activity-card__commentary']",
    ];
    const parts = [];
    bodySelectors.forEach((sel) => {
      postEl.querySelectorAll(sel).forEach((n) => {
        const txt = n.innerText || n.textContent || "";
        if (txt) parts.push(txt);
      });
    });
    if (parts.length === 0) {
      // Fallback: whole post text. Slower but catches unknown layouts.
      parts.push(postEl.innerText || postEl.textContent || "");
    }
    return parts.join("\n");
  }

  function getPostUrl(postEl) {
    let urn = postEl.getAttribute("data-urn");
    if (!urn) {
      const inner = postEl.querySelector("[data-urn*=':activity:']");
      if (inner) urn = inner.getAttribute("data-urn");
    }
    if (urn && urn.includes(":activity:")) {
      const id = urn.split(":activity:")[1];
      return `https://www.linkedin.com/feed/update/urn:li:activity:${id}/`;
    }
    // Fallback: look for a permalink anchor inside the post.
    // New feed layout uses various link patterns, try them all.
    const a = postEl.querySelector(
      "a[href*='/feed/update/'], a[href*='/posts/'], a.app-aware-link[href*='/feed/update/'], a.app-aware-link[href*='/posts/']"
    );
    return a ? a.href : null;
  }

  function highlightKeywords(postEl, info) {
    // Highlight matched keywords in the post body text
    const bodySelectors = [
      "[data-testid='expandable-text-box']", // New feed layout (2024+)
      ".feed-shared-update-v2__description",
      ".update-components-text",
      ".feed-shared-text",
      ".feed-shared-inline-show-more-text",
      ".update-components-update-v2__commentary",
      "[data-test-id='main-feed-activity-card__commentary']",
    ];
    
    // Highlight ALL matched DevOps keywords (not hiring signals)
    const keywordsToHighlight = info.devopsHits || [];
    
    bodySelectors.forEach((sel) => {
      postEl.querySelectorAll(sel).forEach((container) => {
        // Skip if already highlighted
        if (container.hasAttribute('data-devops-highlighted')) return;
        container.setAttribute('data-devops-highlighted', 'true');
        
        // Walk through text nodes and highlight keywords
        highlightInElement(container, keywordsToHighlight);
      });
    });
  }
  
  function highlightInElement(element, keywords) {
    // Create a regex pattern that matches any of the keywords (case-insensitive)
    const pattern = keywords
      .map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) // Escape regex chars
      .join('|');
    const regex = new RegExp(`\\b(${pattern})\\b`, 'gi');
    
    // Process all text nodes
    const walker = document.createTreeWalker(
      element,
      NodeFilter.SHOW_TEXT,
      null,
      false
    );
    
    const nodesToReplace = [];
    let node;
    while (node = walker.nextNode()) {
      // Skip if parent is already a mark element
      if (node.parentElement.tagName === 'MARK') continue;
      
      const text = node.textContent;
      if (regex.test(text)) {
        nodesToReplace.push(node);
      }
    }
    
    // Replace text nodes with highlighted versions
    nodesToReplace.forEach(textNode => {
      const text = textNode.textContent;
      const fragment = document.createDocumentFragment();
      let lastIndex = 0;
      
      // Reset regex
      const highlightRegex = new RegExp(`\\b(${pattern})\\b`, 'gi');
      let match;
      
      while (match = highlightRegex.exec(text)) {
        // Add text before match
        if (match.index > lastIndex) {
          fragment.appendChild(
            document.createTextNode(text.substring(lastIndex, match.index))
          );
        }
        
        // Add highlighted match with yellow highlighting
        const mark = document.createElement('mark');
        mark.className = 'devops-scan-highlight';
        mark.textContent = match[0];
        fragment.appendChild(mark);
        
        lastIndex = match.index + match[0].length;
      }
      
      // Add remaining text
      if (lastIndex < text.length) {
        fragment.appendChild(document.createTextNode(text.substring(lastIndex)));
      }
      
      // Replace the text node with the fragment
      textNode.parentNode.replaceChild(fragment, textNode);
    });
  }

  function decorate(postEl, info, text) {
    if (postEl.getAttribute(MARK_ATTR) === "match") return;
    postEl.setAttribute(MARK_ATTR, "match");
    postEl.classList.add(MATCH_CLASS);

    const url = getPostUrl(postEl);

    // Floating control bar at top-right of the post.
    const bar = document.createElement("div");
    bar.className = "devops-scan-bar";

    const badge = document.createElement("span");
    badge.className = BADGE_CLASS;
    // Join multiple keywords with commas
    const keywordList = info.devopsHits.join(', ');
    
    // Priority: Invalid > Hiring (no non-hiring posts should reach this point)
    if (info.invalidHit) {
      badge.textContent = `⚠️ Not valid · ${info.invalidHit}`;
      badge.classList.add("devops-scan-badge--invalid");
    } else {
      // Must have hiring signal to reach decorate() function
      badge.textContent = `🔥 Hiring · ${keywordList} + ${info.hiringHit}`;
      badge.classList.add("devops-scan-badge--hiring");
    }
    bar.appendChild(badge);

    if (url) {
      const btn = document.createElement("button");
      btn.className = BTN_CLASS;
      btn.type = "button";
      btn.textContent = "Open ↗";
      btn.title = "Open this post in a new tab";
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.open(url, "_blank", "noopener,noreferrer");
      });
      bar.appendChild(btn);
    }

    // Make sure the post is positioned so our absolute bar anchors correctly.
    const cs = window.getComputedStyle(postEl);
    if (cs.position === "static") postEl.style.position = "relative";
    postEl.appendChild(bar);

    // Highlight matched keywords in post text
    highlightKeywords(postEl, info);

    // Save match and notify popup (via storage) of the new match count.
    bumpMatch(url, info);
    saveMatch(postEl, url, info, text);
  }

  function markScanned(postEl, textLen) {
    if (postEl.getAttribute(MARK_ATTR) !== "match") {
      postEl.setAttribute(MARK_ATTR, "scanned");
      postEl.setAttribute("data-devops-len", String(textLen));
    }
  }

  // ---- Match + scan counters (shared with popup) --------------------------
  const seenMatches = new Set();
  const seenPosts = new Set(); // every post we've classified at least once
  let lastMatchInfo = null;

  function postKey(postEl) {
    let k = postEl.getAttribute("data-urn");
    if (!k) {
      // Look for a descendant with data-urn (common case where the urn is on
      // an inner div, not the root we walked up to).
      const inner = postEl.querySelector("[data-urn]");
      if (inner) k = inner.getAttribute("data-urn");
    }
    if (!k) {
      // Last resort: stamp a synthetic id on the element.
      k = postEl.getAttribute("data-devops-pid");
      if (!k) {
        k = `pid:${Math.random().toString(36).slice(2, 10)}`;
        postEl.setAttribute("data-devops-pid", k);
      }
    }
    return k;
  }

  function bumpAnalyzed(postEl) {
    const k = postKey(postEl) || `n:${seenPosts.size + 1}`;
    if (seenPosts.has(k)) return;
    seenPosts.add(k);
    syncCounts();
    updateIndicator();
  }

  function bumpMatch(url, info) {
    // Skip invalid posts (USC only, no sponsorship, etc.)
    if (info.invalidHit) {
      dbg('SKIP counting: invalid post (contains:', info.invalidHit + ')');
      return;
    }
    
    // Update last match info for ALL valid matches (hiring + DevOps)
    lastMatchInfo = info;
    
    // Only count hiring posts in the matches counter - skip DevOps-only posts
    if (!info.hiringHit) {
      dbg('SKIP counting: not a hiring post (DevOps keyword only)');
      // Still update the indicator to show the last match info
      updateIndicator();
      return;
    }
    
    const key = url || `n:${seenMatches.size + 1}`;
    if (seenMatches.has(key)) return;
    seenMatches.add(key);
    syncCounts();
    updateIndicator();
  }

  // ---- Duplicate Detection Helpers ----------------------------------------
  
  /**
   * Calculate similarity between two strings (0-100%)
   * Uses character overlap method for speed
   */
  function calculateSimilarity(str1, str2) {
    if (!str1 || !str2) return 0;
    
    // Normalize: lowercase, remove extra whitespace, punctuation
    const normalize = (s) => s.toLowerCase()
      .replace(/[^\w\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    
    const s1 = normalize(str1);
    const s2 = normalize(str2);
    
    if (s1 === s2) return 100;
    if (s1.length === 0 || s2.length === 0) return 0;
    
    // Use character bigrams for similarity comparison
    const getBigrams = (str) => {
      const bigrams = new Set();
      for (let i = 0; i < str.length - 1; i++) {
        bigrams.add(str.slice(i, i + 2));
      }
      return bigrams;
    };
    
    const bigrams1 = getBigrams(s1);
    const bigrams2 = getBigrams(s2);
    
    const intersection = new Set([...bigrams1].filter(x => bigrams2.has(x)));
    const union = new Set([...bigrams1, ...bigrams2]);
    
    return Math.round((intersection.size / union.size) * 100);
  }
  
  /**
   * Find duplicate matches based on content similarity
   * Returns the ID of the duplicate match if found, null otherwise
   */
  function findDuplicate(newMatch, existingMatches, threshold = 85) {
    for (const existing of existingMatches) {
      // Skip if comparing with itself
      if (existing.id === newMatch.id) continue;
      
      // Check URL first (exact match)
      if (newMatch.url && existing.url && newMatch.url === existing.url) {
        return existing.id;
      }
      
      // Check snippet similarity
      const similarity = calculateSimilarity(newMatch.snippet, existing.snippet);
      
      if (similarity >= threshold) {
        dbg(`duplicate detected: ${similarity}% similar to ${existing.id}`);
        return existing.id;
      }
    }
    
    return null;
  }

  function saveMatch(postEl, url, info, text) {
    // Skip invalid posts (USC only, no sponsorship, etc.)
    if (info.invalidHit) {
      dbg('SKIP saving: invalid post (contains:', info.invalidHit + ')');
      return;
    }
    
    // Only save hiring posts - skip DevOps-only posts
    if (!info.hiringHit) {
      dbg('SKIP saving: not a hiring post (DevOps keyword only)');
      return;
    }
    
    // Save match details to persistent storage for later review
    try {
      if (!chrome.storage || !chrome.storage.local) {
        dbg('storage API unavailable (extension context invalidated)');
        return;
      }
      
      chrome.storage.local.get(['devopsSavedMatches'], (result) => {
        if (chrome.runtime.lastError) {
          dbg('storage.get error:', chrome.runtime.lastError.message);
          return;
        }
        
        const matches = result.devopsSavedMatches || [];
        
        // Extract author info if available
        let author = 'Unknown';
        const authorEl = postEl.querySelector(
          '.update-components-actor__name, .feed-shared-actor__name, [data-test-id="main-feed-activity-card__actor-link"]'
        );
        if (authorEl) {
          author = (authorEl.innerText || authorEl.textContent || '').trim();
        } else {
          // Fallback for new feed layout: look for profile link text
          const profileLink = postEl.querySelector('a[href*="/in/"]:not([aria-hidden="true"])');
          if (profileLink) {
            // Get the first span with text content (avoid duplicate spans)
            const nameSpan = profileLink.querySelector('span[dir="ltr"]');
            if (nameSpan) {
              author = (nameSpan.innerText || nameSpan.textContent || '').trim();
            } else {
              author = (profileLink.innerText || profileLink.textContent || '').trim();
            }
          }
        }
        
        // Clean up author name - remove duplicates if name appears twice
        if (author && author.length > 0) {
          const words = author.split(/\s+/);
          const mid = Math.floor(words.length / 2);
          const firstHalf = words.slice(0, mid).join(' ');
          const secondHalf = words.slice(mid).join(' ');
          // If both halves are identical, use just one
          if (firstHalf === secondHalf && firstHalf.length > 0) {
            author = firstHalf;
          }
        }
        
        // Extract emails from post text using regex
        const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;
        const emails = text.match(emailRegex) || [];
        // Deduplicate and limit to first 5 emails
        const uniqueEmails = [...new Set(emails)].slice(0, 5);
        
        // Create text snippet (first 200 chars)
        const snippet = text.substring(0, 200) + (text.length > 200 ? '...' : '');
        
        const match = {
          id: `match:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
          url: url || null,
          timestamp: Date.now(),
          author: author,
          snippet: snippet,
          fullText: text, // Store complete post text for detailed viewing
          devopsKeywords: info.devopsHits, // ALL matched keywords (array)
          devopsKeyword: info.devopsHits[0], // First keyword for backward compatibility
          hiringSignal: info.hiringHit || null,
          invalidKeyword: info.invalidHit || null, // Store invalid keyword if present
          isHiring: !!info.hiringHit,
          emails: uniqueEmails,
          skills: info.skills || [], // Matched skills
          status: 'new', // Default status for new matches
          duplicateOf: null // Will be set if this is a duplicate
        };
        
        // Log extracted emails for debugging
        if (uniqueEmails.length > 0) {
          dbg(`extracted ${uniqueEmails.length} email(s):`, uniqueEmails.join(', '));
        }
        
        // Avoid duplicates based on URL
        if (url && matches.some(m => m.url === url)) {
          dbg('match already saved:', url);
          return;
        }
        
        // Check for content-based duplicates
        const duplicateId = findDuplicate(match, matches);
        if (duplicateId) {
          match.duplicateOf = duplicateId;
          dbg(`marked as duplicate of ${duplicateId}`);
          
          // Increment duplicate counter for auto-scroll session
          if (autoScrollEnabled) {
            duplicatesFoundInSession++;
            dbg(`duplicates in session: ${duplicatesFoundInSession}/${MAX_DUPLICATES_BEFORE_STOP}`);
            
            // Check if we should stop auto-scrolling
            if (duplicatesFoundInSession >= MAX_DUPLICATES_BEFORE_STOP) {
              dbg(`reached ${MAX_DUPLICATES_BEFORE_STOP} duplicates, stopping auto-scroll`);
              // Stop auto-scroll and show prompt
              setTimeout(() => {
                showDuplicateLimitPrompt();
              }, 500);
            }
          }
        }
        
        matches.unshift(match); // Add to front (newest first)
        
        // Keep only last 500 matches to avoid storage bloat
        if (matches.length > 500) {
          matches.length = 500;
        }
        
        chrome.storage.local.set({ devopsSavedMatches: matches }, () => {
          if (chrome.runtime.lastError) {
            dbg('storage.set error:', chrome.runtime.lastError.message);
            return;
          }
          dbg('saved match:', match.id, info.devopsHit);
        });
      });
    } catch (e) {
      dbg('saveMatch error:', e.message);
    }
  }

  function syncCounts() {
    try {
      if (!chrome.storage || !chrome.storage.local) {
        // Extension context invalidated - silently skip storage update
        return;
      }
      
      chrome.storage.local.set({
        devopsScanCount: seenMatches.size,
        devopsScanAnalyzed: seenPosts.size,
        devopsScanLast: Date.now(),
        devopsScanLastMatch: lastMatchInfo,
      }, () => {
        if (chrome.runtime.lastError) {
          // Silently handle error - user likely reloaded extension
        }
      });
    } catch (e) {
      // Extension context invalidated - continue without crashing
    }
  }

  // ---- Floating on-page indicator -----------------------------------------
  let indicatorEl = null;
  function ensureIndicator() {
    if (indicatorEl && document.body && document.body.contains(indicatorEl)) {
      return indicatorEl;
    }
    
    // Can't create indicator if body doesn't exist yet
    if (!document.body) return null;
    
    indicatorEl = document.createElement("div");
    indicatorEl.id = "devops-scan-indicator";
    indicatorEl.innerHTML = `
      <div class="devops-scan-indicator__title">DevOps Scanner</div>
      <div class="devops-scan-indicator__row">
        <span class="devops-scan-indicator__label">Analyzed</span>
        <span class="devops-scan-indicator__val" id="dsi-analyzed">0</span>
      </div>
      <div class="devops-scan-indicator__row">
        <span class="devops-scan-indicator__label">Matches</span>
        <span class="devops-scan-indicator__val devops-scan-indicator__val--match" id="dsi-matches">0</span>
      </div>
      <div class="devops-scan-indicator__last" id="dsi-last">no matches yet</div>
      <button type="button" class="devops-scan-indicator__hide" title="Hide">×</button>
    `;
    document.body.appendChild(indicatorEl);
    indicatorEl
      .querySelector(".devops-scan-indicator__hide")
      .addEventListener("click", () => {
        indicatorEl.style.display = "none";
      });
    return indicatorEl;
  }

  function updateIndicator() {
    const el = ensureIndicator();
    if (!el) return; // Can't update if indicator doesn't exist
    
    const analyzedEl = el.querySelector("#dsi-analyzed");
    const matchesEl = el.querySelector("#dsi-matches");
    const lastEl = el.querySelector("#dsi-last");
    
    if (analyzedEl) analyzedEl.textContent = seenPosts.size;
    if (matchesEl) matchesEl.textContent = seenMatches.size;
    
    if (lastEl && lastMatchInfo) {
      // devopsHits is an array, join multiple keywords with commas
      const devopsKeywords = lastMatchInfo.devopsHits ? lastMatchInfo.devopsHits.join(', ') : '';
      const tag = lastMatchInfo.hiringHit
        ? `🔥 ${devopsKeywords} + ${lastMatchInfo.hiringHit}`
        : devopsKeywords;
      lastEl.textContent = `last: ${tag}`;
    }
    
    // Update auto-scroll status
    updateAutoScrollStatus();
  }

  // ---- Auto-scroll feature -------------------------------------------------
  let autoScrollEnabled = false;
  let autoScrollTimer = null;
  let autoScrollButton = null;
  let currentSpeedPreset = 'balanced'; // default preset
  let oldPostsDetectedCount = 0; // Track consecutive old posts seen
  let refreshPromptShown = false; // Track if prompt is already shown
  let duplicatesFoundInSession = 0; // Track duplicates found during current auto-scroll session
  const MAX_DUPLICATES_BEFORE_STOP = 4; // Stop auto-scroll after this many duplicates
  
  // Speed presets configuration
  const SPEED_PRESETS = {
    stealth: {
      name: 'Stealth',
      description: 'Very slow, most human-like',
      distance: [150, 400],
      duration: [1000, 2000],
      pause: [3000, 7000]
    },
    slow: {
      name: 'Slow',
      description: 'Gentle scrolling with reading time',
      distance: [200, 500],
      duration: [800, 1500],
      pause: [2000, 5000]
    },
    balanced: {
      name: 'Balanced',
      description: 'Good balance of speed and naturalness',
      distance: [200, 800],
      duration: [400, 1200],
      pause: [1000, 4000]
    },
    fast: {
      name: 'Fast',
      description: 'Quick scanning, shorter pauses',
      distance: [400, 1000],
      duration: [300, 800],
      pause: [800, 2000]
    },
    turbo: {
      name: 'Turbo',
      description: 'Maximum speed, less natural',
      distance: [600, 1500],
      duration: [200, 500],
      pause: [500, 1500]
    }
  };

  function getRandomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }
  
  function loadSpeedPreset() {
    try {
      const saved = localStorage.getItem('devopsScanAutoScrollSpeed');
      if (saved && SPEED_PRESETS[saved]) {
        currentSpeedPreset = saved;
      }
    } catch (e) {
      dbg('Failed to load speed preset from localStorage:', e);
    }
  }
  
  function saveSpeedPreset(preset) {
    try {
      localStorage.setItem('devopsScanAutoScrollSpeed', preset);
      currentSpeedPreset = preset;
      dbg(`Speed preset changed to: ${SPEED_PRESETS[preset].name}`);
    } catch (e) {
      dbg('Failed to save speed preset to localStorage:', e);
    }
  }

  function smoothScroll(distance, duration) {
    const startPos = window.pageYOffset;
    const startTime = performance.now();

    function scroll(currentTime) {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);
      
      // Easing function (easeInOutQuad) for more human-like scrolling
      const ease = progress < 0.5
        ? 2 * progress * progress
        : -1 + (4 - 2 * progress) * progress;
      
      window.scrollTo(0, startPos + (distance * ease));

      if (progress < 1) {
        requestAnimationFrame(scroll);
      }
    }

    requestAnimationFrame(scroll);
  }

  function findAndClickShowMore() {
    // Look for "Show more results" or "Show previous results" buttons
    // LinkedIn uses various selectors for these buttons
    const selectors = [
      'button[aria-label*="Show more"]',
      'button[aria-label*="show more"]',
      'button.scaffold-finite-scroll__load-button',
      'button:has-text("Show more results")',
      'button:has-text("Show previous results")',
      '.scaffold-finite-scroll__load-button'
    ];
    
    for (const selector of selectors) {
      try {
        const button = document.querySelector(selector);
        if (button && button.offsetParent !== null) { // Check if visible
          dbg(`Auto-scroll: Found "Show more" button, clicking...`);
          button.click();
          return true;
        }
      } catch (e) {
        // Selector might not be supported, continue
      }
    }
    
    // Alternative: look for buttons containing "show more" text
    const buttons = document.querySelectorAll('button');
    for (const button of buttons) {
      const text = button.textContent.toLowerCase();
      if ((text.includes('show more') || text.includes('show previous')) && 
          button.offsetParent !== null) {
        dbg(`Auto-scroll: Found "Show more" button by text, clicking...`);
        button.click();
        return true;
      }
    }
    
    return false;
  }

  function performAutoScroll() {
    if (!autoScrollEnabled) return;
    
    // Check for old posts before scrolling
    const oldPostsDetected = checkForOldPosts();
    if (oldPostsDetected) {
      dbg("Auto-scroll: Stopped due to old posts detected");
      return; // Stop scrolling - prompt will be shown
    }

    // Check if we're near the bottom of the page
    const scrollTop = window.pageYOffset;
    const scrollHeight = document.documentElement.scrollHeight;
    const clientHeight = window.innerHeight;
    const distanceFromBottom = scrollHeight - (scrollTop + clientHeight);
    
    // If within 500px of bottom, try to click "Show more results" button
    if (distanceFromBottom < 500) {
      dbg(`Auto-scroll: Near bottom (${distanceFromBottom}px remaining), checking for "Show more" button...`);
      const clicked = findAndClickShowMore();
      
      if (clicked) {
        // Wait 2 seconds after clicking to let content load
        dbg(`Auto-scroll: Waiting 2s for content to load...`);
        autoScrollTimer = setTimeout(performAutoScroll, 2000);
        return;
      } else {
        dbg(`Auto-scroll: No "Show more" button found, continuing scroll...`);
      }
    }

    // Get current speed preset settings
    const preset = SPEED_PRESETS[currentSpeedPreset];
    
    // Random scroll distance from preset range
    const scrollDistance = getRandomInt(...preset.distance);
    
    // Random scroll duration from preset range
    const scrollDuration = getRandomInt(...preset.duration);
    
    // Perform smooth scroll
    smoothScroll(scrollDistance, scrollDuration);
    
    // Random pause after scrolling from preset range
    const pauseDuration = getRandomInt(...preset.pause);
    
    dbg(`Auto-scroll [${preset.name}]: ${scrollDistance}px over ${scrollDuration}ms, pausing ${pauseDuration}ms`);
    
    // Schedule next scroll
    autoScrollTimer = setTimeout(performAutoScroll, scrollDuration + pauseDuration);
  }

  function showRefreshPrompt() {
    if (refreshPromptShown) return; // Don't show multiple prompts
    refreshPromptShown = true;
    
    // Stop auto-scroll
    if (autoScrollEnabled) {
      autoScrollEnabled = false;
      if (autoScrollTimer) {
        clearTimeout(autoScrollTimer);
        autoScrollTimer = null;
      }
      updateAutoScrollStatus();
    }
    
    dbg("Old posts detected - showing refresh prompt");
    
    // Use shared modal factory
    showModal({
      icon: '🔄',
      title: 'Old Posts Reached',
      message: 'You\'ve scrolled back to posts you\'ve already seen. Would you like to refresh the page to see new posts?',
      buttons: [
        {
          label: 'Refresh Page',
          icon: '🔄',
          variant: 'primary',
          onClick: () => {
            dbg("User chose to refresh page");
            location.reload();
          }
        },
        {
          label: 'Continue Scrolling',
          variant: 'secondary',
          onClick: () => {
            dbg("User chose to continue scrolling");
            refreshPromptShown = false;
            oldPostsDetectedCount = 0; // Reset counter
          }
        }
      ]
    });
  }

  function showDuplicateLimitPrompt() {
    // Stop auto-scroll
    if (autoScrollEnabled) {
      autoScrollEnabled = false;
      if (autoScrollTimer) {
        clearTimeout(autoScrollTimer);
        autoScrollTimer = null;
      }
      updateAutoScrollStatus();
    }
    
    dbg(`Duplicate limit reached (${duplicatesFoundInSession} duplicates) - showing prompt`);
    
    // Use shared modal factory  
    showModal({
      icon: '🔄',
      title: 'Duplicates Detected',
      message: `Auto-scroll stopped: <strong>${duplicatesFoundInSession} duplicate posts</strong> found.<br><br>This usually means you've reached content you've already seen.<br><br>You can refresh the page for new posts or continue scrolling.`,
      buttons: [
        {
          label: 'Refresh Page',
          variant: 'primary',
          onClick: () => {
            dbg("User chose to refresh page");
            location.reload();
          }
        },
        {
          label: 'Continue Scrolling',
          variant: 'secondary',
          onClick: () => {
            dbg("User chose to continue scrolling (reset duplicate counter)");
            duplicatesFoundInSession = 0; // Reset counter
          }
        }
      ],
      styles: {
        title: 'color: #d84315;' // Orange-red color for duplicates warning
      }
    });
  }

  function checkForOldPosts() {
    // Get currently visible posts in viewport
    const textBoxes = document.querySelectorAll('[data-testid="expandable-text-box"]');
    let oldPostsInViewport = 0;
    let totalPostsInViewport = 0;
    
    textBoxes.forEach(textBox => {
      // Check if text box is in viewport
      const rect = textBox.getBoundingClientRect();
      const inViewport = rect.top >= 0 && rect.top <= window.innerHeight;
      
      if (inViewport) {
        totalPostsInViewport++;
        
        // Find the post root element (same as in main scanning logic)
        const postEl = findPostRoot(textBox);
        if (!postEl) return;
        
        // Get post key using same method as bumpAnalyzed
        const k = postKey(postEl);
        if (!k) return;
        
        // Check if we've seen this post before
        if (seenPosts.has(k)) {
          oldPostsInViewport++;
        }
      }
    });
    
    if (totalPostsInViewport === 0) {
      return false; // No posts visible, don't trigger
    }
    
    // If 80% or more of visible posts are old, consider it "reached old content"
    const oldPercentage = (oldPostsInViewport / totalPostsInViewport) * 100;
    
    if (oldPostsInViewport >= 3 && oldPercentage >= 80) {
      oldPostsDetectedCount++;
      dbg(`Old posts detected: ${oldPostsInViewport}/${totalPostsInViewport} (${oldPercentage.toFixed(0)}%) in viewport (count: ${oldPostsDetectedCount})`);
      
      // Show prompt after detecting old posts 2 times in a row (to avoid false positives)
      if (oldPostsDetectedCount >= 2) {
        showRefreshPrompt();
        return true; // Stop scrolling
      }
    } else {
      // Reset counter if we see enough new posts
      if (oldPercentage < 50) {
        oldPostsDetectedCount = 0;
      }
    }
    
    return false;
  }

  function toggleAutoScroll() {
    autoScrollEnabled = !autoScrollEnabled;
    
    if (autoScrollEnabled) {
      dbg("Auto-scroll: ENABLED");
      // Reset duplicate counter when starting a new auto-scroll session
      duplicatesFoundInSession = 0;
      dbg("Auto-scroll: Reset duplicate counter to 0");
      performAutoScroll();
    } else {
      dbg("Auto-scroll: DISABLED");
      if (autoScrollTimer) {
        clearTimeout(autoScrollTimer);
        autoScrollTimer = null;
      }
    }
    
    updateAutoScrollStatus();
  }

  function updateAutoScrollStatus() {
    if (!autoScrollButton) return;
    
    if (autoScrollEnabled) {
      autoScrollButton.textContent = "⏸ Stop Auto-Scroll";
      autoScrollButton.style.background = "#d32f2f";
      autoScrollButton.title = "Click to stop automatic scrolling";
    } else {
      autoScrollButton.textContent = "▶ Start Auto-Scroll";
      autoScrollButton.style.background = "#2e7d32";
      autoScrollButton.title = "Click to start automatic scrolling";
    }
  }

  function updateSpeedPresetButtons() {
    const buttons = document.querySelectorAll('.devops-scan-speed-btn');
    buttons.forEach(btn => {
      const presetName = btn.dataset.preset;
      if (presetName === currentSpeedPreset) {
        btn.style.background = '#1976d2';
        btn.style.fontWeight = '700';
      } else {
        btn.style.background = '#424242';
        btn.style.fontWeight = '500';
      }
    });
  }

  function addAutoScrollButton() {
    const indicator = ensureIndicator();
    if (!indicator) return;
    
    // Check if button already exists
    if (indicator.querySelector(".devops-scan-autoscroll-btn")) return;
    
    // Load saved speed preset
    loadSpeedPreset();
    
    // Create speed preset label
    const speedLabel = document.createElement("div");
    speedLabel.style.cssText = `
      margin-top: 8px;
      font-size: 11px;
      color: #666;
      font-weight: 600;
      text-align: center;
    `;
    speedLabel.textContent = "Scroll Speed:";
    
    // Create speed preset buttons container
    const speedContainer = document.createElement("div");
    speedContainer.className = "devops-scan-speed-container";
    speedContainer.style.cssText = `
      display: flex;
      gap: 4px;
      margin-top: 4px;
      flex-wrap: wrap;
    `;
    
    // Create button for each preset
    Object.keys(SPEED_PRESETS).forEach(presetKey => {
      const preset = SPEED_PRESETS[presetKey];
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "devops-scan-speed-btn";
      btn.dataset.preset = presetKey;
      btn.textContent = preset.name;
      btn.title = preset.description;
      btn.style.cssText = `
        flex: 1;
        padding: 4px 6px;
        background: ${presetKey === currentSpeedPreset ? '#1976d2' : '#424242'};
        color: white;
        border: none;
        border-radius: 3px;
        cursor: pointer;
        font-size: 10px;
        font-weight: ${presetKey === currentSpeedPreset ? '700' : '500'};
        transition: background 0.2s;
      `;
      
      btn.addEventListener("click", () => {
        saveSpeedPreset(presetKey);
        updateSpeedPresetButtons();
      });
      
      btn.addEventListener("mouseenter", () => {
        if (presetKey !== currentSpeedPreset) {
          btn.style.background = '#616161';
        }
      });
      
      btn.addEventListener("mouseleave", () => {
        if (presetKey !== currentSpeedPreset) {
          btn.style.background = '#424242';
        }
      });
      
      speedContainer.appendChild(btn);
    });
    
    // Create main auto-scroll button
    autoScrollButton = document.createElement("button");
    autoScrollButton.type = "button";
    autoScrollButton.className = "devops-scan-autoscroll-btn";
    autoScrollButton.textContent = "▶ Start Auto-Scroll";
    autoScrollButton.style.cssText = `
      width: 100%;
      margin-top: 8px;
      padding: 8px;
      background: #2e7d32;
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
      transition: background 0.2s;
    `;
    
    autoScrollButton.addEventListener("click", toggleAutoScroll);
    autoScrollButton.addEventListener("mouseenter", () => {
      if (autoScrollEnabled) {
        autoScrollButton.style.background = "#b71c1c";
      } else {
        autoScrollButton.style.background = "#1b5e20";
      }
    });
    autoScrollButton.addEventListener("mouseleave", () => {
      if (autoScrollEnabled) {
        autoScrollButton.style.background = "#d32f2f";
      } else {
        autoScrollButton.style.background = "#2e7d32";
      }
    });
    
    // Insert all elements before the hide button
    const hideBtn = indicator.querySelector(".devops-scan-indicator__hide");
    indicator.insertBefore(speedLabel, hideBtn);
    indicator.insertBefore(speedContainer, hideBtn);
    indicator.insertBefore(autoScrollButton, hideBtn);
    
    updateAutoScrollStatus();
  }

  function findPostRoot(el) {
    // For new LinkedIn layout with data-testid="expandable-text-box",
    // walk up to find the post card container (typically 8-10 levels up)
    if (el.hasAttribute('data-testid') && el.getAttribute('data-testid') === 'expandable-text-box') {
      let current = el;
      // Walk up to find a container that looks like a post card
      // Post cards typically have multiple children and substantial height
      for (let i = 0; i < 12; i++) {
        if (!current.parentElement) break;
        current = current.parentElement;
        
        // Check if this looks like a post card container:
        // - Has multiple children
        // - Contains the text box we started from
        // - Is a reasonable container size
        if (current.children.length >= 1 && 
            current !== el && 
            current.contains(el)) {
          // Stop at a container that has other post-like siblings
          // or is clearly a card-level container
          const siblings = current.parentElement ? current.parentElement.children.length : 0;
          if (siblings > 10 || i >= 8) {
            return current;
          }
        }
      }
      return current; // Return whatever we ended up at
    }
    
    // Legacy selector-based approach for older layouts and groups
    for (const sel of POST_ROOT_SELECTORS) {
      const root = el.closest(sel);
      if (root) return root;
    }
    
    return el;
  }

  // ---- Scan loop -----------------------------------------------------------
  let scanIndex = 0;
  function scanOnce() {
    scanIndex++;
    const selector = POST_SELECTORS.join(",");
    const candidates = document.querySelectorAll(selector);
    const roots = new Set();
    candidates.forEach((c) => roots.add(findPostRoot(c)));

    // Log every scan summary so we can see why counters stall.
    dbg(
      `scan #${scanIndex}: candidates=${candidates.length} roots=${roots.size} analyzed=${seenPosts.size} matches=${seenMatches.size}`
    );

    let skippedShort = 0;
    let processed = 0;
    roots.forEach((postEl) => {
      const state = postEl.getAttribute(MARK_ATTR);
      if (state === "match") return; // already a match, leave it alone
      const text = getPostText(postEl);
      if (!text || text.length < 20) {
        skippedShort++;
        if (skippedShort <= 2) {
          dbg(
            `  skipped short post (len=${text ? text.length : 0}):`,
            postEl
          );
        }
        return;
      }
      processed++;
      // If we already scanned this post and the text hasn't grown (no
      // "see more" expansion), skip.
      if (state === "scanned") {
        const prevLen = parseInt(
          postEl.getAttribute("data-devops-len") || "0",
          10
        );
        if (text.length <= prevLen) return;
      }
      const info = classify(text);
      bumpAnalyzed(postEl);
      if (info.match) {
        dbg("match:", info.devopsHits.join(', '), info.hiringHit ? `+ ${info.hiringHit}` : "");
        decorate(postEl, info, text);
      } else {
        markScanned(postEl, text.length);
      }
    });
    if (processed) dbg(`  processed ${processed} new posts this scan`);
  }

  // Re-scan as LinkedIn lazily injects more posts during scroll.
  const obs = new MutationObserver(() => {
    clearTimeout(obs._t);
    obs._t = setTimeout(scanOnce, 250);
  });

  // Initialize extension (wait for body if needed)
  function init() {
    if (!document.body) {
      dbg("waiting for document.body...");
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
      } else {
        setTimeout(init, 10);
      }
      return;
    }

    // Start observing mutations
    obs.observe(document.body, { childList: true, subtree: true });

    // Periodic safety scan in case mutations are missed.
    setInterval(scanOnce, 2000);

    // Initial UI setup
    ensureIndicator();
    addAutoScrollButton();
    
    // Reset counts FIRST so the initial scan's bumps are not clobbered.
    try {
      if (chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({
          devopsScanCount: 0,
          devopsScanAnalyzed: 0,
          devopsScanLast: Date.now(),
          devopsScanLastMatch: null,
        }, () => {
          if (chrome.runtime.lastError) {
            dbg('storage init error:', chrome.runtime.lastError.message);
          }
        });
      }
    } catch (e) {
      dbg('storage init failed (extension context may be invalidated):', e.message);
    }
    
    updateIndicator();
    dbg("content script initialized on", location.href);
    
    // Run immediate scan
    scanOnce();
    
    // Check if tour should be shown (first-time users after welcome)
    checkTourStatus();
  }
  
  // Check and show interactive tour for first-time users
  function checkTourStatus() {
    chrome.storage.local.get(['tourCompleted', 'welcomeCompleted'], (result) => {
      // Show tour if welcome is completed but tour hasn't been done yet
      if (result.welcomeCompleted && !result.tourCompleted) {
        // Wait for page to fully load, then show tour
        setTimeout(() => {
          if (typeof Tour !== 'undefined' && Tour.init) {
            Tour.init();
            Tour.start();
          }
        }, 2000);
      }
    });
  }

  // Detect LinkedIn SPA navigation (URL changes without page reload)
  let lastUrl = location.href;
  function detectNavigation() {
    if (location.href !== lastUrl) {
      dbg("LinkedIn navigation detected:", lastUrl, "→", location.href);
      lastUrl = location.href;
      
      // Stop auto-scroll when navigating to new page
      if (autoScrollEnabled) {
        autoScrollEnabled = false;
        if (autoScrollTimer) {
          clearTimeout(autoScrollTimer);
          autoScrollTimer = null;
        }
        dbg("Auto-scroll: DISABLED due to navigation");
      }
      
      // Clear seen posts to re-scan new page
      seenPosts.clear();
      seenMatches.clear();
      
      // Reset duplicate counter on navigation
      duplicatesFoundInSession = 0;
      dbg("Navigation: Reset duplicate counter to 0");
      
      // Re-add auto-scroll button after navigation
      setTimeout(() => {
        addAutoScrollButton();
      }, 1000);
      
      // Trigger immediate scan of new page
      setTimeout(scanOnce, 500);
    }
  }

  // Check for URL changes every 500ms (LinkedIn SPA navigation)
  setInterval(detectNavigation, 500);

  // Also listen for popstate (browser back/forward)
  window.addEventListener('popstate', () => {
    dbg("Browser navigation (popstate) detected");
    detectNavigation();
  });

  // Listen for pushState/replaceState (SPA navigation)
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;
  
  history.pushState = function(...args) {
    originalPushState.apply(this, args);
    dbg("pushState navigation detected");
    detectNavigation();
  };
  
  history.replaceState = function(...args) {
    originalReplaceState.apply(this, args);
    dbg("replaceState navigation detected");
    detectNavigation();
  };

  // Listen for messages from popup and background script
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'toggleAutoScroll') {
      // Toggle auto-scroll when triggered from popup or keyboard shortcut
      if (autoScrollEnabled) {
        stopAutoScroll();
      } else {
        startAutoScroll();
      }
      sendResponse({ success: true, active: autoScrollEnabled });
      return true;
    }
    
    if (message.action === 'reloadKeywords') {
      // Reload keywords from storage when settings are updated
      dbg("Reloading keywords from settings...");
      // Keywords will be reloaded on next scan
      // We don't need to do anything here since classify() reads from storage
      sendResponse({ success: true });
      return true;
    }
  });

  init();
})();
