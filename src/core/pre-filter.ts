/**
 * Pre-filter — Deterministic noise removal before LLM compression.
 *
 * Zero token cost. Strips structural noise (ANSI codes, progress bars,
 * duplicate lines, passed tests) that wastes LLM attention.
 * Runs before Compressor's LLM call to reduce input size.
 */

export type OutputType = 'test' | 'json' | 'log' | 'build' | 'general';

export interface PreFilterResult {
  filtered: string;
  originalLength: number;
  filteredLength: number;
  charsRemoved: number;
  strategies: PreFilterStrategyReport[];
  detectedType: OutputType;
}

export interface PreFilterStrategyReport {
  name: string;
  charsRemoved: number;
}

type FilterStrategy = (text: string) => { result: string; name: string };

const universalStrategies: FilterStrategy[] = [stripAnsiCodes, collapseBlankLines, trimTrailingWhitespace, shortenUrls];

const typeSpecificStrategies: Record<OutputType, FilterStrategy[]> = {
  test: [stripProgressBars, deduplicateLines, stripPassedTests],
  json: [deduplicateLines, compactJson],
  log: [stripProgressBars, deduplicateLines],
  build: [stripProgressAndBoilerplate, deduplicateLines, compressCodeBlocks],
  general: [
    stripProgressAndBoilerplate,
    deduplicateLines,
    stripPassedTests,
    compactJson,
    compressCodeBlocks,
  ],
};

/**
 * Detect what type of output the text represents.
 * Enables targeted strategy selection.
 */
export function detectOutputType(text: string): OutputType {
  // Short inputs are almost always general user prompts
  if (text.length < 200) return 'general';

  // Use first ~30 lines without allocating full split array
  let sample: string;
  let nlCount = 0;
  let sampleEnd = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      nlCount++;
      if (nlCount >= 30) { sampleEnd = i; break; }
    }
  }
  sample = sampleEnd > 0 ? text.slice(0, sampleEnd) : text;

  const testIndicators = /[✓✔✗✘×]|^PASS\s|^FAIL\s|Tests?:\s+\d+\s+(passed|failed)|^\s*(ok|not ok)\s+\d/im;
  if (testIndicators.test(sample)) return 'test';

  const jsonIndicators = /^\s*[{[]/m;
  if (jsonIndicators.test(sample)) {
    // Count JSON-like lines without filter+length
    let jsonLines = 0;
    let totalLines = 0;
    let lineStart = 0;
    for (let i = 0; i <= sample.length; i++) {
      if (i === sample.length || sample.charCodeAt(i) === 10) {
        totalLines++;
        // Check if line starts with JSON-like chars
        let j = lineStart;
        while (j < i && (sample.charCodeAt(j) === 32 || sample.charCodeAt(j) === 9)) j++;
        if (j < i) {
          const c = sample.charCodeAt(j);
          if (c === 34 || c === 123 || c === 125 || c === 91 || c === 93 || c === 44 || c === 58) jsonLines++;
        }
        lineStart = i + 1;
      }
    }
    if (jsonLines > totalLines * 0.4) return 'json';
  }

  const logIndicators = /\[\d{4}-\d{2}-\d{2}|^\d{4}-\d{2}-\d{2}T|\b(INFO|WARN|ERROR|DEBUG)\b/;
  if (logIndicators.test(sample)) return 'log';

  const buildIndicators = /\d+%|Building|Compiling|Bundling|Downloading|Installing/i;
  if (buildIndicators.test(sample)) return 'build';

  return 'general';
}

/**
 * Run deterministic pre-filter strategies on the input text.
 * Auto-detects output type and applies targeted strategies.
 */
export function preFilter(text: string): PreFilterResult {
  const originalLength = text.length;

  // Fast path: short, single-line, clean text — skip all strategies
  // Multi-line text always goes through strategies (may contain progress bars, test output, etc.)
  if (originalLength < 200 && !text.includes('\n') && !text.includes('\x1b')) {
    return {
      filtered: text,
      originalLength,
      filteredLength: originalLength,
      charsRemoved: 0,
      strategies: [],
      detectedType: 'general',
    };
  }

  const reports: PreFilterStrategyReport[] = [];
  let current = text;

  const detectedType = detectOutputType(text);

  // Universal strategies always run
  for (const strategy of universalStrategies) {
    const before = current.length;
    const { result, name } = strategy(current);
    current = result;
    const removed = before - current.length;
    if (removed > 0) {
      reports.push({ name, charsRemoved: removed });
    }
  }

  // Type-specific strategies
  for (const strategy of typeSpecificStrategies[detectedType]) {
    const before = current.length;
    const { result, name } = strategy(current);
    current = result;
    const removed = before - current.length;
    if (removed > 0) {
      reports.push({ name, charsRemoved: removed });
    }
  }

  return {
    filtered: current,
    originalLength,
    filteredLength: current.length,
    charsRemoved: originalLength - current.length,
    strategies: reports,
    detectedType,
  };
}

/** Count newlines without allocating an array */
function newlineCount(text: string): number {
  let n = 0;
  let i = -1;
  while ((i = text.indexOf('\n', i + 1)) !== -1) n++;
  return n;
}

// ─── Strategies ────────────────────────────────────────

function stripAnsiCodes(text: string): { result: string; name: string } {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences use control characters by design
  const result = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  return { result, name: 'ansi-strip' };
}

const PROGRESS_BAR = /^[▓░█▒■□●○◆◇\-=>#\s|]*\d{1,3}%|^\s*[|/\-\\]\s*$|^\s*\[=+>?\s*\]\s*\d+%|^\s*(?:Downloading|Uploading|Installing|Progress).*\.\.\.\s*\d+%/i;

function stripProgressBars(text: string): { result: string; name: string } {
  const lines = text.split('\n');
  const filtered = lines.filter((line) => !PROGRESS_BAR.test(line.trimStart()));
  return { result: filtered.join('\n'), name: 'progress-bar-strip' };
}

function collapseBlankLines(text: string): { result: string; name: string } {
  const result = text.replace(/\n{3,}/g, '\n\n');
  return { result, name: 'blank-line-collapse' };
}

function trimTrailingWhitespace(text: string): { result: string; name: string } {
  const result = text.replace(/[ \t]+$/gm, '');
  return { result, name: 'trailing-ws-trim' };
}

const DEDUP_NORMALIZE = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.\dZ]*|\b\d{10,13}\b|\b[0-9a-f]{12,}\b/gi;

function normalizeForDedup(line: string): string {
  return line.trim().replace(DEDUP_NORMALIZE, '<N>');
}

function deduplicateLines(text: string): { result: string; name: string } {
  const lines = text.split('\n');
  if (lines.length < 4) return { result: text, name: 'dedup-lines' };

  const output: string[] = [];
  let prevNormalized = '';
  let prevRawLine = '';
  let repeatCount = 0;

  for (const line of lines) {
    const normalized = normalizeForDedup(line);
    if (normalized === prevNormalized && normalized.length > 0) {
      repeatCount++;
    } else {
      if (repeatCount >= 2) {
        output.push(`  ... (×${repeatCount + 1})`);
      } else if (repeatCount === 1) {
        output.push(prevRawLine);
      }
      output.push(line);
      prevNormalized = normalized;
      prevRawLine = line;
      repeatCount = 0;
    }
  }

  if (repeatCount >= 2) {
    output.push(`  ... (×${repeatCount + 1})`);
  } else if (repeatCount === 1) {
    output.push(prevRawLine);
  }

  return { result: output.join('\n'), name: 'dedup-lines' };
}

function tryCompactJsonString(raw: string, threshold: number): string | null {
  // Quick heuristic: skip JSON.parse attempt if input doesn't look like JSON
  const trimmed = raw.trimStart();
  if (trimmed.charCodeAt(0) !== 123 /* { */ && trimmed.charCodeAt(0) !== 91 /* [ */) return null;

  try {
    const parsed = JSON.parse(raw);
    const compact = JSON.stringify(parsed);
    return compact.length < raw.length * threshold ? compact : null;
  } catch {
    return null;
  }
}

function compactCodeBlockJson(text: string): string {
  const pattern = /```(?:json)?\s*\n([\s\S]*?)```/g;
  return text.replace(pattern, (fullMatch, raw: string) => {
    const compact = tryCompactJsonString(raw, 0.95);
    return compact ? `\`\`\`json\n${compact}\n\`\`\`` : fullMatch;
  });
}

function countBraceDepth(line: string): number {
  let d = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === 123 || c === 91) d++;      // { or [
    else if (c === 125 || c === 93) d--; // } or ]
  }
  return d;
}

function compactStandaloneJson(text: string): string {
  const lines = text.split('\n');
  const output: string[] = [];
  let jsonBuf: string[] = [];
  let braceDepth = 0;
  let inJson = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (!inJson) {
      if (!/^[{[]/.test(trimmed)) {
        output.push(line);
        continue;
      }
      const depth = countBraceDepth(trimmed);
      if (depth <= 0) {
        output.push(line);
        continue;
      }
      inJson = true;
      jsonBuf = [line];
      braceDepth = depth;
      continue;
    }

    jsonBuf.push(line);
    if (jsonBuf.length > 100) {
      for (const l of jsonBuf) output.push(l);
      jsonBuf = [];
      inJson = false;
      continue;
    }
    braceDepth += countBraceDepth(trimmed);

    if (braceDepth > 0) continue;

    inJson = false;
    const jsonStr = jsonBuf.join('\n');
    const compact = tryCompactJsonString(jsonStr, 0.9);
    if (compact) {
      output.push(compact);
    } else {
      for (const l of jsonBuf) output.push(l);
    }
    jsonBuf = [];
  }

  if (jsonBuf.length > 0) {
    for (const l of jsonBuf) output.push(l);
  }
  return output.join('\n');
}

function compactJson(text: string): { result: string; name: string } {
  let result = compactCodeBlockJson(text);
  result = compactStandaloneJson(result);
  return { result, name: 'json-compact' };
}

function stripPassedTests(text: string): { result: string; name: string } {
  const lines = text.split('\n');
  let hasTestOutput = false;
  let strippedCount = 0;

  const PASS = /^\s*(?:[✓✔√]\s|PASS\s|ok\s+\d|\.\.\.\s*$|测试通过|Tests?:\s+\d+\s+passed,\s+\d+\s+total)|^test\s+.*\s+\.\.\.\s+ok\s*$/i;
  const FAIL = /^\s*(?:[✗✘×❌]\s|FAIL\s|not ok\s)/;

  const filtered = lines.filter((line) => {
    const isPass = PASS.test(line);
    const isFail = FAIL.test(line);

    if (isPass || isFail) hasTestOutput = true;

    if (isPass && !isFail) {
      strippedCount++;
      return false;
    }
    return true;
  });

  if (hasTestOutput && strippedCount > 0) {
    const insertIdx = filtered.findIndex((l) => FAIL.test(l));
    const summary = `  [${strippedCount} passed tests hidden]`;
    if (insertIdx >= 0) {
      filtered.splice(insertIdx, 0, summary);
    } else {
      filtered.push(summary);
    }
  }

  return { result: filtered.join('\n'), name: 'test-pass-strip' };
}

function shortenUrls(text: string): { result: string; name: string } {
  const result = text.replace(/https?:\/\/[^\s)>\]"']{80,}/g, (url) => {
    try {
      const u = new URL(url);
      const path = u.pathname.length > 30 ? `${u.pathname.slice(0, 30)}...` : u.pathname;
      return `${u.origin}${path}`;
    } catch {
      return `${url.slice(0, 60)}...`;
    }
  });
  return { result, name: 'url-shorten' };
}

const BOILERPLATE = /^\s*(?:\d+ packages? are looking for funding|run `npm (?:fund|audit(?: fix)?)` for details|run `npm audit` for details|found \d+ vulnerabilit(?:y|ies)|npm warn deprecated)/i;

function stripBoilerplateNotices(text: string): { result: string; name: string } {
  const lines = text.split('\n');
  const filtered = lines.filter((line) => !BOILERPLATE.test(line));
  return { result: filtered.join('\n'), name: 'boilerplate-strip' };
}

/** Combined progress bar + boilerplate filter — single split+join instead of two */
function stripProgressAndBoilerplate(text: string): { result: string; name: string } {
  const lines = text.split('\n');
  const filtered = lines.filter((line) => !PROGRESS_BAR.test(line.trimStart()) && !BOILERPLATE.test(line));
  return { result: filtered.join('\n'), name: 'progress+boilerplate-strip' };
}

function compressCodeBlocks(text: string): { result: string; name: string } {
  const codeBlockPattern = /```(\w*)\n([\s\S]*?)```/g;
  const result = text.replace(codeBlockPattern, (fullMatch, lang: string, code: string) => {
    let compressed = code;

    // Strip comments in single pass (// single-line, # single-line, /* multi-line */)
    compressed = compressed.replace(/(?:^\ *\/\/.*$|^\ *#(?!!).*$|\/\*[\s\S]*?\*\/)/gm, '');

    // Collapse blank lines + trailing whitespace in single pass
    compressed = compressed.replace(/\n{3,}/g, '\n').replace(/[ \t]+$/gm, '');

    // Apply if we saved any meaningful space (>5% reduction)
    if (compressed.length < code.length * 0.95) {
      return `\`\`\`${lang}\n${compressed.trim()}\n\`\`\``;
    }
    return fullMatch;
  });
  return { result, name: 'code-compress' };
}
