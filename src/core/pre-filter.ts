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

const universalStrategies: FilterStrategy[] = [stripAnsiCodes, collapseBlankLines, trimTrailingWhitespace];

const typeSpecificStrategies: Record<OutputType, FilterStrategy[]> = {
  test: [stripProgressBars, deduplicateLines, stripPassedTests],
  json: [deduplicateLines, compactJson],
  log: [stripProgressBars, deduplicateLines],
  build: [stripProgressBars, deduplicateLines, stripBoilerplateNotices, compressCodeBlocks],
  general: [
    stripProgressBars,
    deduplicateLines,
    stripPassedTests,
    compactJson,
    stripBoilerplateNotices,
    compressCodeBlocks,
  ],
};

/**
 * Detect what type of output the text represents.
 * Enables targeted strategy selection.
 */
export function detectOutputType(text: string): OutputType {
  const lines = text.split('\n').slice(0, 30);
  const sample = lines.join('\n');

  const testIndicators = /[✓✔✗✘×]|PASS\s|FAIL\s|Tests?:\s+\d|passed|failed.*total/i;
  if (testIndicators.test(sample)) return 'test';

  const jsonIndicators = /^\s*[{[]/m;
  const jsonLineCount = lines.filter((l) => /^\s*["{}[\],:]/.test(l)).length;
  if (jsonIndicators.test(sample) && jsonLineCount > lines.length * 0.4) return 'json';

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

// ─── Strategies ────────────────────────────────────────

function stripAnsiCodes(text: string): { result: string; name: string } {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences use control characters by design
  const result = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  return { result, name: 'ansi-strip' };
}

function stripProgressBars(text: string): { result: string; name: string } {
  const lines = text.split('\n');
  const filtered = lines.filter((line) => {
    if (/^[▓░█▒■□●○◆◇\-=>#\s|]*\d{1,3}%/.test(line.trim())) return false;
    if (/^\s*[|/\-\\]\s*$/.test(line)) return false;
    if (/^.*\[=*>?\s*\].*\d+%/.test(line)) return false;
    if (/^(Downloading|Uploading|Installing|Progress).*\.\.\.\s*\d+%/i.test(line.trim())) return false;
    return true;
  });
  return { result: filtered.join('\n'), name: 'progress-bar-strip' };
}

function collapseBlankLines(text: string): { result: string; name: string } {
  const result = text.replace(/\n{3,}/g, '\n\n');
  return { result, name: 'blank-line-collapse' };
}

function trimTrailingWhitespace(text: string): { result: string; name: string } {
  const result = text
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n');
  return { result, name: 'trailing-ws-trim' };
}

function deduplicateLines(text: string): { result: string; name: string } {
  const lines = text.split('\n');
  if (lines.length < 4) return { result: text, name: 'dedup-lines' };

  const output: string[] = [];
  let prevLine = '';
  let repeatCount = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === prevLine && trimmed.length > 0) {
      repeatCount++;
    } else {
      if (repeatCount >= 2) {
        output.push(`  ... (×${repeatCount + 1})`);
      } else if (repeatCount === 1) {
        output.push(prevLine);
      }
      output.push(line);
      prevLine = trimmed;
      repeatCount = 0;
    }
  }

  if (repeatCount >= 2) {
    output.push(`  ... (×${repeatCount + 1})`);
  } else if (repeatCount === 1) {
    output.push(prevLine);
  }

  return { result: output.join('\n'), name: 'dedup-lines' };
}

function tryCompactJsonString(raw: string, threshold: number): string | null {
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
  return (line.match(/[{[]/g) || []).length - (line.match(/[}\]]/g) || []).length;
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
    braceDepth += countBraceDepth(trimmed);

    if (braceDepth > 0) continue;

    inJson = false;
    const jsonStr = jsonBuf.join('\n');
    const compact = tryCompactJsonString(jsonStr, 0.9);
    if (compact) {
      output.push(compact);
    } else {
      output.push(...jsonBuf);
    }
    jsonBuf = [];
  }

  if (jsonBuf.length > 0) output.push(...jsonBuf);
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

  const passPatterns = [
    /^\s*✓\s/,
    /^\s*✔\s/,
    /^\s*PASS\s/,
    /^\s*√\s/,
    /^\s*ok\s+\d/,
    /^\s*\.\.\.\s*$/,
    /^test\s+.*\s+\.\.\.\s+ok\s*$/,
    /^\s*测试通过/,
    /^\s*Tests?:\s+\d+\s+passed,\s+\d+\s+total/i,
  ];

  const failPatterns = [/^\s*✗\s/, /^\s*✘\s/, /^\s*FAIL\s/, /^\s*×\s/, /^\s*not ok\s/, /^\s*❌/];

  const filtered = lines.filter((line) => {
    const isPass = passPatterns.some((p) => p.test(line));
    const isFail = failPatterns.some((p) => p.test(line));

    if (isPass || isFail) hasTestOutput = true;

    if (isPass && !isFail) {
      strippedCount++;
      return false;
    }
    return true;
  });

  if (hasTestOutput && strippedCount > 0) {
    const insertIdx = filtered.findIndex((l) => failPatterns.some((p) => p.test(l)));
    const summary = `  [${strippedCount} passed tests hidden]`;
    if (insertIdx >= 0) {
      filtered.splice(insertIdx, 0, summary);
    } else {
      filtered.push(summary);
    }
  }

  return { result: filtered.join('\n'), name: 'test-pass-strip' };
}

function stripBoilerplateNotices(text: string): { result: string; name: string } {
  const boilerplatePatterns = [
    /^\d+ packages? are looking for funding$/,
    /^\s*run `npm fund` for details$/,
    /^\s*run `npm audit fix` to resolve$/,
    /^\s*run `npm audit` for details$/,
    /^\s*found \d+ vulnerabilit(y|ies)$/,
    /^\s*npm warn deprecated/,
  ];
  const lines = text.split('\n');
  const filtered = lines.filter((line) => !boilerplatePatterns.some((p) => p.test(line.trim())));
  return { result: filtered.join('\n'), name: 'boilerplate-strip' };
}

function compressCodeBlocks(text: string): { result: string; name: string } {
  const codeBlockPattern = /```(\w*)\n([\s\S]*?)```/g;
  const result = text.replace(codeBlockPattern, (fullMatch, lang: string, code: string) => {
    let compressed = code;

    // Strip single-line comments (// and #)
    compressed = compressed.replace(/^\s*\/\/.*$/gm, '');
    compressed = compressed.replace(/^\s*#(?!!).*$/gm, '');

    // Strip multi-line comments (/* ... */)
    compressed = compressed.replace(/\/\*[\s\S]*?\*\//g, '');

    // Collapse multiple blank lines inside code
    compressed = compressed.replace(/\n{3,}/g, '\n');

    // Remove trailing whitespace in code lines
    compressed = compressed
      .split('\n')
      .map((l) => l.trimEnd())
      .join('\n');

    // Apply if we saved any meaningful space (>5% reduction)
    if (compressed.length < code.length * 0.95) {
      return `\`\`\`${lang}\n${compressed.trim()}\n\`\`\``;
    }
    return fullMatch;
  });
  return { result, name: 'code-compress' };
}
