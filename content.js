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
  let DEVOPS_KEYWORDS  = [...DEFAULT_DEVOPS_KEYWORDS];
  let HIRING_SIGNALS   = [...DEFAULT_HIRING_SIGNALS];
  let INVALID_KEYWORDS = [...DEFAULT_INVALID_KEYWORDS]; // single list — shown as "Not valid"
  
  // Regex cache to avoid recompiling patterns on every scan
  const regexCache = new Map();
  
  function getCachedRegex(keyword, flags = 'i') {
    const cacheKey = `${keyword}:${flags}`;
    if (!regexCache.has(cacheKey)) {
      const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      regexCache.set(cacheKey, new RegExp(`\\b${escaped}\\b`, flags));
    }
    return regexCache.get(cacheKey);
  }
  
  function clearRegexCache() {
    regexCache.clear();
  }
  
  // Load custom keywords from storage (filters out disabled keywords)
  function loadCustomKeywords() {
    chrome.storage.local.get(['customKeywords'], (result) => {
      if (result.customKeywords) {
        const ck = result.customKeywords;
        // Get disabled sets for each category (arrays stored under ck.disabled)
        const disabled = ck.disabled || {};
        const disabledDevops   = new Set(disabled.devopsKeywords  || []);
        const disabledHiring   = new Set(disabled.hiringSignals   || []);
        const disabledInvalid  = new Set(disabled.invalidKeywords || []);

        DEVOPS_KEYWORDS  = (ck.devopsKeywords  || DEFAULT_DEVOPS_KEYWORDS) .filter(k => !disabledDevops.has(k));
        HIRING_SIGNALS   = (ck.hiringSignals   || DEFAULT_HIRING_SIGNALS)  .filter(k => !disabledHiring.has(k));
        INVALID_KEYWORDS = (ck.invalidKeywords || DEFAULT_INVALID_KEYWORDS).filter(k => !disabledInvalid.has(k));

        // Clear regex cache when keywords change
        clearRegexCache();

        dbg("Custom keywords loaded from settings");
        dbg("DevOps keywords:", DEVOPS_KEYWORDS.length,  "(disabled:", disabledDevops.size  + ")");
        dbg("Hiring signals:", HIRING_SIGNALS.length,    "(disabled:", disabledHiring.size   + ")");
        dbg("Invalid keywords:", INVALID_KEYWORDS.length, "(disabled:", disabledInvalid.size + ")");
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
    // Groups search results — post cards use artdeco-card on li
    "li.artdeco-card",
    "li[class*='search-result']",
  ];

  // When we find a candidate, walk up to the nearest stable post root so
  // multiple inner-element matches collapse to one post.
  // Listed from most-specific to least-specific — closest() stops at the first match.
  const POST_ROOT_SELECTORS = [
    // Feed layouts
    "div.feed-shared-update-v2",
    "div.fie-impression-container",
    "div.update-components-update-v2",
    // URN-based (works on feed AND search results)
    "[data-urn*=':activity:']",
    "[data-urn*=':share:']",
    "[data-urn*=':ugcPost:']",
    // Search results page — each result is an <li> with one of these markers
    "li.reusable-search__result-container",
    "li[data-occludable-entity-urn]",
    // Groups search results
    "li.artdeco-card",
    "li[class*='search-result']",
    "li.artdeco-list__item",
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
  // Normalize text: lowercase + collapse all whitespace variants (including
  // non-breaking spaces   common in LinkedIn's DOM) to single spaces.
  // This ensures phrases like "w2 only" match even when LinkedIn renders
  // them with non-breaking spaces between words.
  // normalizeText (lower alias) defined in shared/utils.js
  const lower = normalizeText;

  // djb2 hash — mirrors background.js hashText for textHash comparison
  const hashText = (str) => {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h) ^ str.charCodeAt(i);
    return (h >>> 0).toString(36);
  };

  function findAny(haystack, needles) {
    return needles.find((n) => {
      // Normalize needle to lowercase so it matches the lowercased haystack
      // regardless of how the user typed the keyword (SRE, sre, Sre all work)
      // Trim to handle keywords with accidental leading/trailing whitespace
      const needle = n.toLowerCase().trim();
      // Use word boundary matching for short keywords (3 chars or less)
      // to avoid false positives:
      //   "sre" should NOT match "insure", "ensure", "disrespect"
      //   "aks" should NOT match "tasks", "breaks", "speaks"
      //   "eks" should NOT match "weeks", "seeks", "cheeks"
      //   "gke" should NOT match "gke" within other words
      if (needle.length <= 3 && /^[a-z0-9]+$/.test(needle)) {
        // Use cached regex with word boundaries: \bsre\b
        const regex = getCachedRegex(needle, 'i');
        return regex.test(haystack);
      }
      // For longer keywords and phrases, use simple substring match
      // Note: EXCLUDE_KEYWORDS are intentionally specific phrases (e.g., "online course"
      // instead of just "course") to avoid false positives like "Concourse" (CI/CD tool)
      return haystack.includes(needle);
    });
  }

  function findAll(haystack, needles) {
    // Returns ALL matching keywords (not just the first one)
    return needles.filter((n) => {
      // Normalize needle to lowercase so uppercase custom keywords (SRE, AWS) match correctly
      // Trim to handle keywords with accidental leading/trailing whitespace
      const needle = n.toLowerCase().trim();
      if (needle.length <= 3 && /^[a-z0-9]+$/.test(needle)) {
        const regex = getCachedRegex(needle, 'i');
        return regex.test(haystack);
      }
      return haystack.includes(needle);
    });
  }

  // ---- Classifier V2 — contextual, sentence-level, negation-aware ----------
  //   4. Structural signals  — bullets, years-of-exp patterns, salary, apply
  //                            instructions all contribute to confidence
  //   5. Soft scoring        — returns confidence 0-100 instead of binary

  const V2_ROLE_KEYWORDS = new Set([
    'devops', 'dev ops', 'sre', 'devops engineer', 'azure devops engineer',
    'site reliability', 'platform engineer', 'platform engineering',
    'cloud engineer', 'cloud architect', 'infrastructure engineer',
    'release engineer', 'cloud devops', 'cloud ops', 'aws engineer',
    'azure engineer', 'gcp engineer', 'cloud support engineer',
  ]);

  const V2_NEGATION_WORDS = [
    'no ', 'not ', "don't ", "doesn't ", "won't ", 'never ', 'without ',
    'no experience', 'not required', 'not looking', 'not hiring', 'not a ',
    "isn't ", "aren't ", 'non-',
  ];

  const V2_HIRING_CONTEXT = [
    'hiring', 'looking for', 'seeking', 'open role', 'open position',
    'job opening', 'we need', 'join our team', 'join us', 'apply now',
    'apply here', 'apply via', 'dm me', 'message me', 'send your resume',
    'send your cv', 'send resume', 'we are hiring', "we're hiring",
    'now hiring', 'immediate opening', 'urgent requirement', 'urgent need',
    'position open', 'vacancy', 'job opportunity', 'career opportunity',
    'reaching out', 'let me know', 'connect with me', 'drop your resume',
    'share your profile', 'tag someone', 'actively hiring', 'actively looking',
  ];

  const V2_REQUIREMENTS_CONTEXT = [
    'requirements', 'qualifications', 'must have', 'you will', 'you should',
    'experience with', 'years of experience', 'years experience',
    'background in', 'proficiency in', 'knowledge of', 'expertise in',
    'familiar with', 'hands-on', 'strong understanding', 'minimum',
    'required skills', 'responsibilities', 'skills needed', 'what you bring',
    'what we need', 'what we look',
  ];

  const V2_COMPANY_CONTEXT = [
    'we use ', 'our stack', 'we work with', 'our team uses', 'built with',
    'powered by', 'our infrastructure', 'we have built', 'our platform uses',
    'we built', 'we leverage', 'our product uses', 'we rely on',
  ];

  // Score bonus per context type when a devops keyword is found in a sentence
  const V2_CONTEXT_SCORE = { hiring: 28, requirements: 22, neutral: 10, company: 3 };

  function v2SplitSentences(text) {
    return text
      .split(/[.!?\n]|\s{2,}|[•·\-–—]\s/)
      .map(s => s.trim())
      .filter(s => s.length > 8);
  }

  function v2GetContext(sentence) {
    if (V2_HIRING_CONTEXT.some(p => sentence.includes(p))) return 'hiring';
    if (V2_REQUIREMENTS_CONTEXT.some(p => sentence.includes(p))) return 'requirements';
    if (V2_COMPANY_CONTEXT.some(p => sentence.includes(p))) return 'company';
    return 'neutral';
  }

  function v2IsNegated(sentence, pos) {
    // Look at the ~60 chars before the keyword hit
    const window = sentence.substring(Math.max(0, pos - 65), pos);
    return V2_NEGATION_WORDS.some(n => window.includes(n));
  }

  function classifyV2(text, postEl) {
    if (!text || text.trim().length < 20) return { match: false };

    const t = text.toLowerCase();
    const sentences = v2SplitSentences(t);

    let score = 0;
    const devopsHits = [];
    const hiringHits = [];
    const v2signals = [];

    for (const sentence of sentences) {
      const context = v2GetContext(sentence);

      // --- DevOps keyword hits ---
      let sentenceDevopsHit = false;
      for (const keyword of DEVOPS_KEYWORDS) {
        const needle = keyword.toLowerCase();
        const pos = sentence.indexOf(needle);
        if (pos === -1) continue;

        // Word boundary check for short keywords (≤3 chars)
        if (needle.length <= 3 && /^[a-z0-9]+$/.test(needle)) {
          if (!getCachedRegex(needle, 'i').test(sentence)) continue;
        }

        if (v2IsNegated(sentence, pos)) {
          score -= 3;
          v2signals.push(`negated "${keyword}" (-3)`);
          continue;
        }

        if (!devopsHits.includes(keyword)) devopsHits.push(keyword);

        if (!sentenceDevopsHit) {
          // Only score once per sentence to avoid keyword-stuffing inflation
          const roleBonus = V2_ROLE_KEYWORDS.has(needle) ? 14 : 0;
          const pts = V2_CONTEXT_SCORE[context] + roleBonus;
          score += pts;
          v2signals.push(`"${keyword}" [${context}]${roleBonus ? ' +role' : ''} +${pts}`);
          sentenceDevopsHit = true;
        }
      }

      // --- Hiring signal hits ---
      for (const signal of HIRING_SIGNALS) {
        const needle = signal.toLowerCase();
        const pos = sentence.indexOf(needle);
        if (pos === -1) continue;
        if (v2IsNegated(sentence, pos)) continue;
        if (!hiringHits.includes(signal)) {
          hiringHits.push(signal);
          score += 7;
          v2signals.push(`hiring signal "${signal}" +7`);
        }
        break;
      }
    }

    // --- Structural signals (full text, not per-sentence) ---
    if (/\b\d+\+?\s*(?:years?|yrs?)(?:\s+of)?\s+(?:experience|exp)\b/i.test(text)) {
      score += 10; v2signals.push('years-of-exp pattern +10');
    }
    if (/(?:\$\d+|\d+k)\s*(?:\/\s*(?:hr|hour|yr|year|annum))?/i.test(text)) {
      score += 8; v2signals.push('salary/rate +8');
    }
    const bodyOnlyText = postEl ? getPostBodyOnly(postEl) : text;
    if (/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/.test(bodyOnlyText)) {
      score += 12; v2signals.push('email present +12');
    }
    if (/\b(apply|dm me|message me|send (?:your )?(?:resume|cv)|drop (?:your )?(?:resume|cv))\b/i.test(text)) {
      score += 12; v2signals.push('apply instruction +12');
    }
    const bulletCount = (text.match(/^[\s]*[•·\-\*]\s+.+/gm) || []).length;
    if (bulletCount >= 3) {
      score += 8; v2signals.push(`structured bullets (${bulletCount}) +8`);
    }
    if (/\b(remote|wfh|work from home|fully remote|hybrid)\b/i.test(text)) {
      score += 4; v2signals.push('remote/hybrid +4');
    }

    // --- Invalid keyword penalty (soft — doesn't hard-block) ---
    const invalidHit = findAny(t, INVALID_KEYWORDS);
    if (invalidHit) {
      score -= 25; v2signals.push(`invalid keyword "${invalidHit}" -25`);
    }

    const confidence = Math.max(0, Math.min(100, score));
    // Require at least one devops keyword + confidence threshold
    const match = devopsHits.length > 0 && confidence >= 40;

    dbg('[V2]', match ? 'MATCH' : 'SKIP', `confidence=${confidence}`, v2signals.join(' | '));

    return {
      match,
      confidence,
      devopsHits,
      hiringHit: hiringHits[0] || null,
      hiringHits,
      invalidHit: invalidHit || null,
      skills: devopsHits,
      v2signals,
    };
  }

  // computeRelevanceScore defined in shared/matchHelpers.js

  // ---- Keyword hit tracking -----------------------------------------------
  // Counts how many times each keyword has been seen in confirmed matches.
  // Buffer is flushed to storage every 30s to avoid hammering the storage API.
  let keywordHitBuffer = {};

  function trackKeywordHits(devopsHits, hiringHits, skills) {
    const bump = (k) => {
      if (!k) return;
      keywordHitBuffer[k] = (keywordHitBuffer[k] || 0) + 1;
    };
    (devopsHits || []).forEach(bump);
    (hiringHits || []).forEach(bump);
    (skills || []).forEach(bump);
  }

  function flushKeywordHits() {
    if (Object.keys(keywordHitBuffer).length === 0) return;
    const pending = keywordHitBuffer;
    keywordHitBuffer = {};
    try {
      if (!chrome.storage || !chrome.storage.local) return;
      chrome.storage.local.get(['keywordHitCounts'], (result) => {
        if (chrome.runtime.lastError) return;
        const counts = result.keywordHitCounts || {};
        for (const [k, v] of Object.entries(pending)) {
          counts[k] = (counts[k] || 0) + v;
        }
        chrome.storage.local.set({ keywordHitCounts: counts });
      });
    } catch (e) {
      dbg('flushKeywordHits error:', e.message);
    }
  }

  // getPostText, getPostBodyOnly, getPostUrl defined in shared/postHelpers.js

  // Highlight styles per category — background only, no font changes
  const HIGHLIGHT_STYLES = {
    devops:   { cls: 'devops-scan-highlight--devops',   css: 'background:#fff59d;border-radius:2px;' },
    hiring:   { cls: 'devops-scan-highlight--hiring',   css: 'background:#c8e6c9;border-radius:2px;' },
    skill:    { cls: 'devops-scan-highlight--skill',    css: 'background:#e3f2fd;border-radius:2px;' },
    invalid:  { cls: 'devops-scan-highlight--invalid',  css: 'background:#ffcdd2;border-radius:2px;' },
  };

  function highlightKeywords(postEl, info) {
    const bodySelectors = [
      "[data-testid='expandable-text-box']",
      ".feed-shared-update-v2__description",
      ".update-components-text",
      ".feed-shared-text",
      ".feed-shared-inline-show-more-text",
      ".update-components-update-v2__commentary",
      "[data-test-id='main-feed-activity-card__commentary']",
    ];

    bodySelectors.forEach((sel) => {
      postEl.querySelectorAll(sel).forEach((container) => {
        if (container.hasAttribute('data-devops-highlighted')) return;
        container.setAttribute('data-devops-highlighted', 'true');

        // DevOps keywords — yellow
        if (info.devopsHits && info.devopsHits.length > 0)
          highlightInElement(container, info.devopsHits, HIGHLIGHT_STYLES.devops);
        // Invalid keyword — red (runs last so it overwrites any yellow on a conflicting word)
        if (info.invalidHit)
          highlightInElement(container, [info.invalidHit], HIGHLIGHT_STYLES.invalid);
      });
    });
  }

  // highlightInElement — walks text nodes inside `element` and wraps each
  // occurrence of any keyword in `keywords` with a <mark> styled per `style`.
  // Safe to call multiple times on the same element with different keyword sets:
  // each pass only touches bare text nodes, skipping nodes already inside <mark>.
  function highlightInElement(element, keywords, style) {
    if (!keywords || keywords.length === 0) return;

    const cacheKey = `hl:${style.cls}:${[...keywords].sort().join('|')}`;

    let pattern, regex;
    if (regexCache.has(cacheKey)) {
      ({ pattern, regex } = regexCache.get(cacheKey));
    } else {
      pattern = keywords
        .map(k => k
          .replace(/[.*+?^${}()|[\]\\]/g, '\\$&') // escape regex special chars
          .replace(/ +/g, '[\\s\\u00a0]+')          // match any whitespace (incl. LinkedIn's &nbsp;)
        )
        .join('|');
      regex = new RegExp(`\\b(${pattern})\\b`, 'gi');
      regexCache.set(cacheKey, { pattern, regex });
    }

    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, null, false);
    const nodesToReplace = [];
    let node;
    while (node = walker.nextNode()) {
      if (node.parentElement.tagName === 'MARK') continue; // already highlighted
      regex.lastIndex = 0;
      if (regex.test(node.textContent)) nodesToReplace.push(node);
    }

    nodesToReplace.forEach(textNode => {
      const text = textNode.textContent;
      const fragment = document.createDocumentFragment();
      let lastIndex = 0;
      const highlightRegex = new RegExp(`\\b(${pattern})\\b`, 'gi');
      let match;

      while (match = highlightRegex.exec(text)) {
        if (match.index > lastIndex) {
          fragment.appendChild(document.createTextNode(text.substring(lastIndex, match.index)));
        }
        const mark = document.createElement('mark');
        mark.className = style.cls;
        mark.style.cssText = style.css;
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

    // Match counter — total unique keyword hits (devops + hiring signals)
    if (!info.invalidHit) {
      const totalHits = (info.devopsHits ? info.devopsHits.length : 0) +
                        (info.hiringHits ? info.hiringHits.length : 0);
      const counter = document.createElement("span");
      counter.className = "devops-scan-match-counter";
      counter.textContent = `${totalHits} match${totalHits !== 1 ? 'es' : ''}`;
      counter.title = [...(info.devopsHits || []), ...(info.hiringHits || [])].join(', ');
      bar.appendChild(counter);
    }

    // Check for duplicates and add duplicate badge if found
    checkDuplicateAndDecorate(postEl, bar, url, text);

    // Relevance score pill — only for valid hiring posts
    if (!info.invalidHit) {
      const confidence = info.confidence ?? 0;
      const scorePill = document.createElement("span");
      scorePill.className = "devops-scan-score-pill";
      const signalSummary = (info.v2signals || []).join('\n');
      if (confidence >= 70) {
        scorePill.classList.add("devops-scan-score-pill--high");
        scorePill.textContent = `⭐ ${confidence}%`;
      } else if (confidence >= 45) {
        scorePill.classList.add("devops-scan-score-pill--mid");
        scorePill.textContent = `${confidence}%`;
      } else {
        scorePill.classList.add("devops-scan-score-pill--low");
        scorePill.textContent = `${confidence}%`;
      }
      scorePill.title = `V2 confidence: ${confidence}%\n\nSignals:\n${signalSummary || 'none'}`;
      bar.appendChild(scorePill);
    }

    // AI status tag — updated after analysis completes
    if (!info.invalidHit) {
      const aiTag = document.createElement('span');
      aiTag.className = 'devops-scan-ai-tag';
      aiTag.textContent = '⏳ AI…';
      aiTag.style.cssText = 'font-size:10px;color:#7c3aed;background:#ede9fe;border-radius:4px;padding:2px 6px;margin-left:4px;';
      bar.appendChild(aiTag);
    }

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

    // Inject Notion link if this post was already saved with a Notion page
    if (url) tryInjectNotionLink(postEl, url);

    // Insert bar inline, directly before the post text so it never overlaps content.
    // Try known text-container selectors; fall back to prepending to the post root.
    const textContainer = postEl.querySelector(
      "[data-testid='expandable-text-box']," +
      ".feed-shared-update-v2__description," +
      ".update-components-text," +
      ".update-components-update-v2__commentary," +
      "[data-test-id='main-feed-activity-card__commentary']"
    );
    if (textContainer && textContainer.parentNode) {
      textContainer.parentNode.insertBefore(bar, textContainer);
    } else {
      postEl.prepend(bar);
    }

    // Highlight matched keywords in post text
    highlightKeywords(postEl, info);

    // Save match and notify popup (via storage) of the new match count.
    bumpMatch(url, info);
    saveMatch(postEl, url, info, text);
  }
  
  // ---- Applied button -------------------------------------------------------

  // Find a saved match by URL, falling back to snippet prefix when URL is absent.
  function findSavedMatch(matches, url, snippetPrefix) {
    if (url) {
      const byUrl = matches.find(m => m.url === url);
      if (byUrl) return byUrl;
    }
    if (snippetPrefix) {
      return matches.find(m => m.snippet && m.snippet.startsWith(snippetPrefix)) || null;
    }
    return null;
  }

  function _updateAITag(postEl, analysis) {
    const tag = postEl.querySelector('.devops-scan-ai-tag');
    if (!tag) return;
    if (!analysis || analysis._error) {
      tag.textContent = analysis?._error === 'context_too_long' ? '⚠️ Too long' : '❌ AI fail';
      tag.style.color = '#b91c1c';
      tag.style.background = '#fee2e2';
    } else {
      const titles = analysis.jobTitles?.length ? analysis.jobTitles.slice(0, 2).join(', ') : null;
      const visa   = analysis.visaSponsorship ? '🛂' : '';
      tag.textContent = `🤖 ${titles || 'AI done'}${visa ? ' ' + visa : ''}`;
      tag.style.color = '#065f46';
      tag.style.background = '#d1fae5';
    }
  }

  function setNotionLink(postEl, notionPageId) {
    const bar = postEl.querySelector('.devops-scan-bar');
    if (!bar || bar.querySelector('.devops-scan-notion-link')) return;
    const a = document.createElement('a');
    a.className = 'devops-scan-notion-link';
    a.href = `https://www.notion.so/${notionPageId.replace(/-/g, '')}`;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.innerHTML = '<svg width="16" height="16" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M5.716 29.2178L2.27664 24.9331C1.44913 23.9023 1 22.6346 1 21.3299V5.81499C1 3.86064 2.56359 2.23897 4.58071 2.10125L20.5321 1.01218C21.691 0.933062 22.8428 1.24109 23.7948 1.8847L29.3992 5.67391C30.4025 6.35219 31 7.46099 31 8.64426V26.2832C31 28.1958 29.4626 29.7793 27.4876 29.9009L9.78333 30.9907C8.20733 31.0877 6.68399 30.4237 5.716 29.2178Z" fill="white"/><path d="M11.2481 13.5787V13.3756C11.2481 12.8607 11.6605 12.4337 12.192 12.3982L16.0633 12.1397L21.417 20.0235V13.1041L20.039 12.9204V12.824C20.039 12.303 20.4608 11.8732 20.9991 11.8456L24.5216 11.6652V12.1721C24.5216 12.41 24.3446 12.6136 24.1021 12.6546L23.2544 12.798V24.0037L22.1906 24.3695C21.3018 24.6752 20.3124 24.348 19.8036 23.5803L14.6061 15.7372V23.223L16.2058 23.5291L16.1836 23.6775C16.1137 24.1423 15.7124 24.4939 15.227 24.5155L11.2481 24.6926C11.1955 24.1927 11.5701 23.7456 12.0869 23.6913L12.6103 23.6363V13.6552L11.2481 13.5787Z" fill="#2d2d2d"/><path fill-rule="evenodd" clip-rule="evenodd" d="M20.6749 2.96678L4.72347 4.05585C3.76799 4.12109 3.02734 4.88925 3.02734 5.81499V21.3299C3.02734 22.1997 3.32676 23.0448 3.87843 23.7321L7.3178 28.0167C7.87388 28.7094 8.74899 29.0909 9.65435 29.0352L27.3586 27.9454C28.266 27.8895 28.9724 27.1619 28.9724 26.2832V8.64426C28.9724 8.10059 28.6979 7.59115 28.2369 7.27951L22.6325 3.49029C22.0613 3.10413 21.3702 2.91931 20.6749 2.96678ZM5.51447 6.057C5.29261 5.89274 5.3982 5.55055 5.6769 5.53056L20.7822 4.44711C21.2635 4.41259 21.7417 4.54512 22.1309 4.82088L25.1617 6.96813C25.2767 7.04965 25.2228 7.22563 25.0803 7.23338L9.08387 8.10336C8.59977 8.12969 8.12193 7.98747 7.73701 7.7025L5.51447 6.057ZM8.33357 10.8307C8.33357 10.311 8.75341 9.88177 9.29027 9.85253L26.203 8.93145C26.7263 8.90296 27.1667 9.30534 27.1667 9.81182V25.0853C27.1667 25.604 26.7484 26.0328 26.2126 26.0633L9.40688 27.0195C8.8246 27.0527 8.33357 26.6052 8.33357 26.0415V10.8307Z" fill="#2d2d2d"/></svg>';
    a.title = 'Notion';
    a.style.cssText = `
      margin-left: 6px;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      opacity: 0.8;
    `;
    a.onmouseenter = () => a.style.opacity = '1';
    a.onmouseleave = () => a.style.opacity = '0.8';
    const openBtn = bar.querySelector(`.${BTN_CLASS}`);
    if (openBtn) bar.insertBefore(a, openBtn);
    else bar.appendChild(a);
  }

  function tryInjectNotionLink(postEl, url) {
    if (!url || !chrome.storage?.local) return;
    chrome.storage.local.get(['devopsSavedMatches'], (result) => {
      if (chrome.runtime.lastError) return;
      const match = (result.devopsSavedMatches || []).find(m => m.url === url);
      if (match?.notionPageId) setNotionLink(postEl, match.notionPageId);
    });
  }

  // Shared helper: analyzeWithAI → storeAIAnalysis → syncMatchToNotion.
  // missingFields: string[] → merge-only update; null/undefined → full replace.
  // onDone(matchWithAI, syncResp) on success; onDone(null) on error.
  function _runAIAndSync({ matchId, text, match, postEl, useQueue = false, missingFields, onDone } = {}) {
    if (useQueue) updateAIQueue(+1);
    chrome.runtime.sendMessage({ action: 'analyzeWithAI', text, matchId }, (aiResp) => {
      if (useQueue) updateAIQueue(-1);
      if (chrome.runtime.lastError || !aiResp?.success) {
        if (!missingFields) {
          const errType = (aiResp && aiResp.error) || 'ai_error';
          chrome.runtime.sendMessage({ action: 'storeAIAnalysis', matchId, analysis: { _error: errType } });
          if (postEl) _updateAITag(postEl, { _error: errType });
        }
        onDone && onDone(null);
        return;
      }
      if (postEl) _updateAITag(postEl, aiResp.analysis);
      const storeMsg = {
        action: 'storeAIAnalysis',
        matchId,
        analysis: aiResp.analysis,
        textHash: aiResp.textHash,
        ...(missingFields && { missingFields }),
        ...(!aiResp.skipped && {
          timeToProcess: aiResp.timeToProcess,
          model: aiResp.model,
          tokens: aiResp.tokens,
        }),
      };
      chrome.runtime.sendMessage(storeMsg, () => {
        const matchWithAI = { ...match, aiAnalysis: aiResp.analysis, status: 'ai_processed' };
        chrome.runtime.sendMessage({ action: 'syncMatchToNotion', match: matchWithAI }, (syncResp) => {
          onDone && onDone(matchWithAI, syncResp);
        });
      });
    });
  }

  // Returns array of field names missing from a match's aiAnalysis, or null if none missing.
  function _getMissingAIFields(match) {
    const ai = match.aiAnalysis;
    if (!ai || ai._error) return null; // needs full reprocess
    const missing = [];
    if (!ai.jobTitles?.length && !ai.jobTitle) missing.push('Job Title');
    if (ai.visaSponsorship === null || ai.visaSponsorship === undefined) missing.push('VISA');
    if (ai.confidence === null || ai.confidence === undefined) missing.push('AI Confidence');
    return missing.length ? missing : null;
  }

  function checkDuplicateAndDecorate(postEl, bar, url, text) {
    // Check if this post is a duplicate of an already saved post
    try {
      if (!chrome.storage || !chrome.storage.local) return;
      
      chrome.storage.local.get(['devopsSavedMatches'], (result) => {
        if (chrome.runtime.lastError) return;
        
        const matches = result.devopsSavedMatches || [];
        
        // Create temporary match object for duplicate checking
        const snippet = text.substring(0, 200) + (text.length > 200 ? '...' : '');
        const tempMatch = {
          url: url || null,
          snippet: snippet
        };
        
        let isDuplicate = false;
        let reason = '';
        
        // Check URL-based duplicate first
        if (url && matches.some(m => m.url === url)) {
          isDuplicate = true;
          reason = 'URL match';
        } else {
          // Check content-based duplicate
          const duplicateId = findDuplicate(tempMatch, matches);
          if (duplicateId) {
            isDuplicate = true;
            reason = 'Content match';
          }
        }
        
        // If duplicate found, add badge and increment session counter
        if (isDuplicate) {
          addDuplicateBadge(bar, reason);
          
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
      });
    } catch (e) {
      dbg('checkDuplicateAndDecorate error:', e.message);
    }
  }
  
  function addDuplicateBadge(bar, reason) {
    const duplicateBadge = document.createElement("span");
    duplicateBadge.className = "devops-scan-badge devops-scan-badge--duplicate";
    duplicateBadge.textContent = "🔄 Duplicate";
    duplicateBadge.title = `This post matches an already saved post (${reason})`;
    duplicateBadge.style.cssText = `
      background: #ff9800;
      color: white;
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      margin-left: 8px;
      cursor: help;
    `;
    bar.appendChild(duplicateBadge);
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
    
    // Only count posts that passed classification (V2: confidence >= 40 with devops keyword)
    if (!info.hiringHit && !(info.confidence >= 40)) {
      dbg('SKIP counting: not a hiring post and low V2 confidence');
      updateIndicator();
      return;
    }
    
    const key = url || `n:${seenMatches.size + 1}`;
    if (seenMatches.has(key)) return;
    seenMatches.add(key);
    syncCounts();
    updateIndicator();
  }

  // calculateSimilarity, findDuplicate defined in shared/matchHelpers.js

  function saveMatch(postEl, url, info, text) {
    // Skip invalid posts (USC only, no sponsorship, etc.)
    if (info.invalidHit) {
      dbg('SKIP saving: invalid post (contains:', info.invalidHit + ')');
      return;
    }
    
    // Only save posts that passed classification (V2: confidence >= 40 with devops keyword)
    if (!info.hiringHit && !(info.confidence >= 40)) {
      dbg('SKIP saving: not a hiring post and low V2 confidence');
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
        
        // Extract emails from post body only (not comments)
        const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;
        const postBodyText = getPostBodyOnly(postEl);
        const emails = postBodyText.match(emailRegex) || [];
        // Deduplicate and limit to first 5 emails
        const uniqueEmails = [...new Set(emails)].slice(0, 5);
        
        // Create text snippet (first 200 chars)
        const snippet = text.substring(0, 200) + (text.length > 200 ? '...' : '');
        
        // Get the current page URL (feed, group, search page)
        const sourceUrl = window.location.href;
        
        const relevanceScore = computeRelevanceScore(
          info.devopsHits, info.hiringHits, info.skills, text, uniqueEmails
        );

        const match = {
          id: `match:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
          url: url || null,
          sourceUrl: sourceUrl, // Page URL where this post was found
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
          hiringSignals: info.hiringHits || [], // ALL matched hiring signals (array)
          relevanceScore: relevanceScore // Computed lead quality score
        };
        
        // Log extracted emails for debugging
        if (uniqueEmails.length > 0) {
          dbg(`extracted ${uniqueEmails.length} email(s):`, uniqueEmails.join(', '));
        }
        
        // Avoid duplicates based on URL; but if already saved without AI, run AI now
        if (url && matches.some(m => m.url === url)) {
          const existing = matches.find(m => m.url === url);
          const needsAI = existing && (!existing.aiAnalysis || existing.aiAnalysis._error);
          if (!needsAI) {
            dbg('match already saved:', url);
            if (existing.aiAnalysis) _updateAITag(postEl, existing.aiAnalysis);
            return;
          }
          dbg('match already saved but missing AI, running analysis:', url);
          _runAIAndSync({ matchId: existing.id, text, match: existing, postEl, useQueue: true });
          return;
        }
        
        chrome.runtime.sendMessage({ action: 'saveMatch', match }, (saveResp) => {
          if (chrome.runtime.lastError) {
            dbg('saveMatch error:', chrome.runtime.lastError.message);
            return;
          }
          if (saveResp && saveResp.duplicate) {
            dbg('match already saved (race dedup):', match.url);
            return;
          }
          if (saveResp && saveResp.error) {
            dbg('storage.set error:', saveResp.error);
            return;
          }
          dbg('saved match:', match.id, info.devopsHits.join(', '));

          // Step 1 — sync to Notion immediately so data is never lost
          chrome.runtime.sendMessage({ action: 'syncMatchToNotion', match }, (syncResp) => {
            if (chrome.runtime.lastError) return;
            if (syncResp && syncResp.error) dbg('notion sync error:', syncResp.error);
            if (syncResp && syncResp.success && syncResp.notionPageId) {
              dbg('notion sync ok:', match.id);
              // Cache notionPageId locally — avoids storage re-read before Step 3
              match.notionPageId = syncResp.notionPageId;
              setNotionLink(postEl, syncResp.notionPageId);
            }

            // Step 2 — run AI analysis in the background, then PATCH Notion (Step 3)
            _runAIAndSync({ matchId: match.id, text, match, postEl, useQueue: true, onDone: (matchWithAI, patchResp) => {
              if (!matchWithAI) { dbg('AI analyze skipped/error:', match.id); return; }
              dbg('AI analysis:', JSON.stringify(matchWithAI.aiAnalysis));
              if (patchResp?.success) dbg('notion AI patch ok:', match.id);
              if (patchResp?.error) dbg('notion AI patch error:', patchResp.error);
              refreshStorageCounts();
            } });
          });
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
      <div class="devops-scan-indicator__row">
        <span class="devops-scan-indicator__label">Notion today</span>
        <span class="devops-scan-indicator__val" id="dsi-notion">—</span>
      </div>
      <div class="devops-scan-indicator__row">
        <span class="devops-scan-indicator__label">AI today</span>
        <span class="devops-scan-indicator__val" id="dsi-ai">—</span>
      </div>
      <div class="devops-scan-indicator__row" id="dsi-ai-queue-row" style="display:none;">
        <span class="devops-scan-indicator__label">AI queue</span>
        <span class="devops-scan-indicator__val" id="dsi-ai-queue" style="color:#f9a825;">0</span>
      </div>
      <div id="dsi-dup-banner" style="display:none;margin-top:6px;padding:4px 6px;background:#b71c1c;color:#fff;border-radius:4px;font-size:11px;text-align:center;">⏹ Stopped: duplicates</div>
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

  function refreshStorageCounts() {
    try {
      if (!chrome.storage?.local) return;
      chrome.storage.local.get(['devopsSavedMatches'], (result) => {
        if (chrome.runtime.lastError) return;
        const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
        const cutoff = todayStart.getTime();
        const matches = (result.devopsSavedMatches || []).filter(m => m.timestamp >= cutoff);
        const notionCount = matches.filter(m => m.notionPageId && !m.notionDeleted).length;
        const aiCount = matches.filter(m => m.aiAnalysis && !m.aiAnalysis._error).length;
        const el = indicatorEl;
        if (!el) return;
        const notionEl = el.querySelector('#dsi-notion');
        const aiEl = el.querySelector('#dsi-ai');
        if (notionEl) notionEl.textContent = notionCount;
        if (aiEl) aiEl.textContent = aiCount;
      });
    } catch (e) { /* context invalidated */ }
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
  let aiPending = 0;

  function updateAIQueue(delta) {
    aiPending = Math.max(0, aiPending + delta);
    const row = document.getElementById('dsi-ai-queue-row');
    const val = document.getElementById('dsi-ai-queue');
    if (row) row.style.display = aiPending > 0 ? '' : 'none';
    if (val) val.textContent = aiPending;
  }
  
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
    const dupBanner = document.getElementById('dsi-dup-banner');
    if (dupBanner) dupBanner.style.display = '';

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
            duplicatesFoundInSession = 0;
            const b = document.getElementById('dsi-dup-banner');
            if (b) b.style.display = 'none';
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

  function startAutoScroll() {
    if (autoScrollEnabled) return; // Already enabled
    autoScrollEnabled = true;
    dbg("Auto-scroll: ENABLED");
    // Reset duplicate counter when starting a new auto-scroll session
    duplicatesFoundInSession = 0;
    dbg("Auto-scroll: Reset duplicate counter to 0");
    performAutoScroll();
    updateAutoScrollStatus();
  }

  function stopAutoScroll() {
    if (!autoScrollEnabled) return; // Already disabled
    autoScrollEnabled = false;
    dbg("Auto-scroll: DISABLED");
    if (autoScrollTimer) {
      clearTimeout(autoScrollTimer);
      autoScrollTimer = null;
    }
    updateAutoScrollStatus();
  }

  function toggleAutoScroll() {
    if (autoScrollEnabled) {
      stopAutoScroll();
    } else {
      startAutoScroll();
    }
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

    // Process Today button
    const processTodayBtn = document.createElement('button');
    processTodayBtn.type = 'button';
    processTodayBtn.className = 'devops-scan-process-today-btn';
    processTodayBtn.textContent = '⚡ Process Today';
    processTodayBtn.title = "Retry AI analysis + Notion sync for today's matches missing either";
    processTodayBtn.style.cssText = `
      width: 100%;
      margin-top: 6px;
      padding: 7px;
      background: #5c35cc;
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
      transition: background 0.2s;
    `;
    processTodayBtn.addEventListener('mouseenter', () => { processTodayBtn.style.background = '#3d1fa8'; });
    processTodayBtn.addEventListener('mouseleave', () => {
      if (!processTodayBtn.disabled) processTodayBtn.style.background = '#5c35cc';
    });
    processTodayBtn.addEventListener('click', () => processTodayMatches(processTodayBtn));
    indicator.insertBefore(processTodayBtn, hideBtn);

    const fillMissingBtn = document.createElement('button');
    fillMissingBtn.type = 'button';
    fillMissingBtn.className = 'devops-scan-fill-missing-btn';
    fillMissingBtn.textContent = '🔍 Fill Missing';
    fillMissingBtn.title = 'Run AI only on matches with incomplete fields (job title, visa, confidence) — never overwrites existing data';
    fillMissingBtn.style.cssText = `
      width: 100%;
      margin-top: 4px;
      padding: 7px;
      background: #1565c0;
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
      transition: background 0.2s;
    `;
    fillMissingBtn.addEventListener('mouseenter', () => { fillMissingBtn.style.background = '#0d47a1'; });
    fillMissingBtn.addEventListener('mouseleave', () => { if (!fillMissingBtn.disabled) fillMissingBtn.style.background = '#1565c0'; });
    fillMissingBtn.addEventListener('click', () => fillMissingFields(fillMissingBtn));
    indicator.insertBefore(fillMissingBtn, hideBtn);

    updateAutoScrollStatus();
  }

  function processTodayMatches(btn) {
    if (!chrome.storage?.local) return;
    btn.disabled = true;
    btn.textContent = '⏳ Processing…';
    btn.style.background = '#424242';

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const cutoff = todayStart.getTime();

    chrome.storage.local.get(['devopsSavedMatches'], (result) => {
      if (chrome.runtime.lastError) { resetBtn(btn); return; }
      const matches = (result.devopsSavedMatches || []).filter(m =>
        m.timestamp >= cutoff &&
        (!m.notionPageId || m.notionDeleted || !m.aiAnalysis || m.aiAnalysis._error)
      );

      if (matches.length === 0) {
        btn.textContent = '✅ All caught up';
        btn.style.background = '#2e7d32';
        btn.disabled = false;
        setTimeout(() => resetBtn(btn), 3000);
        return;
      }

      dbg(`[ProcessToday] ${matches.length} match(es) need processing`);
      let pending = matches.length;
      let done = 0;

      const finish = () => {
        done++;
        btn.textContent = `⏳ ${done}/${matches.length}`;
        if (done >= matches.length) {
          refreshStorageCounts();
          btn.textContent = `✅ Done (${matches.length})`;
          btn.style.background = '#2e7d32';
          btn.disabled = false;
          setTimeout(() => resetBtn(btn), 4000);
        }
      };

      matches.forEach(match => {
        // Ensure Notion sync first (creates page if missing), then run AI if needed
        chrome.runtime.sendMessage({ action: 'syncMatchToNotion', match }, (syncResp) => {
          if (chrome.runtime.lastError) { finish(); return; }
          if (!match.aiAnalysis || match.aiAnalysis._error) {
            const text = match.fullText || match.snippet || '';
            _runAIAndSync({ matchId: match.id, text, match, onDone: () => finish() });
          } else {
            finish();
          }
        });
      });
    });
  }

  function resetBtn(btn) {
    btn.disabled = false;
    btn.textContent = '⚡ Process Today';
    btn.style.background = '#5c35cc';
  }

  function fillMissingFields(btn) {
    if (!chrome.storage?.local) return;
    btn.disabled = true;
    btn.textContent = '⏳ Scanning…';
    btn.style.background = '#424242';

    chrome.storage.local.get(['devopsSavedMatches'], (result) => {
      if (chrome.runtime.lastError) { resetFillBtn(btn); return; }
      const candidates = (result.devopsSavedMatches || [])
        .map(m => ({ match: m, missing: _getMissingAIFields(m) }))
        .filter(({ missing }) => missing !== null);

      if (candidates.length === 0) {
        btn.textContent = '✅ No gaps';
        btn.style.background = '#2e7d32';
        btn.disabled = false;
        setTimeout(() => resetFillBtn(btn), 3000);
        return;
      }

      dbg(`[FillMissing] ${candidates.length} match(es) with gaps`);
      let done = 0;
      const finish = () => {
        done++;
        btn.textContent = `⏳ ${done}/${candidates.length}`;
        if (done >= candidates.length) {
          refreshStorageCounts();
          btn.textContent = `✅ Filled (${candidates.length})`;
          btn.style.background = '#2e7d32';
          btn.disabled = false;
          setTimeout(() => resetFillBtn(btn), 4000);
        }
      };

      candidates.forEach(({ match, missing }) => {
        const text = match.fullText || match.snippet || '';
        _runAIAndSync({ matchId: match.id, text, match, missingFields: missing, onDone: () => finish() });
      });
    });
  }

  function resetFillBtn(btn) {
    btn.disabled = false;
    btn.textContent = '🔍 Fill Missing';
    btn.style.background = '#1565c0';
  }

  function findPostRoot(el) {
    // Step 1: Try every stable selector first — works on feed, search results,
    // and groups. This is the most reliable path and avoids the heuristic
    // overshooting on search results pages where multiple posts share a deep
    // common ancestor.
    for (const sel of POST_ROOT_SELECTORS) {
      const root = el.closest(sel);
      if (root) return root;
    }

    // Step 2: Fallback walk-up heuristic for layouts where no stable selector
    // matches (e.g. future LinkedIn redesigns). Walk up until we reach an
    // element that sits among many siblings — that's the post list level.
    let current = el;
    for (let i = 0; i < 12; i++) {
      if (!current.parentElement) break;
      current = current.parentElement;
      const siblings = current.parentElement ? current.parentElement.children.length : 0;
      // Stop when we're in a list of 5+ peers (feed/search list) or gone far enough
      if (siblings >= 5 || i >= 8) return current;
    }
    return current;
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
      const info = classifyV2(text, postEl);
      bumpAnalyzed(postEl);
      if (info.match) {
        dbg("match:", info.devopsHits.join(', '), info.hiringHit ? `+ ${info.hiringHit}` : "");
        trackKeywordHits(info.devopsHits, info.hiringHits, info.skills);
        decorate(postEl, info, text);
      } else {
        markScanned(postEl, text.length);
      }
    });
    if (processed) dbg(`  processed ${processed} new posts this scan`);
    if (isJobsPage()) scanJobCards();
  }

  // Re-scan as LinkedIn lazily injects more posts during scroll.
  // 100ms debounce: fast enough to catch newly injected posts promptly,
  // short enough to avoid firing on every micro-mutation LinkedIn makes.
  const obs = new MutationObserver(() => {
    clearTimeout(obs._t);
    obs._t = setTimeout(scanOnce, 100);
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

    // Flush keyword hit counts to storage every 30 seconds
    setInterval(flushKeywordHits, 30000);

    // Refresh Notion/AI counts every 10 seconds
    setInterval(refreshStorageCounts, 10000);
    refreshStorageCounts();

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
  let navigationScanTimers = []; // Track all pending scan timers so we can cancel on re-navigation

  function detectNavigation() {
    if (location.href !== lastUrl) {
      dbg("LinkedIn navigation detected:", lastUrl, "→", location.href);
      lastUrl = location.href;

      // Cancel any pending scan timers from a previous navigation
      navigationScanTimers.forEach(t => clearTimeout(t));
      navigationScanTimers = [];

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

      // Re-attach indicator and button immediately — no delay needed since
      // these are fixed-position elements appended directly to body and
      // survive LinkedIn's SPA routing. ensureIndicator() re-creates them
      // if LinkedIn happened to remove them.
      ensureIndicator();
      addAutoScrollButton();
      updateIndicator();

      // LinkedIn SPA navigation renders content progressively:
      // - ~300ms: skeleton/loading placeholder appears
      // - ~800ms: first posts may appear
      // - ~1500ms: full feed rendered
      // - ~3000ms: lazy-loaded content and groups fully settled
      // Schedule multiple progressive scans to catch content at each stage.
      const delays = [300, 800, 1500, 3000];
      delays.forEach(delay => {
        const t = setTimeout(() => {
          dbg(`Post-navigation scan at ${delay}ms`);
          scanOnce();
        }, delay);
        navigationScanTimers.push(t);
      });
    }
  }

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
      dbg("Reloading keywords from settings...");
      loadCustomKeywords();
      sendResponse({ success: true });
      return true;
    }

    if (message.action === 'matchSavedByOther' && message.url) {
      _markSavedByOther(message.url, message.savedBy);
      return true;
    }

    if (message.action === 'serverSyncQueued') {
      // Server was offline when save fired — show pill on the matching post
      const POST_SELECTORS_ALL = [...POST_SELECTORS, ...POST_ROOT_SELECTORS];
      for (const sel of POST_SELECTORS_ALL) {
        document.querySelectorAll(sel).forEach((postEl) => {
          if (message.url && getPostUrl(postEl) !== message.url) return;
          _markServerOffline(postEl);
        });
      }
      return true;
    }

    if (message.action === 'serverSyncComplete') {
      _markServerSynced(message.url, message.matchId);
      return true;
    }
  });

  function _markSavedByOther(url, savedBy) {
    const POST_SELECTORS_ALL = [...POST_SELECTORS, ...POST_ROOT_SELECTORS];
    for (const sel of POST_SELECTORS_ALL) {
      document.querySelectorAll(sel).forEach((postEl) => {
        const postUrl = getPostUrl(postEl);
        if (postUrl !== url) return;
        if (postEl.querySelector('.devops-scan-saved-by-other')) return;
        const bar = postEl.querySelector('.devops-scan-bar');
        if (!bar) return;
        const badge = document.createElement('span');
        badge.className = 'devops-scan-saved-by-other';
        badge.textContent = savedBy ? `👤 saved by ${savedBy}` : '👤 saved by another user';
        badge.style.cssText = 'font-size:11px;color:#1565c0;background:#e3f2fd;border-radius:4px;padding:2px 6px;margin-left:6px;';
        bar.appendChild(badge);
      });
    }
  }

  function _markServerOffline(postEl) {
    if (!postEl || postEl.querySelector('.devops-scan-offline-pill')) return;
    const bar = postEl.querySelector('.devops-scan-bar');
    if (!bar) return;
    const pill = document.createElement('span');
    pill.className = 'devops-scan-offline-pill';
    pill.textContent = '⚡ Local only';
    pill.title = 'Server was offline — saved locally, will auto-sync when server is back.';
    pill.style.cssText = 'font-size:11px;color:#92400e;background:#fef3c7;border:1px solid #f59e0b;border-radius:4px;padding:2px 6px;margin-left:6px;cursor:default;';
    bar.appendChild(pill);
  }

  function _markServerSynced(url, matchId) {
    const POST_SELECTORS_ALL = [...POST_SELECTORS, ...POST_ROOT_SELECTORS];
    for (const sel of POST_SELECTORS_ALL) {
      document.querySelectorAll(sel).forEach((postEl) => {
        const postUrl = getPostUrl(postEl);
        if (url && postUrl !== url) return;
        const pill = postEl.querySelector('.devops-scan-offline-pill');
        if (!pill) return;
        pill.textContent = '✅ Synced';
        pill.title = 'Successfully synced to server.';
        pill.style.cssText = 'font-size:11px;color:#166534;background:#dcfce7;border:1px solid #22c55e;border-radius:4px;padding:2px 6px;margin-left:6px;cursor:default;';
        setTimeout(() => pill.remove(), 4000);
      });
    }
  }

  // ---- LinkedIn Jobs Search Scanner (/jobs/search) ---------------------------

  const JOBS_MARK_ATTR = 'data-devops-job';
  const seenJobs = new Set();

  function isJobsPage() {
    return location.pathname.startsWith('/jobs/');
  }

  function getJobCardText(card) {
    // Job cards have title + company + location in structured elements
    const parts = [];
    const title    = card.querySelector('.job-card-list__title, .job-card-container__link, [data-control-name="jobcard_title"]');
    const company  = card.querySelector('.job-card-container__primary-description, .artdeco-entity-lockup__subtitle');
    const location = card.querySelector('.job-card-container__metadata-item, .artdeco-entity-lockup__caption');
    if (title)    parts.push(title.innerText || title.textContent);
    if (company)  parts.push(company.innerText || company.textContent);
    if (location) parts.push(location.innerText || location.textContent);
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  function getJobDetailText() {
    // Right-panel job detail view
    const detail = document.querySelector(
      '.job-view-layout, .jobs-description, .jobs-details__main-content, [data-job-id]'
    );
    return detail ? (detail.innerText || detail.textContent || '').replace(/\s+/g, ' ').trim() : '';
  }

  function getJobCardUrl(card) {
    const a = card.querySelector('a[href*="/jobs/view/"]');
    if (a) return a.href.split('?')[0];
    const jobId = card.getAttribute('data-job-id') || card.querySelector('[data-job-id]')?.getAttribute('data-job-id');
    if (jobId) return `https://www.linkedin.com/jobs/view/${jobId}/`;
    return null;
  }

  function saveJobMatch(url, text, cardText, info) {
    if (!chrome.storage || !chrome.storage.local) return;
    const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;
    const emails = [...new Set((text.match(emailRegex) || []).slice(0, 5))];
    const snippet = text.substring(0, 200) + (text.length > 200 ? '...' : '');
    const relevanceScore = computeRelevanceScore(info.devopsHits, info.hiringHits, info.skills, text, emails);

    // Try to get job title and company from card
    const titleEl   = document.querySelector('.job-card-list__title, .jobs-unified-top-card__job-title, h1.t-24');
    const companyEl = document.querySelector('.job-card-container__primary-description, .jobs-unified-top-card__company-name');
    const author = [
      titleEl   ? (titleEl.innerText   || titleEl.textContent).trim()   : null,
      companyEl ? (companyEl.innerText || companyEl.textContent).trim() : null,
    ].filter(Boolean).join(' — ') || 'Job Post';

    chrome.storage.local.get(['devopsSavedMatches'], (result) => {
      if (chrome.runtime.lastError) return;
      const matches = result.devopsSavedMatches || [];
      if (url && matches.some(m => m.url === url)) return;

      const match = {
        id: `match:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
        url,
        sourceUrl: window.location.href,
        timestamp: Date.now(),
        author,
        snippet,
        fullText: text,
        devopsKeywords: info.devopsHits,
        devopsKeyword: info.devopsHits[0],
        hiringSignal: info.hiringHit || null,
        invalidKeyword: null,
        isHiring: true,
        emails,
        skills: info.skills || [],
        status: 'new',
        hiringSignals: info.hiringHits || [],
        relevanceScore,
        source: 'jobs',
      };

      chrome.runtime.sendMessage({ action: 'saveMatch', match }, (saveResp) => {
        if (chrome.runtime.lastError || !saveResp || saveResp.duplicate || saveResp.error) return;
        dbg('[Jobs] saved job match:', url);
        updateIndicator();
        chrome.runtime.sendMessage({ action: 'syncMatchToNotion', match }, () => {
          if (chrome.runtime.lastError) return;
          _runAIAndSync({ matchId: match.id, text, match });
        });
      });
    });
  }

  function decorateJobCard(card, info, url) {
    card.setAttribute(JOBS_MARK_ATTR, 'match');
    card.style.borderLeft = '3px solid #2e7d32';
    card.style.backgroundColor = 'rgba(46,125,50,0.04)';

    const badge = document.createElement('div');
    badge.style.cssText = 'font-size:10px;color:#2e7d32;font-weight:700;padding:2px 4px;';
    badge.textContent = `DevOps · ${info.devopsHits.slice(0, 3).join(', ')}`;
    const firstChild = card.querySelector('a, div');
    if (firstChild) firstChild.parentNode.insertBefore(badge, firstChild);
  }

  function scanJobCards() {
    if (!isJobsPage()) return;

    const cards = document.querySelectorAll(
      'li.jobs-search-results__list-item, li[data-occludable-job-id], div.job-card-container, .scaffold-layout__list-container li'
    );

    cards.forEach(card => {
      if (card.getAttribute(JOBS_MARK_ATTR)) return;
      card.setAttribute(JOBS_MARK_ATTR, 'seen');

      const cardText = getJobCardText(card);
      if (!cardText || cardText.length < 10) return;

      const url = getJobCardUrl(card);
      if (url && seenJobs.has(url)) return;
      if (url) seenJobs.add(url);

      const info = classifyV2(cardText, card);
      if (!info.match) return;

      decorateJobCard(card, info, url);
      dbg('[Jobs] card match:', cardText.substring(0, 80));

      // When user clicks the card, grab full job description from the detail panel
      card.addEventListener('click', () => {
        setTimeout(() => {
          const detailText = getJobDetailText() || cardText;
          if (card.getAttribute(JOBS_MARK_ATTR) !== 'saved') {
            card.setAttribute(JOBS_MARK_ATTR, 'saved');
            saveJobMatch(url, detailText, cardText, info);
          }
        }, 1200);
      }, { once: true });

      // Auto-save if already viewed (detail panel matches current job)
      const activeJobId = url?.match(/\/jobs\/view\/(\d+)/)?.[1];
      const detailJobId = document.querySelector('[data-job-id]')?.getAttribute('data-job-id') ||
        document.querySelector('.jobs-unified-top-card__job-title')?.closest('[data-job-id]')?.getAttribute('data-job-id');
      if (activeJobId && activeJobId === detailJobId) {
        const detailText = getJobDetailText() || cardText;
        card.setAttribute(JOBS_MARK_ATTR, 'saved');
        saveJobMatch(url, detailText, cardText, info);
      }
    });
  }

  init();
})();
