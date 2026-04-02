/**
 * Tool Executor — Execute tool calls with timeout protection.
 *
 * Ported from ko-assistant's Python tool system.
 * All tools run in the current Node.js process (no subprocess overhead).
 */

import { exec } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type { ParsedToolCall } from './definitions.js';
import { TOOL_NAMES } from './definitions.js';

/** Tool execution result */
export interface ToolResult {
  toolCallId: string;
  name: string;
  content: string;
  success: boolean;
}

/** Per-tool timeout limits (ms) */
const TOOL_TIMEOUTS: Record<string, number> = {
  run_command: 125_000,
  fetch_webpage: 20_000,
};
const DEFAULT_TIMEOUT = 15_000;

/** Maximum result length (chars) before truncation */
const MAX_RESULT_LENGTH = 12_000;

// ─── File Read Cache ───────────────────────────────
// Avoids redundant disk I/O when LLM reads the same file across tool rounds.
// Inspired by Claude Code's FileReadCache with mtime-based invalidation.

interface CachedFile { content: string; mtimeMs: number }
const fileReadCache = new Map<string, CachedFile>();
const FILE_CACHE_MAX = 200;

function cachedReadFile(path: string): string {
  const stat = statSync(path);
  const cached = fileReadCache.get(path);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    // LRU: re-insert to mark as most recently used
    fileReadCache.delete(path);
    fileReadCache.set(path, cached);
    return cached.content;
  }
  const content = readFileSync(path, 'utf-8');
  fileReadCache.set(path, { content, mtimeMs: stat.mtimeMs });
  // LRU eviction: drop least recently used (first in Map order)
  if (fileReadCache.size > FILE_CACHE_MAX) {
    fileReadCache.delete(fileReadCache.keys().next().value!);
  }
  return content;
}

function invalidateFileCache(path: string): void {
  fileReadCache.delete(path);
}

// ─── Security Helpers ──────────────────────────────

/** Resolve and validate a file path — prevent directory traversal */
function safePath(path: string, cwd: string): string {
  const resolved = resolve(cwd, path);
  // Block traversal outside cwd — use sep suffix to prevent prefix confusion
  // e.g. cwd="/home/user" must not match "/home/username/secret"
  if (resolved !== cwd && !resolved.startsWith(cwd + sep)) {
    throw new Error(`路径越界: ${path} (不允许访问 ${cwd} 之外的文件)`);
  }
  return resolved;
}

/** Blocked commands for security */
const BLOCKED_COMMANDS = /^\s*(rm\s+-rf\s+\/|del\s+\/s\s+\/q\s+[A-Z]:\\|format\s+[A-Z]:|mkfs|dd\s+if=|:(){ :|(?:curl|wget)\s+.*\|\s*(?:sh|bash|python3?|node|perl|ruby|eval)|sudo\s|>\s*\/dev\/|eval\s+["'`$(])/i;

// ─── Tool Implementations ──────────────────────────

function toolReadFile(args: Record<string, unknown>, cwd: string): string {
  const path = safePath(String(args.path ?? ''), cwd);
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch {
    return `文件不存在: ${args.path}`;
  }
  if (stat.isDirectory()) return `${args.path} 是目录，请使用 list_directory`;
  if (stat.size > 500_000) return `文件过大 (${(stat.size / 1024).toFixed(0)}KB)，请指定具体内容查找`;
  return cachedReadFile(path);
}

function toolWriteFile(args: Record<string, unknown>, cwd: string): string {
  const path = safePath(String(args.path ?? ''), cwd);
  const content = String(args.content ?? '');
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, content, 'utf-8');
  invalidateFileCache(path);
  return `已写入 ${args.path} (${content.length} 字符)`;
}

function toolAppendFile(args: Record<string, unknown>, cwd: string): string {
  const path = safePath(String(args.path ?? ''), cwd);
  const content = String(args.content ?? '');
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(path, content, 'utf-8');
  invalidateFileCache(path);
  return `已追加到 ${args.path} (${content.length} 字符)`;
}

function toolEditFile(args: Record<string, unknown>, cwd: string): string {
  const path = safePath(String(args.path ?? ''), cwd);
  if (!existsSync(path)) return `文件不存在: ${args.path}`;
  const content = cachedReadFile(path);
  const oldText = String(args.old_text ?? '');
  const newText = String(args.new_text ?? '');
  if (!oldText) return '错误: old_text 不能为空';
  const idx = content.indexOf(oldText);
  if (idx < 0) return '错误: 未找到要替换的文本';
  const secondIdx = content.indexOf(oldText, idx + oldText.length);
  if (secondIdx >= 0) return '错误: old_text 匹配了多处，请提供更精确的上下文';
  const updated = content.slice(0, idx) + newText + content.slice(idx + oldText.length);
  writeFileSync(path, updated, 'utf-8');
  invalidateFileCache(path);
  return `已替换 ${args.path} 中的文本 (${oldText.length}→${newText.length} 字符)`;
}

function toolListDirectory(args: Record<string, unknown>, cwd: string): string {
  const path = safePath(String(args.path ?? '.'), cwd);
  if (!existsSync(path)) return `目录不存在: ${args.path}`;
  const entries = readdirSync(path, { withFileTypes: true });
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.env') continue;
    const suffix = entry.isDirectory() ? '/' : '';
    lines.push(`${entry.name}${suffix}`);
  }
  return lines.join('\n') || '(空目录)';
}

function toolFindFiles(args: Record<string, unknown>, cwd: string): string {
  const pattern = String(args.pattern ?? '');
  const searchPath = safePath(String(args.path ?? '.'), cwd);
  if (!existsSync(searchPath)) return `目录不存在: ${args.path}`;
  if (!pattern) return '错误: pattern 不能为空';

  // Simple glob matching using recursive directory walk
  const results: string[] = [];
  const globRegex = cachedGlobToRegex(pattern);

  function walk(dir: string, depth: number): void {
    if (depth > 8 || results.length >= 100) return;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const fullPath = join(dir, entry.name);
        const relPath = fullPath.slice(searchPath.length + 1).replace(/\\/g, '/');
        if (entry.isFile() && globRegex.test(relPath || entry.name)) {
          results.push(relPath || entry.name);
        }
        if (entry.isDirectory()) walk(fullPath, depth + 1);
      }
    } catch { /* permission denied etc. */ }
  }

  walk(searchPath, 0);
  return results.length > 0 ? results.join('\n') : `未找到匹配 "${pattern}" 的文件`;
}

function toolSearchInFiles(args: Record<string, unknown>, cwd: string): string {
  const pattern = String(args.pattern ?? '');
  const searchPath = safePath(String(args.path ?? '.'), cwd);
  const fileGlob = String(args.file_glob ?? '*');
  if (!pattern) return '错误: pattern 不能为空';
  if (!existsSync(searchPath)) return `目录不存在: ${args.path}`;

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, 'im');
  } catch {
    regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'im');
  }

  const fileFilter = cachedGlobToRegex(fileGlob);
  const results: string[] = [];

  function walk(dir: string, depth: number): void {
    if (depth > 8 || results.length >= 50) return;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const fullPath = join(dir, entry.name);
        if (entry.isFile() && fileFilter.test(entry.name)) {
          try {
            const stat = statSync(fullPath);
            if (stat.size > 200_000) continue;
            const content = cachedReadFile(fullPath);
            const relPath = fullPath.slice(cwd.length + 1).replace(/\\/g, '/');
            // Line-by-line scan without split() allocation
            let lineStart = 0;
            let lineNum = 1;
            for (let i = 0; i <= content.length; i++) {
              if (i === content.length || content.charCodeAt(i) === 10) {
                const line = content.substring(lineStart, i);
                if (regex.test(line)) {
                  results.push(`${relPath}:${lineNum}: ${line.trim().slice(0, 120)}`);
                  if (results.length >= 50) return;
                }
                lineStart = i + 1;
                lineNum++;
              }
            }
          } catch { /* binary file or read error */ }
        }
        if (entry.isDirectory()) walk(fullPath, depth + 1);
      }
    } catch { /* permission denied */ }
  }

  walk(searchPath, 0);
  return results.length > 0 ? results.join('\n') : `未找到匹配 "${pattern}" 的内容`;
}

async function toolRunCommand(args: Record<string, unknown>, cwd: string): Promise<string> {
  const command = String(args.command ?? '');
  const rawTimeout = Number(args.timeout ?? 120);
  const timeout = Math.min(Number.isFinite(rawTimeout) ? rawTimeout * 1000 : 120_000, 120_000);
  if (!command) return '错误: command 不能为空';
  if (BLOCKED_COMMANDS.test(command)) return `安全拦截: 禁止执行危险命令`;

  return new Promise<string>((resolve) => {
    const child = exec(command, {
      cwd,
      timeout,
      maxBuffer: 1024 * 1024,
      encoding: 'utf-8',
    }, (err, stdout, stderr) => {
      if (!err) {
        resolve(stdout || '(命令执行成功，无输出)');
        return;
      }
      const out = String(stdout ?? '').trim();
      const errOut = String(stderr ?? '').trim();
      const code = (err as NodeJS.ErrnoException & { code?: number | string }).code;
      if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        resolve(`${out}\n...(输出已截断)`);
        return;
      }
      resolve(`退出码: ${(err as { status?: number }).status ?? 1}\n${out}\n${errOut}`.trim());
    });
    // Kill tree on timeout — exec handles this via timeout option
    child.on('error', () => { /* exec callback handles errors */ });
  });
}

async function toolFetchWebpage(args: Record<string, unknown>): Promise<string> {
  const url = String(args.url ?? '');
  const rawMaxLen = Number(args.max_length ?? 8000);
  const maxLength = Math.min(Number.isFinite(rawMaxLen) ? rawMaxLen : 8000, 30_000);
  if (!url || !url.startsWith('http')) return '错误: 无效URL (必须以 http:// 或 https:// 开头)';

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NTK/1.0)',
        Accept: 'text/html,application/xhtml+xml,text/plain',
      },
      signal: AbortSignal.timeout(TOOL_TIMEOUTS.fetch_webpage ?? DEFAULT_TIMEOUT),
    });

    if (!response.ok) return `HTTP ${response.status}: ${response.statusText}`;

    const contentType = response.headers.get('content-type') ?? '';
    const text = await response.text();

    if (contentType.includes('text/html')) {
      // Simple HTML → text extraction (no dependency on cheerio/jsdom)
      return htmlToText(text, maxLength);
    }
    return text.slice(0, maxLength);
  } catch (err) {
    return `获取失败: ${err instanceof Error ? err.message : err}`;
  }
}

// ─── HTML to Text (lightweight, no deps) ───────────

const RE_SCRIPT = /<script[\s\S]*?<\/script>/gi;
const RE_STYLE = /<style[\s\S]*?<\/style>/gi;
const RE_HEAD = /<head[\s\S]*?<\/head>/gi;
const RE_BR = /<br\s*\/?>/gi;
const RE_BLOCK_CLOSE = /<\/(p|div|h[1-6]|li|tr)>/gi;
const RE_BLOCK_OPEN = /<(p|div|h[1-6])[\s>]/gi;
const RE_TAGS = /<[^>]+>/g;
const RE_SPACES = /[ \t]+/g;
const RE_MULTILINE = /\n{3,}/g;
const RE_ENTITY = /&(?:amp|lt|gt|quot|nbsp|#39);/g;
const HTML_ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };

function htmlToText(html: string, maxLength: number): string {
  // Pre-truncate large HTML — avoid running 8 regex passes over megabytes
  // Use 3x multiplier to account for tag overhead
  let text = html.length > maxLength * 3 ? html.slice(0, maxLength * 3) : html;
  text = text.replace(RE_SCRIPT, '');
  text = text.replace(RE_STYLE, '');
  text = text.replace(RE_HEAD, '');
  text = text.replace(RE_BR, '\n');
  text = text.replace(RE_BLOCK_CLOSE, '\n');
  text = text.replace(RE_BLOCK_OPEN, '\n');
  text = text.replace(RE_TAGS, '');
  // Decode common entities — single pass with Map lookup
  text = text.replace(RE_ENTITY, m => HTML_ENTITIES[m] ?? m);
  text = text.replace(RE_SPACES, ' ');
  text = text.replace(RE_MULTILINE, '\n\n');
  text = text.trim();
  return text.slice(0, maxLength);
}

// ─── Glob to Regex ─────────────────────────────────

/** Small cache for glob→regex conversion (avoids recompilation for alternating patterns) */
const globCache = new Map<string, RegExp>();
const GLOB_CACHE_MAX = 16;

function cachedGlobToRegex(glob: string): RegExp {
  let re = globCache.get(glob);
  if (re) return re;
  re = globToRegex(glob);
  if (globCache.size >= GLOB_CACHE_MAX) {
    globCache.delete(globCache.keys().next().value!);
  }
  globCache.set(glob, re);
  return re;
}

function globToRegex(glob: string): RegExp {
  // Handle {a,b,c} alternation before escaping — use sentinels to protect regex syntax
  let seq = 0;
  const alternations: string[] = [];
  const expanded = glob.replace(/\{([^}]+)\}/g, (_m, inner: string) => {
    const id = `§ALT${seq++}§`;
    alternations.push(`(${inner.split(',').map(s => s.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('|')})`);
    return id;
  });
  let re = expanded
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '§DOUBLESTAR§')
    .replace(/\*/g, '[^/]*')
    .replace(/§DOUBLESTAR§/g, '.*')
    .replace(/\?/g, '.');
  // Restore alternation groups
  for (let i = 0; i < alternations.length; i++) {
    re = re.replace(`§ALT${i}§`, alternations[i]);
  }
  return new RegExp(`^${re}$`, 'i');
}

// ─── Dispatch ──────────────────────────────────────

/** Unified tool dispatch map — sync tools are wrapped to return Promise */
type ToolFn = (args: Record<string, unknown>, cwd: string) => string | Promise<string>;
const TOOL_MAP: Record<string, ToolFn> = {
  read_file: toolReadFile,
  write_file: toolWriteFile,
  append_file: toolAppendFile,
  edit_file: toolEditFile,
  list_directory: toolListDirectory,
  find_files: toolFindFiles,
  search_in_files: toolSearchInFiles,
  run_command: toolRunCommand,
  fetch_webpage: (args, _cwd) => toolFetchWebpage(args),
};

/** Async tools that need timeout protection via Promise.race */
const ASYNC_TOOLS = new Set(['run_command', 'fetch_webpage']);

/**
 * Execute a single tool call with timeout protection.
 * Sync tools skip Promise.race overhead (no timer allocation).
 * Returns the result string, never throws.
 */
export async function executeTool(call: ParsedToolCall, cwd: string): Promise<ToolResult> {
  if (!TOOL_NAMES.has(call.name)) {
    return { toolCallId: call.id, name: call.name, content: `未知工具: ${call.name}`, success: false };
  }

  try {
    const fn = TOOL_MAP[call.name];
    if (!fn) {
      return { toolCallId: call.id, name: call.name, content: `未实现工具: ${call.name}`, success: false };
    }

    let content: string;
    if (ASYNC_TOOLS.has(call.name)) {
      // Async tools need timeout protection with proper timer cleanup
      const timeout = TOOL_TIMEOUTS[call.name] ?? DEFAULT_TIMEOUT;
      let timer: ReturnType<typeof setTimeout>;
      content = await Promise.race([
        fn(call.args, cwd) as Promise<string>,
        new Promise<string>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`超时 (${timeout / 1000}s)`)), timeout);
        }),
      ]).finally(() => clearTimeout(timer!));
    } else {
      // Sync tools — direct call, no timer overhead
      content = fn(call.args, cwd) as string;
    }

    // Smart truncation: preserve head + tail so LLM sees both file structure and ending
    if (content.length > MAX_RESULT_LENGTH) {
      const headLen = (MAX_RESULT_LENGTH * 0.7) | 0;
      const tailLen = (MAX_RESULT_LENGTH * 0.25) | 0;
      const omitted = content.length - headLen - tailLen;
      content = `${content.slice(0, headLen)}

[... 已省略 ${omitted} 字符 ...]

${content.slice(-tailLen)}`;
    }

    return { toolCallId: call.id, name: call.name, content, success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { toolCallId: call.id, name: call.name, content: `工具执行失败: ${msg}`, success: false };
  }
}

/** Read-only tools that are safe to run concurrently */
const READ_ONLY_TOOLS = new Set(['read_file', 'list_directory', 'find_files', 'search_in_files', 'fetch_webpage']);

/**
 * Execute multiple tool calls with concurrency safety.
 * Read-only tools run in parallel; write tools run sequentially after reads complete.
 * Inspired by Claude Code's isConcurrencySafe pattern.
 */
export async function executeTools(calls: ParsedToolCall[], cwd: string): Promise<ToolResult[]> {
  if (calls.length === 1) {
    return [await executeTool(calls[0], cwd)];
  }

  // Partition into read-only (safe to parallelize) and write (must serialize)
  const reads: Array<{ call: ParsedToolCall; idx: number }> = [];
  const writes: Array<{ call: ParsedToolCall; idx: number }> = [];
  for (let i = 0; i < calls.length; i++) {
    if (READ_ONLY_TOOLS.has(calls[i].name)) {
      reads.push({ call: calls[i], idx: i });
    } else {
      writes.push({ call: calls[i], idx: i });
    }
  }

  // All read-only or all write — use simple path
  if (writes.length === 0) {
    return Promise.all(calls.map(c => executeTool(c, cwd)));
  }
  if (reads.length === 0) {
    // Serialize write tools to prevent conflicts (e.g., edit_file + write_file on same file)
    const results: ToolResult[] = [];
    for (const c of calls) {
      results.push(await executeTool(c, cwd));
    }
    return results;
  }

  // Mixed: run reads in parallel first, then writes sequentially
  const results = new Array<ToolResult>(calls.length);
  const readResults = await Promise.all(reads.map(r => executeTool(r.call, cwd)));
  for (let i = 0; i < reads.length; i++) {
    results[reads[i].idx] = readResults[i];
  }
  for (const w of writes) {
    results[w.idx] = await executeTool(w.call, cwd);
  }
  return results;
}
