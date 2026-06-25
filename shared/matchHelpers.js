// LinkedIn DevOps Scanner - Match Helpers
// Pure functions for scoring, similarity, and duplicate detection.
// Depends on: normalizeText (shared/utils.js)

function computeRelevanceScore(devopsHits, hiringHits, skills, text, emails) {
  let score = 0;
  const t = normalizeText(text);

  score += (devopsHits || []).length * 2;
  score += Math.min((hiringHits || []).length, 5);
  score += Math.min((skills || []).length, 8);
  if (emails && emails.length > 0) score += 5;
  if (/\b(remote|wfh|work from home|fully remote|100% remote)\b/.test(t)) score += 3;

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

function calculateSimilarity(str1, str2) {
  if (!str1 || !str2) return 0;

  const normalize = (s) => s.toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const s1 = normalize(str1);
  const s2 = normalize(str2);

  if (s1 === s2) return 100;
  if (s1.length === 0 || s2.length === 0) return 0;

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

function findDuplicate(newMatch, existingMatches, threshold = 85) {
  for (const existing of existingMatches) {
    if (newMatch.url && existing.url && newMatch.url === existing.url) {
      return existing.id;
    }
    if (!existing.snippet) continue;
    const similarity = calculateSimilarity(newMatch.snippet, existing.snippet);
    if (similarity >= threshold) {
      console.debug('[scanner] duplicate detected:', similarity + '% similar to', existing.id);
      return existing.id;
    }
  }
  return null;
}
