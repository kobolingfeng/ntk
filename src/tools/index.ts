/**
 * NTK Tools — Tool-calling infrastructure.
 *
 * Provides OpenAI function-calling compatible tool definitions
 * and a secure execution engine for file operations, command
 * execution, and web fetching.
 */

export type { ParsedToolCall, ToolCall, ToolDefinition } from './definitions.js';
export { parseToolCall, TOOL_DEFINITIONS, TOOL_NAMES } from './definitions.js';
export type { ToolResult } from './executor.js';
export { executeTool, executeTools } from './executor.js';
export { runToolLoop } from './loop.js';
