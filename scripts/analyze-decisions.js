// Analyze classifier decisions against user-action labels and fit weights.
//
// Input: JSON export from the diagnostics page (btn-export), which contains
//   decisions: [{ ts, url, textHash, outcome, confidence, features, ... }]
//   labels:    [{ ts, url, matchId, action }]
//
// A decision is labeled POSITIVE if the user later acted on the post
// (opened it, or set status to applied/interviewing/interested), NEGATIVE if
// it was surfaced as a match but never acted on after MIN_AGE_DAYS, and
// UNLABELED otherwise (skips have no user exposure, so only AI/threshold
// disagreements among them are reported, not trained on).
//
// Output: per-feature precision stats + logistic-regression weights over the
// feature vector logged by classifyV2 (keep FEATURE_KEYS in sync with it).
//
// Usage: node scripts/analyze-decisions.js <export.json>

'use strict';

const fs = require('fs');

const MIN_AGE_DAYS = 3; // unacted matches younger than this stay unlabeled
const POSITIVE_ACTIONS = /^(opened|status:(applied|interviewing|interested|in progress))$/i;

const FEATURE_KEYS = [
  'ctxHiring', 'ctxRequirements', 'ctxNeutral', 'ctxCompany',
  'roleHits', 'negated', 'hiringSignals',
  'yearsExp', 'salary', 'email', 'applyInstr', 'bullets', 'remote',
  'invalid',
];

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node scripts/analyze-decisions.js <diagnostics-export.json>');
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const decisions = data.decisions || [];
  const labels = data.labels || [];
  if (!decisions.length) {
    console.error('No decisions in export. Browse LinkedIn with the extension first.');
    process.exit(1);
  }

  // Positive URLs = any positive user action
  const positiveUrls = new Set(
    labels.filter(l => l.url && POSITIVE_ACTIONS.test(l.action)).map(l => l.url)
  );

  const cutoff = Date.now() - MIN_AGE_DAYS * 86400_000;
  const matchOutcomes = /(^match$|gray_ai_match|gray_ai_error_match)/;

  // Dedup decisions by url/textHash (same post reclassified across sessions)
  const seen = new Set();
  const rows = [];
  for (const d of decisions) {
    const key = d.url || d.textHash;
    if (seen.has(key)) continue;
    seen.add(key);

    const surfaced = matchOutcomes.test(d.outcome);
    let label = null;
    if (d.url && positiveUrls.has(d.url)) label = 1;
    else if (surfaced && d.ts < cutoff) label = 0;
    rows.push({ ...d, surfaced, label });
  }

  const labeled = rows.filter(r => r.label !== null);
  const pos = labeled.filter(r => r.label === 1).length;
  console.log(`decisions: ${rows.length} unique  |  labeled: ${labeled.length} (${pos} pos / ${labeled.length - pos} neg)`);

  // ---- Per-feature stats ----------------------------------------------------
  if (labeled.length) {
    console.log('\nPer-feature precision (among labeled posts where feature fired):');
    console.log('feature'.padEnd(18), 'fired'.padStart(6), 'pos'.padStart(5), 'precision'.padStart(10));
    for (const k of FEATURE_KEYS) {
      const fired = labeled.filter(r => (r.features?.[k] || 0) > 0);
      if (!fired.length) continue;
      const fpos = fired.filter(r => r.label === 1).length;
      console.log(k.padEnd(18), String(fired.length).padStart(6), String(fpos).padStart(5),
        ((fpos / fired.length * 100).toFixed(1) + '%').padStart(10));
    }
  }

  // ---- Confidence calibration ------------------------------------------------
  if (labeled.length) {
    console.log('\nConfidence-band precision:');
    for (const [lo, hi] of [[0, 25], [25, 40], [40, 55], [55, 70], [70, 101]]) {
      const band = labeled.filter(r => r.confidence >= lo && r.confidence < hi);
      if (!band.length) continue;
      const bpos = band.filter(r => r.label === 1).length;
      console.log(`  [${lo}-${hi})`.padEnd(12), `n=${band.length}`.padEnd(8),
        `precision=${(bpos / band.length * 100).toFixed(1)}%`);
    }
  }

  // ---- Logistic regression ----------------------------------------------------
  if (labeled.length < 50) {
    console.log(`\nNeed >= 50 labeled posts to fit weights (have ${labeled.length}). Keep browsing + acting on matches.`);
    return;
  }

  const X = labeled.map(r => FEATURE_KEYS.map(k => r.features?.[k] || 0));
  const y = labeled.map(r => r.label);
  const { weights, bias } = fitLogistic(X, y, 2000, 0.1, 0.01);

  console.log('\nFitted weights (log-odds per feature unit; scale to taste for V2 scores):');
  const scale = 10; // arbitrary readable scale
  FEATURE_KEYS.forEach((k, i) => {
    console.log(`  ${k.padEnd(18)} ${(weights[i] * scale).toFixed(1).padStart(7)}`);
  });
  console.log(`  ${'bias'.padEnd(18)} ${(bias * scale).toFixed(1).padStart(7)}`);

  // Training accuracy
  let correct = 0;
  X.forEach((xi, i) => {
    const p = sigmoid(dot(xi, weights) + bias);
    if ((p >= 0.5 ? 1 : 0) === y[i]) correct++;
  });
  console.log(`\ntraining accuracy: ${(correct / y.length * 100).toFixed(1)}%  (baseline always-majority: ${(Math.max(pos, y.length - pos) / y.length * 100).toFixed(1)}%)`);
}

function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }
function dot(a, b) { return a.reduce((s, v, i) => s + v * b[i], 0); }

// Plain batch gradient descent with L2 regularization
function fitLogistic(X, y, iters, lr, l2) {
  const n = X.length, d = X[0].length;
  let weights = new Array(d).fill(0);
  let bias = 0;
  for (let it = 0; it < iters; it++) {
    const gw = new Array(d).fill(0);
    let gb = 0;
    for (let i = 0; i < n; i++) {
      const err = sigmoid(dot(X[i], weights) + bias) - y[i];
      for (let j = 0; j < d; j++) gw[j] += err * X[i][j];
      gb += err;
    }
    for (let j = 0; j < d; j++) weights[j] -= lr * (gw[j] / n + l2 * weights[j]);
    bias -= lr * (gb / n);
  }
  return { weights, bias };
}

main();
