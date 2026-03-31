import { describe, expect, it, vi } from 'vitest';
import { createMessage } from '../core/protocol.js';
import { Verifier } from './verifier.js';

function createMockLLM(response = '✅ 通过') {
  return {
    chat: vi.fn().mockResolvedValue({
      content: response,
      usage: { inputTokens: 30, outputTokens: 10, agent: 'verifier', phase: 'verify' },
    }),
    getTokenLog: () => [],
  } as any;
}

describe('Verifier', () => {
  it('creates with type verifier', () => {
    const llm = createMockLLM();
    const verifier = new Verifier(llm);
    expect(verifier.type).toBe('verifier');
    expect(verifier.infoLevel).toBe('low');
  });

  it('processes verification request', async () => {
    const llm = createMockLLM('✅ 通过');
    const verifier = new Verifier(llm);

    const msg = createMessage('executor', 'verifier', 'verify output', 'code result here');
    const result = await verifier.process(msg, { visibleMessages: [] });

    expect(result.from).toBe('verifier');
    expect(result.to).toBe('executor');
    expect(result.payload).toContain('✅');
  });

  it('reports failure with details', async () => {
    const llm = createMockLLM('❌ 缺少错误处理');
    const verifier = new Verifier(llm);

    const msg = createMessage('executor', 'verifier', 'verify', 'result');
    const result = await verifier.process(msg, { visibleMessages: [] });

    expect(result.payload).toContain('❌');
  });

  it('uses verifier system prompt', async () => {
    const llm = createMockLLM();
    const verifier = new Verifier(llm);

    const msg = createMessage('executor', 'verifier', 'check', 'output');
    await verifier.process(msg, { visibleMessages: [] });

    const systemPrompt = llm.chat.mock.calls[0][0] as string;
    expect(systemPrompt).toContain('验证');
  });
});
