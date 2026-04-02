import { describe, expect, it, vi } from 'vitest';
import { Compressor } from './compressor.js';

// Mock LLMClient
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

describe('Compressor', () => {
  describe('compress() skip threshold', () => {
    it('skips compression for text < 200 chars with minimal level', async () => {
      const llm = createMockLLM();
      const compressor = new Compressor(llm);
      const shortText = 'a'.repeat(199);

      const result = await compressor.compress(shortText, 'minimal');
      expect(result.wasCompressed).toBe(false);
      expect(result.compressed).toBe(shortText);
      expect(result.ratio).toBe(1);
      expect(llm.chat).not.toHaveBeenCalled();
    });

    it('skips compression for text < 200 chars with standard level', async () => {
      const llm = createMockLLM();
      const compressor = new Compressor(llm);
      const shortText = 'a'.repeat(199);

      const result = await compressor.compress(shortText, 'standard');
      expect(result.wasCompressed).toBe(false);
      expect(llm.chat).not.toHaveBeenCalled();
    });

    it('does NOT skip for text < 200 chars with aggressive level', async () => {
      const llm = createMockLLM('aggressively compressed');
      const compressor = new Compressor(llm);
      const shortText = 'a'.repeat(199);

      const result = await compressor.compress(shortText, 'aggressive');
      expect(result.wasCompressed).toBe(true);
      expect(llm.chat).toHaveBeenCalledOnce();
    });

    it('exactly 199 chars → skipped (< 200)', async () => {
      const llm = createMockLLM();
      const compressor = new Compressor(llm);

      const result = await compressor.compress('a'.repeat(199));
      expect(result.wasCompressed).toBe(false);
    });

    it('exactly 200 chars → compressed (≥ 200)', async () => {
      const llm = createMockLLM('short');
      const compressor = new Compressor(llm);

      const result = await compressor.compress('a'.repeat(200));
      expect(result.wasCompressed).toBe(true);
      expect(llm.chat).toHaveBeenCalledOnce();
    });

    it('empty string → skipped', async () => {
      const llm = createMockLLM();
      const compressor = new Compressor(llm);

      const result = await compressor.compress('');
      expect(result.wasCompressed).toBe(false);
      expect(result.originalLength).toBe(0);
    });
  });

  describe('compress() with LLM call', () => {
    it('sets correct fields when compressed', async () => {
      const llm = createMockLLM('summary');
      const compressor = new Compressor(llm);
      const longText = 'a'.repeat(500);

      const result = await compressor.compress(longText, 'standard');
      expect(result.wasCompressed).toBe(true);
      expect(result.originalLength).toBe(500);
      expect(result.compressed).toBe('summary');
      expect(result.compressedLength).toBe(7); // 'summary'.length
      expect(result.ratio).toBeCloseTo(500 / 7, 1);
      expect(result.tokensUsed).toBe(70); // 50 + 20
    });

    it('handles empty LLM response (falls back to pre-filtered text)', async () => {
      const llm = createMockLLM('');
      const compressor = new Compressor(llm);
      const longText = 'a'.repeat(300);

      const result = await compressor.compress(longText);
      // Empty LLM response triggers fallback — compressed should be pre-filtered text, not empty
      expect(result.compressed).toBe(longText);
      expect(result.compressionFailed).toBe(true);
      expect(result.ratio).toBe(1);
    });
  });

  describe('compressAndMerge()', () => {
    it('formats items as [source]: content', async () => {
      const llm = createMockLLM('merged');
      const compressor = new Compressor(llm);

      const items = [
        { source: 'scout', content: 'a'.repeat(100) },
        { source: 'summarizer', content: 'b'.repeat(100) },
      ];

      await compressor.compressAndMerge(items);

      // The formatted text sent to LLM should be "[scout]: aaa...\n[summarizer]: bbb..."
      const chatCall = llm.chat.mock.calls[0];
      const inputText = chatCall[1] as string;
      expect(inputText).toContain('[scout]:');
      expect(inputText).toContain('[summarizer]:');
    });

    it('skips LLM if merged text is < 200 chars', async () => {
      const llm = createMockLLM();
      const compressor = new Compressor(llm);

      const items = [
        { source: 'a', content: 'short' },
        { source: 'b', content: 'also short' },
      ];

      const result = await compressor.compressAndMerge(items);
      expect(result.wasCompressed).toBe(false);
      expect(llm.chat).not.toHaveBeenCalled();
    });
  });

  describe('setLocale()', () => {
    it('can set locale without error', () => {
      const llm = createMockLLM();
      const compressor = new Compressor(llm);
      expect(() => compressor.setLocale('en')).not.toThrow();
      expect(() => compressor.setLocale('zh')).not.toThrow();
    });
  });

  describe('pre-filter integration', () => {
    it('strips ANSI codes before LLM compression', async () => {
      const llm = createMockLLM('clean output');
      const compressor = new Compressor(llm);
      const input = `\x1b[31m${'a'.repeat(300)}\x1b[0m`;

      const result = await compressor.compress(input);
      expect(result.wasCompressed).toBe(true);
      expect(result.preFilterResult).toBeDefined();
      expect(result.preFilterResult!.charsRemoved).toBeGreaterThan(0);

      const chatInput = llm.chat.mock.calls[0][1] as string;
      expect(chatInput).not.toContain('\x1b');
    });

    it('tracks pre-filter stats across calls', async () => {
      const llm = createMockLLM('short');
      const compressor = new Compressor(llm);

      await compressor.compress(`\x1b[32m${'a'.repeat(250)}\x1b[0m`);
      await compressor.compress(`\x1b[31m${'b'.repeat(250)}\x1b[0m`);

      const savings = compressor.getTotalPreFilterSavings();
      expect(savings.callCount).toBe(2);
      expect(savings.totalCharsRemoved).toBeGreaterThan(0);
    });
  });

  describe('tee mechanism', () => {
    it('stores original text when tee is enabled', async () => {
      const llm = createMockLLM('compressed');
      const compressor = new Compressor(llm);
      const original = 'a'.repeat(300);

      const result = await compressor.compress(original, 'standard', 'summarizer', 'gather', { tee: true });
      expect(result.teeId).toBeDefined();

      const retrieved = compressor.teeRetrieve(result.teeId!);
      expect(retrieved).toBe(original);
    });

    it('does not store when tee is not enabled', async () => {
      const llm = createMockLLM('compressed');
      const compressor = new Compressor(llm);

      const result = await compressor.compress('a'.repeat(300));
      expect(result.teeId).toBeUndefined();
      expect(compressor.teeSize).toBe(0);
    });

    it('can discard specific tee entries', async () => {
      const llm = createMockLLM('compressed');
      const compressor = new Compressor(llm);

      const r1 = await compressor.compress('a'.repeat(300), 'standard', 'summarizer', 'gather', { tee: true });
      const r2 = await compressor.compress('b'.repeat(300), 'standard', 'summarizer', 'gather', { tee: true });

      expect(compressor.teeSize).toBe(2);
      compressor.teeDiscard(r1.teeId!);
      expect(compressor.teeSize).toBe(1);
      expect(compressor.teeRetrieve(r1.teeId!)).toBeUndefined();
      expect(compressor.teeRetrieve(r2.teeId!)).toBe('b'.repeat(300));
    });

    it('teeClear removes all entries', async () => {
      const llm = createMockLLM('compressed');
      const compressor = new Compressor(llm);

      await compressor.compress('a'.repeat(300), 'standard', 'summarizer', 'gather', { tee: true });
      await compressor.compress('b'.repeat(300), 'standard', 'summarizer', 'gather', { tee: true });

      expect(compressor.teeSize).toBe(2);
      compressor.teeClear();
      expect(compressor.teeSize).toBe(0);
    });

    it('evicts oldest entry when exceeding MAX_TEE_ENTRIES (20)', async () => {
      const llm = createMockLLM('compressed');
      const compressor = new Compressor(llm);

      const teeIds: string[] = [];
      for (let i = 0; i < 21; i++) {
        const result = await compressor.compress(`${'x'.repeat(300)}_${i}`, 'standard', 'summarizer', 'gather', {
          tee: true,
        });
        teeIds.push(result.teeId!);
      }

      expect(compressor.teeSize).toBe(20);
      expect(compressor.teeRetrieve(teeIds[0])).toBeUndefined();
      expect(compressor.teeRetrieve(teeIds[1])).toBeDefined();
      expect(compressor.teeRetrieve(teeIds[20])).toBeDefined();
    });
  });

  describe('locale affects prompts', () => {
    it('sends different system prompts for zh vs en', async () => {
      const llm = createMockLLM('result');
      const compressor = new Compressor(llm);

      compressor.setLocale('zh');
      await compressor.compress('a'.repeat(300), 'standard');
      const zhPrompt = llm.chat.mock.calls[0][0] as string;

      llm.chat.mockClear();
      compressor.setLocale('en');
      await compressor.compress('b'.repeat(300), 'standard');
      const enPrompt = llm.chat.mock.calls[0][0] as string;

      expect(zhPrompt).not.toBe(enPrompt);
    });
  });
});
