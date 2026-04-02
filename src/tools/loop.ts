/**
 * Tool Loop — Multi-round tool-calling orchestration.
 *
 * Coordinates LLM ↔ tool execution in a loop:
 * 1. Send user request + tool definitions to LLM
 * 2. If LLM returns tool_calls → execute tools → append results → repeat
 * 3. If LLM returns text content → done
 *
 * Ported from ko-assistant's run_conversation_turn, optimized for NTK.
 */

import type { LLMClient } from '../core/llm.js';
import type { AgentType, Phase } from '../core/protocol.js';
import type { ToolDefinition } from './definitions.js';
import { TOOL_DEFINITIONS } from './definitions.js';
import { executeTools } from './executor.js';

/** Configuration for the tool loop */
export interface ToolLoopConfig {
  /** Maximum number of tool-calling rounds (default: 8) */
  maxRounds?: number;
  /** Working directory for file/command tools */
  cwd?: string;
  /** Tool definitions to expose (default: all built-in tools) */
  tools?: ToolDefinition[];
  /** Callback for streaming text tokens */
  onToken?: (token: string) => void;
  /** Callback for tool execution events */
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  /** Callback for tool results */
  onToolResult?: (name: string, result: string) => void;
  /** Agent type for token tracking */
  agent?: AgentType;
  /** Phase for token tracking */
  phase?: Phase;
}

/** Result of a tool loop execution */
export interface ToolLoopResult {
  /** Final text response from LLM */
  content: string;
  /** Total tool calls executed */
  toolCallCount: number;
  /** Number of conversation rounds */
  rounds: number;
  /** Whether the loop completed normally (vs hitting max rounds) */
  completed: boolean;
}

/**
 * Run a multi-round tool-calling loop.
 *
 * @param llm - LLM client with tool-calling support
 * @param systemPrompt - System prompt for the LLM
 * @param userMessage - Initial user message
 * @param config - Loop configuration
 */
export async function runToolLoop(
  llm: LLMClient,
  systemPrompt: string,
  userMessage: string,
  config: ToolLoopConfig = {},
): Promise<ToolLoopResult> {
  const {
    maxRounds = 8,
    cwd = process.cwd(),
    tools = TOOL_DEFINITIONS,
    onToken,
    onToolCall,
    onToolResult,
    agent = 'executor',
    phase = 'execute',
  } = config;

  // Build conversation messages
  const messages: Array<{ role: string; content?: string; tool_calls?: unknown[]; tool_call_id?: string }> = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  messages.push({ role: 'user', content: userMessage });

  let totalToolCalls = 0;
  let round = 0;
  // Pre-serialize tools once — avoids re-serializing the tools array on every round
  const toolsJson = JSON.stringify(tools);

  for (round = 0; round < maxRounds; round++) {
    const result = await llm.chatWithTools(messages, tools, agent, phase, onToken, toolsJson);

    if (result.toolCalls && result.toolCalls.length > 0) {
      // LLM wants to call tools
      messages.push({
        role: 'assistant',
        tool_calls: result.toolCalls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        })),
      });

      // Parse and execute
      const parsed = result.toolCalls.map(tc => {
        let args: Record<string, unknown>;
        try { args = JSON.parse(tc.arguments); } catch { args = {}; }
        onToolCall?.(tc.name, args);
        return { id: tc.id, name: tc.name, args };
      });

      const results = await executeTools(parsed, cwd);
      totalToolCalls += results.length;

      // Append tool results to conversation
      for (const r of results) {
        onToolResult?.(r.name, r.content);
        // Truncate large results to keep context manageable
        const truncated = r.content.length > 6000
          ? r.content.slice(0, 6000) + '\n...(结果已截断)'
          : r.content;
        messages.push({
          role: 'tool',
          tool_call_id: r.toolCallId,
          content: truncated,
        });
      }
    } else {
      // LLM returned final text response
      return {
        content: result.content ?? '',
        toolCallCount: totalToolCalls,
        rounds: round + 1,
        completed: true,
      };
    }
  }

  // Hit max rounds — return last content or a warning
  return {
    content: `[已达到工具调用上限 (${maxRounds}轮)]`,
    toolCallCount: totalToolCalls,
    rounds: maxRounds,
    completed: false,
  };
}
