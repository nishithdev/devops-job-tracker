// Regression test: replays real captured LinkedIn posts against the classifier
// and compares with the pinned baseline (test/fixtures/classifier-baseline.json).
//
// Baseline is generated from server/diagnostics/posts.jsonl by
//   npm run fixtures
// and is gitignored (contains raw post text). If it's missing, this suite skips.
//
// A failure here means a code change altered classification of a real post —
// inspect the diff; if intentional, rerun `npm run fixtures` to re-pin.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const { classifyV2Core } = require('../shared/classifier.js');
const { DEFAULT_KEYWORDS } = require('../shared/keywordConfig.js');

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'classifier-baseline.json'
);

const baseline = fs.existsSync(fixturePath)
  ? JSON.parse(fs.readFileSync(fixturePath, 'utf8'))
  : null;

describe.skipIf(!baseline)('classifier baseline (captured posts replay)', () => {
  it('has baseline posts', () => {
    expect(baseline.length).toBeGreaterThan(0);
  });

  it.each((baseline || []).map((b, i) => [i, b]))(
    'post #%i keeps its pinned classification',
    (i, b) => {
      const info = classifyV2Core(b.text, DEFAULT_KEYWORDS);
      const label = `post #${i} (${b.text.slice(0, 60).replace(/\s+/g, ' ')}…)`;
      expect({ label, match: info.match, confidence: info.confidence ?? null }).toEqual({
        label,
        match: b.expected.match,
        confidence: b.expected.confidence,
      });
      expect(info.devopsHits || []).toEqual(b.expected.devopsHits);
      expect(info.invalidHit || null).toBe(b.expected.invalidHit);
    }
  );
});
