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

    it('handles empty LLM response (ratio uses max(1))', async () => {
      const llm = createMockLLM('');
      const compressor = new Compressor(llm);
      const longText = 'a'.repeat(300);

      const result = await compressor.compress(longText);
      expect(result.ratio).toBe(300); // 300 / max(0, 1) = 300
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
});
