import { describe, expect, it, vi } from 'vitest';
import { createMessage } from '../core/protocol.js';
import { Scout } from './scout.js';

function createMockLLM(response = 'research findings') {
  return {
    chat: vi.fn().mockResolvedValue({
      content: response,
      usage: { inputTokens: 40, outputTokens: 25, agent: 'scout', phase: 'gather' },
    }),
    getTokenLog: () => [],
  } as any;
}

describe('Scout', () => {
  it('creates with type scout', () => {
    const llm = createMockLLM();
    const scout = new Scout(llm);
    expect(scout.type).toBe('scout');
    expect(scout.infoLevel).toBe('low');
  });

  it('processes research request', async () => {
    const llm = createMockLLM('Redis is an in-memory data structure store');
    const scout = new Scout(llm);

    const msg = createMessage('planner', 'scout', 'research Redis', '');
    const result = await scout.process(msg, { visibleMessages: [] });

    expect(result.from).toBe('scout');
    expect(result.to).toBe('planner');
    expect(result.payload).toContain('Redis');
  });

  it('uses scout system prompt', async () => {
    const llm = createMockLLM();
    const scout = new Scout(llm);

    const msg = createMessage('planner', 'scout', 'research topic', '');
    await scout.process(msg, { visibleMessages: [] });

    const systemPrompt = llm.chat.mock.calls[0][0] as string;
    expect(systemPrompt.length).toBeGreaterThan(10);
  });

  it('respects phase setting', async () => {
    const llm = createMockLLM();
    const scout = new Scout(llm);
    scout.setPhase('gather');

    const msg = createMessage('planner', 'scout', 'research', '');
    await scout.process(msg, { visibleMessages: [] });

    expect(llm.chat).toHaveBeenCalledWith(expect.any(String), expect.any(String), 'scout', 'gather', undefined);
  });
});
