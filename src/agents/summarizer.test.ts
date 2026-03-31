import { describe, expect, it, vi } from 'vitest';
import { createMessage } from '../core/protocol.js';
import { Summarizer } from './summarizer.js';

function createMockLLM(response = 'summary') {
  return {
    chat: vi.fn().mockResolvedValue({
      content: response,
      usage: { inputTokens: 60, outputTokens: 20, agent: 'summarizer', phase: 'gather' },
    }),
    getTokenLog: () => [],
  } as any;
}

describe('Summarizer', () => {
  it('creates with type summarizer', () => {
    const llm = createMockLLM();
    const summarizer = new Summarizer(llm);
    expect(summarizer.type).toBe('summarizer');
    expect(summarizer.infoLevel).toBe('low');
  });

  it('processes summarization request', async () => {
    const llm = createMockLLM('key points: 1) Redis is fast 2) supports multiple data structures');
    const summarizer = new Summarizer(llm);

    const msg = createMessage('planner', 'summarizer', 'summarize', 'long document text...');
    const result = await summarizer.process(msg, { visibleMessages: [] });

    expect(result.from).toBe('summarizer');
    expect(result.to).toBe('planner');
    expect(result.payload).toContain('Redis');
  });

  it('uses summarizer system prompt', async () => {
    const llm = createMockLLM();
    const summarizer = new Summarizer(llm);

    const msg = createMessage('planner', 'summarizer', 'summarize', 'content');
    await summarizer.process(msg, { visibleMessages: [] });

    const systemPrompt = llm.chat.mock.calls[0][0] as string;
    expect(systemPrompt.length).toBeGreaterThan(10);
  });
});
