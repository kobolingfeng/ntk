/**
 * Tool Definitions — OpenAI function-calling format tool declarations.
 *
 * Ported from ko-assistant's Python tool system to TypeScript.
 * Only tools that make sense for a Node.js environment are included.
 */

/** OpenAI function-calling tool definition */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, ToolParameter>;
      required: string[];
    };
  };
}

interface ToolParameter {
  type: string;
  description?: string;
  default?: unknown;
}

/** Tool call from LLM response */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/** Parsed tool call with deserialized arguments */
export interface ParsedToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

function def(name: string, description: string, props: Record<string, ToolParameter>, required: string[]): ToolDefinition {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: { type: 'object', properties: props, required },
    },
  };
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  def('read_file', '读取文件内容', {
    path: { type: 'string', description: '文件路径' },
  }, ['path']),

  def('write_file', '写入文件(自动创建目录)', {
    path: { type: 'string', description: '文件路径' },
    content: { type: 'string', description: '文件内容' },
  }, ['path', 'content']),

  def('append_file', '向文件末尾追加内容(自动创建文件和目录)', {
    path: { type: 'string', description: '文件路径' },
    content: { type: 'string', description: '要追加的内容' },
  }, ['path', 'content']),

  def('edit_file', '精确替换文件中的文本', {
    path: { type: 'string', description: '文件路径' },
    old_text: { type: 'string', description: '要替换的原文' },
    new_text: { type: 'string', description: '替换后的文本' },
  }, ['path', 'old_text', 'new_text']),

  def('list_directory', '列出目录内容', {
    path: { type: 'string', description: '目录路径', default: '.' },
  }, []),

  def('find_files', '按文件名模式搜索(glob通配符)', {
    pattern: { type: 'string', description: 'glob模式 (如 *.ts, src/**/*.js)' },
    path: { type: 'string', description: '搜索起始目录', default: '.' },
  }, ['pattern']),

  def('search_in_files', '在文件内容中搜索文本或正则', {
    pattern: { type: 'string', description: '搜索模式' },
    path: { type: 'string', description: '搜索起始目录', default: '.' },
    file_glob: { type: 'string', description: '文件过滤(如 *.ts)', default: '*' },
  }, ['pattern']),

  def('run_command', '执行系统终端命令', {
    command: { type: 'string', description: '要执行的命令' },
    timeout: { type: 'integer', description: '超时秒数', default: 120 },
  }, ['command']),

  def('fetch_webpage', '获取URL网页内容(纯文本,超max_length自动截断)', {
    url: { type: 'string', description: '网页URL' },
    max_length: { type: 'integer', description: '最大返回字符数(超出截断)', default: 8000 },
  }, ['url']),
];

/** Tool name set for quick validation */
export const TOOL_NAMES = new Set(TOOL_DEFINITIONS.map(t => t.function.name));

/** Parse a tool call from LLM response into a usable format */
export function parseToolCall(tc: ToolCall): ParsedToolCall {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(tc.function.arguments);
  } catch {
    args = {};
  }
  return { id: tc.id, name: tc.function.name, args };
}
