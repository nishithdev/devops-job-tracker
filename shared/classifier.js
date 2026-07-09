// LinkedIn DevOps Scanner - Classifier V2 (pure, testable)
// Contextual, sentence-level, negation-aware scoring. No DOM, no chrome.* —
// content.js wraps this with live keyword lists and post body text.
// Loaded as a plain content script before content.js (see manifest.json) and
// importable from Node for unit tests (module.exports guard at the bottom).

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

// Local regex cache — separate from content.js's highlight cache
const v2RegexCache = new Map();

function v2WordBoundaryRegex(keyword) {
  if (!v2RegexCache.has(keyword)) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    v2RegexCache.set(keyword, new RegExp(`\\b${escaped}\\b`, 'i'));
  }
  return v2RegexCache.get(keyword);
}

function v2FindAny(haystack, needles) {
  return needles.find((n) => {
    const needle = n.toLowerCase().trim();
    if (needle.length <= 3 && /^[a-z0-9]+$/.test(needle)) {
      return v2WordBoundaryRegex(needle).test(haystack);
    }
    return haystack.includes(needle);
  });
}

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

// classifyV2Core(text, lists, opts)
//   lists: { devopsKeywords, hiringSignals, invalidKeywords }
//   opts.bodyText: post body without header/comments — used only for the email
//     structural bonus (avoids matching emails in commenter names). Defaults to text.
function classifyV2Core(text, lists, opts = {}) {
  if (!text || text.trim().length < 20) return { match: false };

  const { devopsKeywords, hiringSignals, invalidKeywords } = lists;
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
    for (const keyword of devopsKeywords) {
      const needle = keyword.toLowerCase();
      const pos = sentence.indexOf(needle);
      if (pos === -1) continue;

      // Word boundary check for short keywords (≤3 chars)
      if (needle.length <= 3 && /^[a-z0-9]+$/.test(needle)) {
        if (!v2WordBoundaryRegex(needle).test(sentence)) continue;
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
    for (const signal of hiringSignals) {
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
  const bodyOnlyText = opts.bodyText != null ? opts.bodyText : text;
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
  const invalidHit = v2FindAny(t, invalidKeywords);
  if (invalidHit) {
    score -= 25; v2signals.push(`invalid keyword "${invalidHit}" -25`);
  }

  const confidence = Math.max(0, Math.min(100, score));
  // Require at least one devops keyword + confidence threshold
  const match = devopsHits.length > 0 && confidence >= 40;

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

// Node (tests) — no-op in the content-script world
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { classifyV2Core, v2SplitSentences, v2GetContext, v2IsNegated };
}
