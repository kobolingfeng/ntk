/**
 * DiffContext — Differential context for multi-turn interactive sessions.
 *
 * Tracks conversation history and injects compact incremental context
 * into follow-up queries, avoiding full context repetition.
 *
 * Token savings come from:
 * - Follow-up questions get a compressed summary instead of requiring
 *   the user to repeat background information
 * - Only recent turns are included (sliding window)
 * - Older turns are summarized more aggressively
 */

interface ConversationTurn {
  question: string;
  responseSummary: string;
  depth: string;
  tokenCount: number;
}

const FOLLOW_UP_PATTERNS = [
  /^(那|然后|继续|还有|另外|再|接着|除此之外|此外|同样)/,
  /^(and |also |then |next |but |however |what about |how about )/i,
  /^(用|改|换|试|加|删|修改|优化|重构|简化)/,
  /(上面|之前|刚才|前面|上一个|这个|同样的)/,
  /(above|previous|earlier|last one|the same|this one)/i,
  /^(为什么|怎么|如何|是否|能不能|可以|可不可以)/,
  /^(why|how|can you|could you|is it|does it)/i,
];

export class DiffContext {
  private turns: ConversationTurn[] = [];
  private readonly maxTurns: number;
  private readonly summaryMaxLen: number;

  constructor(maxTurns = 5, summaryMaxLen = 200) {
    this.maxTurns = maxTurns;
    this.summaryMaxLen = summaryMaxLen;
  }

  addTurn(question: string, report: string, depth: string, tokenCount: number): void {
    this.turns.push({
      question: question.slice(0, 120),
      responseSummary: this.summarizeResponse(report),
      depth,
      tokenCount,
    });
    if (this.turns.length > this.maxTurns) {
      this.turns.shift();
    }
  }

  /**
   * Build an augmented query for follow-up questions.
   * Returns undefined if no context injection is needed (first turn or unrelated query).
   */
  buildAugmentedQuery(newQuestion: string): string | undefined {
    if (this.turns.length === 0) return undefined;
    if (!this.isFollowUp(newQuestion)) return undefined;

    const recentTurns = this.turns.slice(-3);
    const contextLines = recentTurns.map((t, i) => `[${i + 1}] Q: ${t.question}\n    A: ${t.responseSummary}`);

    return `[对话上下文 / Conversation context]\n${contextLines.join('\n')}\n\n[当前问题 / Current question]\n${newQuestion}`;
  }

  get turnCount(): number {
    return this.turns.length;
  }

  /** Estimate tokens saved by using diff context vs repeating full responses */
  getStats(): { totalTurns: number; estimatedTokensSaved: number } {
    let saved = 0;
    for (let i = 1; i < this.turns.length; i++) {
      const prevTokens = this.turns[i - 1].tokenCount;
      const summaryTokens = Math.ceil(this.turns[i - 1].responseSummary.length / 4);
      saved += Math.max(0, prevTokens - summaryTokens);
    }
    return { totalTurns: this.turns.length, estimatedTokensSaved: saved };
  }

  clear(): void {
    this.turns = [];
  }

  private isFollowUp(question: string): boolean {
    if (question.length < 40) return true;
    return FOLLOW_UP_PATTERNS.some((p) => p.test(question));
  }

  private summarizeResponse(report: string): string {
    const lines = report.split('\n').filter((l) => l.trim());
    if (lines.length === 0) return '(empty)';

    let summary = '';
    for (const line of lines) {
      if (summary.length + line.length > this.summaryMaxLen) break;
      summary += (summary ? ' ' : '') + line.trim();
    }
    if (summary.length > this.summaryMaxLen) {
      summary = `${summary.slice(0, this.summaryMaxLen)}...`;
    }
    return summary || lines[0].slice(0, this.summaryMaxLen);
  }
}
