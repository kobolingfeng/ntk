/**
 * Tests for tool definitions and parsing.
 */

import { describe, it, expect } from 'vitest';
import { TOOL_DEFINITIONS, TOOL_NAMES, parseToolCall } from './definitions.js';
import type { ToolCall } from './definitions.js';

describe('TOOL_DEFINITIONS', () => {
  it('has expected tool count', () => {
    expect(TOOL_DEFINITIONS.length).toBe(9);
  });

  it('all tools have valid structure', () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.type).toBe('function');
      expect(tool.function.name).toBeTruthy();
      expect(tool.function.description).toBeTruthy();
      expect(tool.function.parameters.type).toBe('object');
      expect(tool.function.parameters.properties).toBeDefined();
      expect(Array.isArray(tool.function.parameters.required)).toBe(true);
    }
  });

  it('TOOL_NAMES matches definitions', () => {
    expect(TOOL_NAMES.size).toBe(TOOL_DEFINITIONS.length);
    for (const tool of TOOL_DEFINITIONS) {
      expect(TOOL_NAMES.has(tool.function.name)).toBe(true);
    }
  });

  it('expected tools are present', () => {
    const expected = ['read_file', 'write_file', 'edit_file', 'list_directory', 'find_files', 'search_in_files', 'run_command', 'fetch_webpage'];
    for (const name of expected) {
      expect(TOOL_NAMES.has(name)).toBe(true);
    }
  });
});

describe('parseToolCall', () => {
  it('parses valid tool call', () => {
    const tc: ToolCall = {
      id: 'call_123',
      type: 'function',
      function: { name: 'read_file', arguments: '{"path":"test.txt"}' },
    };
    const result = parseToolCall(tc);
    expect(result.id).toBe('call_123');
    expect(result.name).toBe('read_file');
    expect(result.args).toEqual({ path: 'test.txt' });
  });

  it('handles malformed JSON gracefully', () => {
    const tc: ToolCall = {
      id: 'call_456',
      type: 'function',
      function: { name: 'read_file', arguments: 'not json' },
    };
    const result = parseToolCall(tc);
    expect(result.id).toBe('call_456');
    expect(result.name).toBe('read_file');
    expect(result.args).toEqual({});
  });

  it('handles empty arguments', () => {
    const tc: ToolCall = {
      id: 'call_789',
      type: 'function',
      function: { name: 'list_directory', arguments: '{}' },
    };
    const result = parseToolCall(tc);
    expect(result.args).toEqual({});
  });
});
