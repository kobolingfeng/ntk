import { describe, expect, it } from 'vitest';
import { preFilter } from './pre-filter.js';

describe('preFilter', () => {
  describe('ANSI code stripping', () => {
    it('removes ANSI color codes', () => {
      const input = '\x1b[31mERROR\x1b[0m: something failed\n\x1b[32mOK\x1b[0m: passed';
      const result = preFilter(input);
      expect(result.filtered).toBe('ERROR: something failed\nOK: passed');
      expect(result.charsRemoved).toBeGreaterThan(0);
      expect(result.strategies.some((s) => s.name === 'ansi-strip')).toBe(true);
    });

    it('handles text with no ANSI codes', () => {
      const input = 'plain text';
      const result = preFilter(input);
      expect(result.filtered).toBe('plain text');
    });
  });

  describe('progress bar stripping', () => {
    it('removes percentage progress lines', () => {
      const input = 'Starting download\n████░░░░ 50%\nDone';
      const result = preFilter(input);
      expect(result.filtered).not.toContain('50%');
      expect(result.filtered).toContain('Starting download');
      expect(result.filtered).toContain('Done');
    });

    it('removes bracket-style progress bars', () => {
      const input = 'Build\n[======>    ] 60%\nComplete';
      const result = preFilter(input);
      expect(result.filtered).not.toContain('60%');
    });

    it('removes spinner characters', () => {
      const input = 'Working\n  |  \nDone';
      const result = preFilter(input);
      expect(result.filtered).not.toContain('  |  ');
    });
  });

  describe('blank line collapsing', () => {
    it('collapses 3+ blank lines into 2', () => {
      const input = 'line1\n\n\n\n\nline2';
      const result = preFilter(input);
      expect(result.filtered).toBe('line1\n\nline2');
    });

    it('keeps single blank lines', () => {
      const input = 'line1\n\nline2';
      const result = preFilter(input);
      expect(result.filtered).toBe('line1\n\nline2');
    });
  });

  describe('trailing whitespace trimming', () => {
    it('removes trailing spaces from lines', () => {
      const input = 'hello   \nworld  ';
      const result = preFilter(input);
      expect(result.filtered).toBe('hello\nworld');
    });
  });

  describe('duplicate line deduplication', () => {
    it('collapses 3+ repeated lines into count', () => {
      const input = 'header\nrepeated line\nrepeated line\nrepeated line\nrepeated line\nfooter';
      const result = preFilter(input);
      expect(result.filtered).toContain('×4');
      expect(result.filtered).toContain('header');
      expect(result.filtered).toContain('footer');
    });

    it('keeps 2 identical lines as-is', () => {
      const input = 'header\ndup\ndup\nfooter';
      const result = preFilter(input);
      expect(result.filtered).toContain('dup');
      expect(result.filtered).not.toContain('×');
    });
  });

  describe('passed test stripping', () => {
    it('strips checkmark-style passed tests', () => {
      const input = '  ✓ test add\n  ✓ test sub\n  ✗ test div by zero\n  ✓ test mul';
      const result = preFilter(input);
      expect(result.filtered).not.toContain('test add');
      expect(result.filtered).not.toContain('test sub');
      expect(result.filtered).not.toContain('test mul');
      expect(result.filtered).toContain('test div by zero');
      expect(result.filtered).toContain('3 passed tests hidden');
    });

    it('strips PASS lines', () => {
      const input = 'PASS src/a.test.ts\nFAIL src/b.test.ts';
      const result = preFilter(input);
      expect(result.filtered).not.toContain('PASS src/a.test.ts');
      expect(result.filtered).toContain('FAIL src/b.test.ts');
    });

    it('preserves all lines when no test output detected', () => {
      const input = 'regular log\nanother line';
      const result = preFilter(input);
      expect(result.filtered).toBe('regular log\nanother line');
    });
  });

  describe('JSON compaction', () => {
    it('compacts multi-line standalone JSON objects', () => {
      const input = '{\n  "name": "test",\n  "value": 42,\n  "active": true\n}';
      const result = preFilter(input);
      expect(result.filtered).toBe('{"name":"test","value":42,"active":true}');
      expect(result.charsRemoved).toBeGreaterThan(0);
    });

    it('compacts JSON in code blocks', () => {
      const input = 'result:\n```json\n{\n  "id": 1,\n  "name": "foo"\n}\n```\nend';
      const result = preFilter(input);
      expect(result.filtered).toContain('{"id":1,"name":"foo"}');
    });

    it('leaves invalid JSON alone', () => {
      const input = '{\n  broken: not json\n}';
      const result = preFilter(input);
      expect(result.filtered).toContain('broken');
    });

    it('skips single-line JSON', () => {
      const input = '{"already":"compact"}';
      const result = preFilter(input);
      expect(result.filtered).toBe('{"already":"compact"}');
    });
  });

  describe('combined strategies', () => {
    it('applies all strategies and reports stats', () => {
      const input = [
        '\x1b[32m✓ test1\x1b[0m',
        '\x1b[32m✓ test2\x1b[0m',
        '\x1b[31m✗ test3 failed\x1b[0m',
        '',
        '',
        '',
        '',
        '████░░ 75%',
        'result line   ',
      ].join('\n');

      const result = preFilter(input);
      expect(result.charsRemoved).toBeGreaterThan(0);
      expect(result.strategies.length).toBeGreaterThan(0);
      expect(result.filtered).toContain('test3 failed');
      expect(result.filtered).not.toContain('\x1b');
      expect(result.filtered).not.toContain('75%');
      expect(result.filteredLength).toBeLessThan(result.originalLength);
    });

    it('returns zero removal for clean text', () => {
      const input = 'clean text\nno noise here';
      const result = preFilter(input);
      expect(result.charsRemoved).toBe(0);
      expect(result.strategies).toHaveLength(0);
    });

    it('handles empty string', () => {
      const result = preFilter('');
      expect(result.filtered).toBe('');
      expect(result.charsRemoved).toBe(0);
    });
  });
});
