#!/usr/bin/env node
// Rebuild the classifier regression baseline from captured diagnostic posts.
//
//   node scripts/build-classifier-fixtures.js
//
// Reads server/diagnostics/posts.jsonl, dedupes posts (keeps the longest text
// per post: "see more" expansions re-capture the same post), scores each with
// classifyV2Core + DEFAULT keywords, and writes the results to
// test/fixtures/classifier-baseline.json.
//
// The baseline pins CURRENT classifier behavior: after a code change, the
// regression test (test/classifier.baseline.test.js) fails on any post whose
// decision or confidence shifted. Rerun this script to accept intentional
// changes. The file contains raw LinkedIn post text and is gitignored.

const fs = require('fs');
const path = require('path');

const { classifyV2Core } = require('../shared/classifier.js');
const { DEFAULT_KEYWORDS } = require('../shared/keywordConfig.js');

const root = path.join(__dirname, '..');
const src = path.join(root, 'server', 'diagnostics', 'posts.jsonl');
const outDir = path.join(root, 'test', 'fixtures');
const out = path.join(outDir, 'classifier-baseline.json');

if (!fs.existsSync(src)) {
  console.error(`No diagnostic capture file at ${src}. Enable Diagnostic Post Capture in settings and scroll LinkedIn first.`);
  process.exit(1);
}

const records = fs.readFileSync(src, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line, i) => {
    try { return JSON.parse(line); }
    catch { console.warn(`skipping malformed line ${i + 1}`); return null; }
  })
  .filter(r => r && typeof r.text === 'string' && r.text.trim().length >= 20);

// Dedupe: same post re-captured as its text grows; key by first 120 chars,
// keep the longest version.
const byKey = new Map();
for (const r of records) {
  const key = r.text.slice(0, 120);
  const prev = byKey.get(key);
  if (!prev || r.text.length > prev.text.length) byKey.set(key, r);
}

const baseline = [...byKey.values()].map(r => {
  const info = classifyV2Core(r.text, DEFAULT_KEYWORDS);
  return {
    source: r.source || null,
    capturedDecision: r.decision || null, // what the extension decided at capture time (may reflect custom keywords)
    text: r.text,
    expected: {
      match: info.match,
      confidence: info.confidence ?? null,
      devopsHits: info.devopsHits || [],
      invalidHit: info.invalidHit || null,
    },
  };
});

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(out, JSON.stringify(baseline, null, 2) + '\n');

const matches = baseline.filter(b => b.expected.match).length;
console.log(`Wrote ${baseline.length} baseline posts (${matches} match / ${baseline.length - matches} skip) → ${path.relative(root, out)}`);
