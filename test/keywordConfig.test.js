// Unit tests for resolveKeywords delta merge + legacy snapshot migration.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  DEFAULT_DEVOPS_KEYWORDS,
  DEFAULT_HIRING_SIGNALS,
  DEFAULT_INVALID_KEYWORDS,
  resolveKeywords,
} = require('../shared/keywordConfig.js');

describe('resolveKeywords', () => {
  it('returns pure defaults when storage is empty', () => {
    for (const ck of [undefined, null, {}]) {
      const lists = resolveKeywords(ck);
      expect(lists.devopsKeywords).toEqual(DEFAULT_DEVOPS_KEYWORDS);
      expect(lists.hiringSignals).toEqual(DEFAULT_HIRING_SIGNALS);
      expect(lists.invalidKeywords).toEqual(DEFAULT_INVALID_KEYWORDS);
    }
  });

  it('merges user additions on top of defaults', () => {
    const lists = resolveKeywords({ added: { devopsKeywords: ['pulumi'] } });
    expect(lists.devopsKeywords).toContain('pulumi');
    expect(lists.devopsKeywords).toContain('devops'); // defaults intact
  });

  it('removes disabled defaults', () => {
    const lists = resolveKeywords({ disabled: { devopsKeywords: ['java', 'python'] } });
    expect(lists.devopsKeywords).not.toContain('java');
    expect(lists.devopsKeywords).not.toContain('python');
    expect(lists.devopsKeywords).toContain('devops');
  });

  it('disabled wins over added for the same keyword', () => {
    const lists = resolveKeywords({
      added: { devopsKeywords: ['pulumi'] },
      disabled: { devopsKeywords: ['pulumi'] },
    });
    expect(lists.devopsKeywords).not.toContain('pulumi');
  });

  it('legacy snapshot: stored full arrays become additions, never shadow new defaults', () => {
    // Simulate a pre-delta install that snapshotted a shorter default list + one custom
    const legacy = {
      devopsKeywords: ['devops', 'kubernetes', 'my-custom-tool'],
      hiringSignals: ['hiring'],
      invalidKeywords: [],
    };
    const lists = resolveKeywords(legacy);
    expect(lists.devopsKeywords).toContain('my-custom-tool'); // custom kept
    // keywords added to code after the snapshot still present
    expect(lists.devopsKeywords).toEqual(expect.arrayContaining(DEFAULT_DEVOPS_KEYWORDS));
    expect(lists.hiringSignals).toEqual(expect.arrayContaining(DEFAULT_HIRING_SIGNALS));
  });

  it('deduplicates added keywords already in defaults', () => {
    const lists = resolveKeywords({ added: { devopsKeywords: ['devops'] } });
    expect(lists.devopsKeywords.filter(k => k === 'devops')).toHaveLength(1);
  });
});
