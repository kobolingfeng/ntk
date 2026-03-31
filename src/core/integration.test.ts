import { describe, expect, it, vi } from 'vitest';
import { Compressor } from './compressor.js';

function createMockLLM(returnContent: string = 'compressed') {
  return {
    chat: vi.fn().mockResolvedValue({
      content: returnContent,
      usage: { inputTokens: 50, outputTokens: 20, agent: 'summarizer', phase: 'gather' },
    }),
    getTokenLog: () => [],
    getConfig: () => ({ provider: 'openai', model: 'test', apiKey: 'test' }),
  } as any;
}

describe('Integration: preFilter + Compressor + Tee', () => {
  it('pre-filters ANSI codes before sending to LLM, tracks savings', async () => {
    const llm = createMockLLM('clean summary');
    const compressor = new Compressor(llm);

    const noisyInput = [
      '\x1b[32m✓ test add\x1b[0m',
      '\x1b[32m✓ test subtract\x1b[0m',
      '\x1b[32m✓ test multiply\x1b[0m',
      '\x1b[31m✗ test divide by zero — expected error but got result\x1b[0m',
      '',
      '',
      '',
      '',
      '════════════════════ 75%',
      'Building output...',
      'result line',
      'result line',
      'result line',
      'result line',
      'final summary of the test run with a lot of important details that need to be compressed   ',
    ].join('\n');

    const result = await compressor.compress(noisyInput, 'standard', 'summarizer', 'gather', { tee: true });

    // Pre-filter should have stripped ANSI, progress, blank lines, passed tests, etc.
    expect(result.preFilterResult).toBeDefined();
    expect(result.preFilterResult!.charsRemoved).toBeGreaterThan(0);
    expect(result.preFilterResult!.strategies.length).toBeGreaterThan(0);

    // LLM should have received cleaned text (no ANSI)
    const llmInput = llm.chat.mock.calls[0][1] as string;
    expect(llmInput).not.toContain('\x1b');
    expect(llmInput).not.toContain('test add');
    expect(llmInput).toContain('test divide by zero');

    // Tee should have stored the ORIGINAL (noisy) text
    expect(result.teeId).toBeDefined();
    const original = compressor.teeRetrieve(result.teeId!);
    expect(original).toBe(noisyInput);
    expect(original).toContain('\x1b[32m');

    // Stats should be tracked
    const savings = compressor.getTotalPreFilterSavings();
    expect(savings.callCount).toBe(1);
    expect(savings.totalCharsRemoved).toBeGreaterThan(0);
  });

  it('tee recovery after compression — original is retrievable', async () => {
    const llm = createMockLLM('very short');
    const compressor = new Compressor(llm);
    const lines = Array.from({ length: 20 }, (_, i) => `Important detail line ${i + 1} with unique content`);
    const longContent = lines.join('\n');

    const result = await compressor.compress(longContent, 'standard', 'summarizer', 'gather', { tee: true });

    expect(result.compressed).toBe('very short');
    expect(result.ratio).toBeGreaterThan(10);

    const original = compressor.teeRetrieve(result.teeId!);
    expect(original).toBe(longContent);
    expect(original!.length).toBeGreaterThan(result.compressed.length);
  });

  it('tee cleanup on success clears all entries', async () => {
    const llm = createMockLLM('compressed');
    const compressor = new Compressor(llm);

    await compressor.compress('a'.repeat(300), 'standard', 'summarizer', 'gather', { tee: true });
    await compressor.compress('b'.repeat(300), 'standard', 'summarizer', 'gather', { tee: true });

    expect(compressor.teeSize).toBe(2);
    compressor.teeClear();
    expect(compressor.teeSize).toBe(0);
  });

  it('pre-filter reduces chars sent to LLM — measures actual savings', async () => {
    const llm = createMockLLM('summary');
    const compressor = new Compressor(llm);

    const bloatedInput = [
      `\x1b[32m${'ok'.repeat(50)}\x1b[0m`,
      '█████░░ 45%',
      'same line',
      'same line',
      'same line',
      'same line',
      '',
      '',
      '',
      '',
      '',
      'actual content here that needs compression and is quite long to trigger the LLM call path in the compressor',
    ].join('\n');

    const result = await compressor.compress(bloatedInput);
    const pf = result.preFilterResult!;

    expect(pf.charsRemoved).toBeGreaterThan(0);
    const reductionPct = (pf.charsRemoved / pf.originalLength) * 100;
    expect(reductionPct).toBeGreaterThan(5);

    const llmInput = llm.chat.mock.calls[0][1] as string;
    expect(llmInput.length).toBeLessThan(bloatedInput.length);
  });
});
