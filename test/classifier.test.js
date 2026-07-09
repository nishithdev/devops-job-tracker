// Unit tests for classifyV2Core (shared/classifier.js) with default keywords.
// Match rule: ≥1 devops keyword AND confidence ≥ 40.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { classifyV2Core, v2SplitSentences, v2IsNegated } = require('../shared/classifier.js');
const { DEFAULT_KEYWORDS } = require('../shared/keywordConfig.js');

const classify = (text, opts) => classifyV2Core(text, DEFAULT_KEYWORDS, opts);

describe('classifyV2Core: matching', () => {
  it('matches a clear hiring post with devops keywords', () => {
    const info = classify(
      'We are hiring a DevOps Engineer! Requirements: 5+ years of experience with Kubernetes and Terraform. Apply now or send your resume to jobs@acme.com. Fully remote.'
    );
    expect(info.match).toBe(true);
    expect(info.confidence).toBeGreaterThanOrEqual(40);
    expect(info.devopsHits).toContain('devops');
    expect(info.devopsHits).toContain('kubernetes');
    expect(info.devopsHits).toContain('terraform');
    expect(info.hiringHits.length).toBeGreaterThan(0);
  });

  it('skips text under 20 chars', () => {
    expect(classify('hiring devops').match).toBe(false);
    expect(classify('').match).toBe(false);
    expect(classify(null).match).toBe(false);
  });

  it('skips a post with zero devops keywords even with strong hiring signals', () => {
    const info = classify(
      'We are hiring a Marketing Manager! Apply now, send your resume. 5+ years of experience required. Fully remote. $90k/yr.'
    );
    expect(info.match).toBe(false);
    expect(info.devopsHits).toEqual([]);
  });

  it('skips a low-confidence casual mention of a keyword', () => {
    const info = classify(
      'Had a great chat about docker containers over coffee this morning with an old friend.'
    );
    expect(info.match).toBe(false);
    expect(info.confidence).toBeLessThan(40);
  });
});

describe('classifyV2Core: word boundaries (short keywords)', () => {
  it('does not match "sre" inside "ensure" / "insure"', () => {
    const info = classify(
      'We want to ensure quality and insure our processes are solid across teams. Looking for great people.'
    );
    expect(info.devopsHits).not.toContain('sre');
  });

  it('does not match "aks"/"eks" inside "tasks"/"weeks"', () => {
    const info = classify(
      'Daily tasks take several weeks to complete when the team speaks about planning.'
    );
    expect(info.devopsHits).not.toContain('aks');
    expect(info.devopsHits).not.toContain('eks');
  });

  it('matches standalone "aws" and "k8s"', () => {
    const info = classify(
      'Hiring now: engineer with AWS and k8s experience with 4+ years of experience. Apply here, send resume. Remote role.'
    );
    expect(info.devopsHits).toContain('aws');
    expect(info.devopsHits).toContain('k8s');
    expect(info.match).toBe(true);
  });
});

describe('classifyV2Core: negation', () => {
  it('penalizes negated keywords instead of scoring them', () => {
    const info = classify(
      'We are not looking for devops folks right now, and no kubernetes experience is needed here.'
    );
    expect(info.match).toBe(false);
    expect(info.v2signals.some(s => s.startsWith('negated'))).toBe(true);
  });

  it('v2IsNegated only inspects the window before the hit', () => {
    const sentence = 'we need devops engineers but not designers';
    expect(v2IsNegated(sentence, sentence.indexOf('devops'))).toBe(false);
    const neg = 'we are not hiring devops engineers';
    expect(v2IsNegated(neg, neg.indexOf('devops'))).toBe(true);
  });
});

describe('classifyV2Core: invalid keywords', () => {
  it('applies -25 soft penalty, can flip match to skip', () => {
    const base =
      'Hiring DevOps Engineer, kubernetes required. Apply now, send your resume.';
    const withInvalid = base + ' Note: no c2c candidates.';
    const clean = classify(base);
    const penalized = classify(withInvalid);
    expect(clean.match).toBe(true);
    expect(penalized.invalidHit).toBe('no c2c');
    expect(penalized.confidence).toBeLessThan(clean.confidence);
  });

  it('reports invalidHit even when confidence stays high enough to match', () => {
    const info = classify(
      'We are hiring a DevOps Engineer! Requirements: 6+ years of experience with terraform, kubernetes, aws. Apply now — send your resume to hr@corp.io. $150k/yr. Fully remote. Bootcamp grads welcome.'
    );
    expect(info.invalidHit).toBe('bootcamp');
    expect(info.v2signals).toContain('invalid keyword "bootcamp" -25');
  });
});

describe('classifyV2Core: structural signals', () => {
  it('scores years-of-exp, salary, email, apply, bullets, remote', () => {
    const text = [
      'We are hiring a Platform Engineer.',
      '• 5+ years of experience with terraform',
      '• kubernetes and aws',
      '• ci/cd pipelines',
      'Salary: $140k/yr. Fully remote.',
      'Apply now: send your resume to talent@corp.io',
    ].join('\n');
    const info = classify(text);
    const signals = info.v2signals.join(' | ');
    expect(signals).toContain('years-of-exp pattern +10');
    expect(signals).toContain('salary/rate +8');
    expect(signals).toContain('email present +12');
    expect(signals).toContain('apply instruction +12');
    expect(signals).toContain('structured bullets (3) +8');
    expect(signals).toContain('remote/hybrid +4');
    expect(info.match).toBe(true);
  });

  it('email bonus uses bodyText when provided (ignores emails in comments)', () => {
    const text =
      'We are hiring a DevOps Engineer with kubernetes experience. Contact me at recruiter@corp.io today.';
    const withEmail = classify(text);
    const withoutEmail = classify(text, { bodyText: 'no email in body here' });
    expect(withEmail.v2signals).toContain('email present +12');
    expect(withoutEmail.v2signals).not.toContain('email present +12');
  });

  it('scores a devops keyword only once per sentence (anti keyword-stuffing)', () => {
    const info = classify(
      'devops devops devops kubernetes terraform aws docker all mentioned casually in one line here'
    );
    // one sentence → one keyword score, all hits still recorded
    const scored = info.v2signals.filter(s => /^"/.test(s));
    expect(scored.length).toBe(1);
    expect(info.devopsHits.length).toBeGreaterThan(3);
  });
});

describe('classifyV2Core: context buckets', () => {
  it('hiring context scores higher than company-brag context', () => {
    const hiring = classify(
      'We are hiring and looking for kubernetes experts to join our team right away this week.'
    );
    const company = classify(
      'Our stack: we use kubernetes for everything in our infrastructure, and we rely on it daily.'
    );
    expect(hiring.confidence).toBeGreaterThan(company.confidence);
  });
});

describe('v2SplitSentences', () => {
  it('splits on punctuation, newlines, bullets and drops short fragments', () => {
    const parts = v2SplitSentences('first sentence here. second one!\n• bullet item text\nok');
    expect(parts).toContain('first sentence here');
    expect(parts).toContain('second one');
    expect(parts.some(p => p.includes('bullet item text'))).toBe(true);
    expect(parts).not.toContain('ok');
  });
});
