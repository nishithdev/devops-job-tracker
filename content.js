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
  const lower = (s) => (s || "").toLowerCase().replace(/[\s ]+/g, ' ').trim();

  function findAny(haystack, needles) {
    return needles.find((n) => {
      // Normalize needle to lowercase so it matches the lowercased haystack
      // regardless of how the user typed the keyword (SRE, sre, Sre all work)
      const needle = n.toLowerCase();
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
      const needle = n.toLowerCase();
      if (needle.length <= 3 && /^[a-z0-9]+$/.test(needle)) {
        const regex = getCachedRegex(needle, 'i');
        return regex.test(haystack);
      }
      return haystack.includes(needle);
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
    
    // Find ALL matching hiring signals (not just the first one)
    const hiringHits = findAll(t, HIRING_SIGNALS);
    const hiringHit = hiringHits.length > 0 ? hiringHits[0] : null;
    
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
      dbg("Hiring signals:", hiringHits.join(', '));
      dbg("Invalid keyword:", invalidHit || "none");
      dbg("Skills:", devopsHits.join(', ') || "none");
      dbg("--- FULL POST TEXT (with highlights) ---");
      dbg(highlightedText);
      dbg("--- END POST TEXT ---");
    }
    return { match: true, devopsHits, hiringHit, hiringHits, invalidHit, skills: devopsHits };
  }

  // ---- Classifier V2 — contextual, sentence-level, negation-aware ----------
  //
  // Improvements over classify():
  //   1. Negation detection  — "no terraform required" no longer matches
  //   2. Sentence context    — keyword in "we're hiring X" scores higher than
  //                            "we use X internally"
  //   3. Role vs tool weight — role keyword alone is strong; tool keyword needs
  //                            supporting context
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

  // ---- Relevance scoring --------------------------------------------------
  // Scores a match 0-∞ so saved.js can sort best leads to the top.
  // Weights:
  //   +2 per unique DevOps keyword hit
  //   +1 per hiring signal (capped at 5)
  //   +1 per matched skill (capped at 8)
  //   +5 if at least one email was extracted
  //   +3 if "remote" / "wfh" / "work from home" appears
  //   +3 per C2C/contract term (capped at 9)
  function computeRelevanceScore(devopsHits, hiringHits, skills, text, emails) {
    let score = 0;
    const t = lower(text);

    // DevOps keyword hits (+2 each, no cap — more specific = stronger signal)
    score += (devopsHits || []).length * 2;

    // Hiring signals (+1 each, cap 5)
    score += Math.min((hiringHits || []).length, 5);

    // Skills (+1 each, cap 8)
    score += Math.min((skills || []).length, 8);

    // Email present (+5 — high-value for cold outreach)
    if (emails && emails.length > 0) score += 5;

    // Remote work signals (+3)
    if (/\b(remote|wfh|work from home|fully remote|100% remote)\b/.test(t)) score += 3;

    // C2C / contract terms (+3 each, cap 9)
    const contractTerms = [
      'c2c', 'corp to corp', 'corp-to-corp', 'contract', '1099', 'w2', 'w-2',
      'contract to hire', 'c2h', 'contract-to-hire', 'contract only', 'contract role'
    ];
    let contractMatches = 0;
    for (const term of contractTerms) {
      if (t.includes(term)) {
        contractMatches++;
        if (contractMatches * 3 >= 9) break;
      }
    }
    score += Math.min(contractMatches * 3, 9);

    return score;
  }

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

  // Returns only the post author's body text — no fallback to full element so
  // comments and replies are never included. Used for email extraction.
  function getPostBodyOnly(postEl) {
    const bodySelectors = [
      "[data-testid='expandable-text-box']",
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
        // Skip nodes that are inside a comments section
        if (n.closest('.comments-container, .social-details-social-activity, [data-test-id="comments-container"]')) return;
        const txt = n.innerText || n.textContent || "";
        if (txt) parts.push(txt);
      });
    });
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

    // "Applied" toggle — only for real hiring posts (invalid posts are not saved)
    if (!info.invalidHit) {
      addApplyButton(bar, url, text, postEl);
      // Gmail draft button — only when emails are present in post
      const postBodyOnly = getPostBodyOnly(postEl);
      const postEmails = (postBodyOnly.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g) || []);
      const uniquePostEmails = [...new Set(postEmails)].slice(0, 5);
      if (uniquePostEmails.length > 0) {
        addGmailDraftButton(bar, uniquePostEmails, info, url);
      }
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

  // Write a new status back to the saved match; retries up to 3× if the
  // match hasn't been persisted by saveMatch() yet (async race window).
  function persistAppliedStatus(url, snippetPrefix, newStatus, attempt = 0) {
    try {
      if (!chrome.storage || !chrome.storage.local) return;
      chrome.storage.local.get(['devopsSavedMatches'], (result) => {
        if (chrome.runtime.lastError) return;
        const matches = result.devopsSavedMatches || [];
        const match = findSavedMatch(matches, url, snippetPrefix);
        if (match) {
          match.status = newStatus;
          chrome.storage.local.set({ devopsSavedMatches: matches }, () => {
            if (chrome.runtime.lastError) {
              dbg('persistAppliedStatus write error:', chrome.runtime.lastError.message);
            } else {
              dbg('apply status set:', newStatus, url || snippetPrefix);
            }
          });
        } else if (attempt < 4) {
          // saveMatch() hasn't finished yet — retry
          setTimeout(() => persistAppliedStatus(url, snippetPrefix, newStatus, attempt + 1), 600);
        } else {
          dbg('persistAppliedStatus: match not found after retries, status lost', url || snippetPrefix);
        }
      });
    } catch (e) {
      dbg('persistAppliedStatus error:', e.message);
    }
  }

  function addApplyButton(bar, url, text, postEl) {
    const snippetPrefix = text ? text.substring(0, 120) : '';

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "devops-scan-apply-btn";

    const setUnapplied = () => {
      btn.textContent = "📧 Applied?";
      btn.style.cssText = `
        padding: 5px 10px;
        background: #1565c0;
        color: #fff;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-size: 12px;
        font-weight: 600;
        margin-left: 6px;
        transition: background 0.15s;
      `;
      btn.title = "Mark this post as Applied";
      btn.dataset.applied = "false";
    };

    const setApplied = () => {
      btn.textContent = "✅ Applied";
      btn.style.cssText = `
        padding: 5px 10px;
        background: #2e7d32;
        color: #fff;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-size: 12px;
        font-weight: 600;
        margin-left: 6px;
        transition: background 0.15s;
      `;
      btn.title = "Click to undo Applied";
      btn.dataset.applied = "true";
    };

    setUnapplied();

    const applyDim = () => { if (postEl) postEl.classList.add('devops-scan-match--applied'); };
    const removeDim = () => { if (postEl) postEl.classList.remove('devops-scan-match--applied'); };

    // Sync initial state from storage (match may already be marked applied)
    try {
      if (chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(['devopsSavedMatches'], (result) => {
          if (chrome.runtime.lastError) return;
          const match = findSavedMatch(result.devopsSavedMatches || [], url, snippetPrefix);
          if (match && match.status === 'applied') { setApplied(); applyDim(); }
        });
      }
    } catch (e) { /* context invalidated */ }

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const isApplied = btn.dataset.applied === "true";
      const newStatus = isApplied ? 'new' : 'applied';
      // Optimistic UI update — feels instant
      if (newStatus === 'applied') { setApplied(); applyDim(); } else { setUnapplied(); removeDim(); }
      persistAppliedStatus(url, snippetPrefix, newStatus);
    });

    bar.appendChild(btn);
  }

  function addGmailDraftButton(bar, emails, info, postUrl) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "devops-scan-gmail-btn";
    btn.textContent = "✉️ Draft";
    btn.title = `Draft outreach email to: ${emails.join(', ')}`;

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();

      const to = emails[0];
      const role = (info.devopsHits || []).slice(0, 2).join(' / ') || 'DevOps';
      const subject = encodeURIComponent(`Interested in ${role} opportunity`);
      const body = encodeURIComponent(
        `Hi,\n\nI came across your post about a ${role} role and I'm very interested.\n\n` +
        `I have experience with ${(info.skills || info.devopsHits || []).slice(0, 3).join(', ')} ` +
        `and would love to connect.\n\nWould you be open to a quick chat?\n\nBest regards`
      );
      const gmailUrl = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to)}&su=${subject}&body=${body}`;
      window.open(gmailUrl, "_blank", "noopener,noreferrer");
    });

    bar.appendChild(btn);
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
      // Check URL first (exact match)
      if (newMatch.url && existing.url && newMatch.url === existing.url) {
        return existing.id;
      }
      
      // Check snippet similarity (guard against missing snippet on older saved matches)
      if (!existing.snippet) continue;
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
          duplicateOf: null, // Will be set if this is a duplicate
          hiringSignals: info.hiringHits || [], // ALL matched hiring signals (array)
          relevanceScore: relevanceScore // Computed lead quality score
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
          // Note: duplicate counter is incremented in checkDuplicateAndDecorate()
          // to avoid double-counting and ensure UI badge appears first
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
          dbg('saved match:', match.id, info.devopsHits.join(', '));

          // Step 1 — sync to Notion immediately so data is never lost
          chrome.runtime.sendMessage({ action: 'syncMatchToNotion', match }, (syncResp) => {
            if (chrome.runtime.lastError) return;
            if (syncResp && syncResp.error) dbg('notion sync error:', syncResp.error);
            if (syncResp && syncResp.success) dbg('notion sync ok:', match.id);

            // Step 2 — run AI analysis in the background
            chrome.runtime.sendMessage({ action: 'analyzeWithAI', text }, (aiResp) => {
              if (chrome.runtime.lastError || !aiResp || !aiResp.success) {
                dbg('AI analyze skipped:', aiResp && aiResp.error);
                return;
              }
              dbg('AI analysis:', JSON.stringify(aiResp.analysis));

              // Step 3 — store AI result, then PATCH the existing Notion page
              chrome.runtime.sendMessage({
                action: 'storeAIAnalysis',
                matchId: match.id,
                analysis: aiResp.analysis,
                timeToProcess: aiResp.timeToProcess,
                model: aiResp.model,
              }, () => {
                // Re-read to get notionPageId that was stored during Step 1
                chrome.storage.local.get(['devopsSavedMatches'], (res) => {
                  const fresh = (res.devopsSavedMatches || []).find(m => m.id === match.id);
                  if (fresh) {
                    chrome.runtime.sendMessage({ action: 'syncMatchToNotion', match: fresh }, (patchResp) => {
                      if (chrome.runtime.lastError) return;
                      if (patchResp && patchResp.success) dbg('notion AI patch ok:', match.id);
                      if (patchResp && patchResp.error) dbg('notion AI patch error:', patchResp.error);
                    });
                  }
                });
              });
            });
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
    
    updateAutoScrollStatus();
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
      // Reload keywords from storage when settings are updated
      dbg("Reloading keywords from settings...");
      loadCustomKeywords();
      sendResponse({ success: true });
      return true;
    }
  });

  init();
})();
