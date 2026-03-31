import { describe, expect, it, vi } from 'vitest';
import { createMessage } from '../core/protocol.js';
import { Executor } from './executor.js';

function createMockLLM(response = 'result') {
  return {
    chat: vi.fn().mockResolvedValue({
      content: response,
      usage: { inputTokens: 50, outputTokens: 30, agent: 'executor', phase: 'execute' },
    }),
    getTokenLog: () => [],
  } as any;
}

describe('Executor', () => {
  it('creates with type executor', () => {
    const llm = createMockLLM();
    const executor = new Executor(llm);
    expect(executor.type).toBe('executor');
    expect(executor.infoLevel).toBe('low');
  });

  it('processes a message and returns response', async () => {
    const llm = createMockLLM('Hello, world!');
    const executor = new Executor(llm);

    const msg = createMessage('planner', 'executor', 'write hello world', '');
    const result = await executor.process(msg, { visibleMessages: [] });

    expect(result.from).toBe('executor');
    expect(result.to).toBe('planner');
    expect(result.payload).toBe('Hello, world!');
    expect(llm.chat).toHaveBeenCalledOnce();
  });

  it('includes visible messages in context', async () => {
    const llm = createMockLLM('done');
    const executor = new Executor(llm);

    const contextMsg = createMessage('scout', 'executor', 'info', 'research result');
    const msg = createMessage('planner', 'executor', 'execute task', '');

    await executor.process(msg, { visibleMessages: [contextMsg] });

    const prompt = llm.chat.mock.calls[0][1] as string;
    expect(prompt).toContain('research result');
  });

  it('includes local scratchpad in prompt', async () => {
    const llm = createMockLLM('fixed');
    const executor = new Executor(llm);

    const msg = createMessage('verifier', 'executor', 'fix issue', 'error details');
    await executor.process(msg, {
      visibleMessages: [],
      localScratchpad: 'Previous attempt failed on line 42',
    });

    const prompt = llm.chat.mock.calls[0][1] as string;
    expect(prompt).toContain('Previous attempt failed on line 42');
  });

  it('respects locale setting', async () => {
    const llm = createMockLLM('result');
    const executor = new Executor(llm);

    executor.setLocale('en');
    const msg = createMessage('planner', 'executor', 'task', '');
    await executor.process(msg, { visibleMessages: [] });

    const prompt = llm.chat.mock.calls[0][1] as string;
    expect(prompt).toContain('Instruction');
    expect(prompt).not.toContain('指令');
  });

  it('respects token budget', async () => {
    const llm = createMockLLM('result');
    const executor = new Executor(llm);
    executor.tokenBudget = 256;

    const msg = createMessage('planner', 'executor', 'task', '');
    await executor.process(msg, { visibleMessages: [] });

    expect(llm.chat).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      'executor',
      'gather',
      256,
    );
  });

  it('limits visible messages to last 5', async () => {
    const llm = createMockLLM('result');
    const executor = new Executor(llm);

    const msgs = Array.from({ length: 10 }, (_, i) =>
      createMessage('scout', 'executor', `info-${i}`, `content-${i}`),
    );
    const msg = createMessage('planner', 'executor', 'task', '');
    await executor.process(msg, { visibleMessages: msgs });

    const prompt = llm.chat.mock.calls[0][1] as string;
    expect(prompt).toContain('content-9');
    expect(prompt).toContain('content-5');
    expect(prompt).not.toContain('content-0');
  });
});
