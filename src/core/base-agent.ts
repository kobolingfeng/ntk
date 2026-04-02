/**
 * BaseAgent — Shared logic for all agents.
 *
 * Implements the common pattern:
 * 1. Receive message
 * 2. Build context (only visible messages)
 * 3. Call LLM with minimal prompt
 * 4. Return response
 */

import type { LLMClient } from './llm.js';
import type { Locale } from './prompts.js';
import type { Agent, AgentContext, AgentType, InfoLevel, Message, Phase } from './protocol.js';
import { AGENT_INFO_LEVEL, createMessage } from './protocol.js';

export abstract class BaseAgent implements Agent {
  type: AgentType;
  infoLevel: InfoLevel;
  protected llm: LLMClient;
  protected currentPhase: Phase = 'gather';
  protected locale: Locale = 'zh';
  /** Optional per-agent token budget override */
  tokenBudget?: number;

  constructor(type: AgentType, llm: LLMClient) {
    this.type = type;
    this.infoLevel = AGENT_INFO_LEVEL[type];
    this.llm = llm;
  }

  setPhase(phase: Phase): void {
    this.currentPhase = phase;
  }

  setLocale(locale: Locale): void {
    this.locale = locale;
  }

  abstract getSystemPrompt(): string;

  async process(message: Message, context: AgentContext): Promise<Message> {
    // Build the user prompt from incoming message + visible context
    const userPrompt = this.buildUserPrompt(message, context);

    // Call LLM with optional token budget
    const { content } = await this.llm.chat(
      this.getSystemPrompt(),
      userPrompt,
      this.type,
      this.currentPhase,
      this.tokenBudget,
    );

    // Create response message
    return createMessage(
      this.type,
      message.from, // Reply to sender
      'respond',
      content,
      message.priority,
      message.id,
    );
  }

  /**
   * Build the user prompt.
   * Key design: context is ALREADY filtered by the router.
   * The agent only sees what it needs to see.
   */
  protected buildUserPrompt(message: Message, context: AgentContext): string {
    const instrLabel = this.locale === 'zh' ? '指令' : 'Instruction';

    // Fast path: no context, no scratchpad — most common case (direct/light depth)
    if (context.visibleMessages.length === 0 && !context.localScratchpad) {
      return message.payload
        ? `${instrLabel}: ${message.action}\n\n${message.payload}`
        : `${instrLabel}: ${message.action}`;
    }

    const parts: string[] = [];

    // Add relevant context (already filtered — this is the magic)
    if (context.visibleMessages.length > 0) {
      const contextLines = context.visibleMessages
        .slice(-5) // Only last 5 messages max — keep context short
        .map((m) => `[${m.from}]: ${m.payload}`)
        .join('\n');
      parts.push(`${this.locale === 'zh' ? '背景' : 'Context'}:\n${contextLines}`);
    }

    // Add local scratchpad if in a local loop
    if (context.localScratchpad) {
      parts.push(`${this.locale === 'zh' ? '局部状态' : 'Local state'}: ${context.localScratchpad}`);
    }

    // Add the actual instruction
    parts.push(`${instrLabel}: ${message.action}`);
    if (message.payload) {
      parts.push(message.payload);
    }

    return parts.join('\n\n');
  }
}
