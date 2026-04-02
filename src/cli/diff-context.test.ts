import { describe, expect, it } from 'vitest';
import { DiffContext } from './diff-context.js';

describe('DiffContext', () => {
  it('returns undefined on first query (no history)', () => {
    const dc = new DiffContext();
    expect(dc.buildAugmentedQuery('Write fibonacci in Python')).toBeUndefined();
  });

  it('returns undefined for unrelated long query after a turn', () => {
    const dc = new DiffContext();
    dc.addTurn('Write fibonacci', 'Here is a fibonacci function...', 'direct', 100);
    const unrelated =
      'Design a complete microservices architecture for an e-commerce platform with load balancing and caching strategies';
    expect(dc.buildAugmentedQuery(unrelated)).toBeUndefined();
  });

  it('injects context for short follow-up question', () => {
    const dc = new DiffContext();
    dc.addTurn(
      '用Python写斐波那契函数',
      'def fibonacci(n):\n  if n <= 1: return n\n  return fibonacci(n-1) + fibonacci(n-2)',
      'direct',
      80,
    );

    const result = dc.buildAugmentedQuery('用JavaScript实现');
    expect(result).toBeDefined();
    expect(result).toContain('对话上下文');
    expect(result).toContain('用JavaScript实现');
    expect(result).toContain('斐波那契');
  });

  it('injects context for pattern-matched follow-up', () => {
    const dc = new DiffContext();
    dc.addTurn('Compare React and Vue', 'React uses JSX...', 'direct', 200);

    const result = dc.buildAugmentedQuery('What about Angular compared to the above frameworks?');
    expect(result).toBeDefined();
    expect(result).toContain('React');
  });

  it('injects context when question starts with follow-up keyword', () => {
    const dc = new DiffContext();
    dc.addTurn('Write a sorting algorithm', 'Here is quicksort...', 'direct', 150);

    const result = dc.buildAugmentedQuery('然后优化它的空间复杂度');
    expect(result).toBeDefined();
    expect(result).toContain('sorting');
  });

  it('limits to maxTurns', () => {
    const dc = new DiffContext(3);
    dc.addTurn('Q1', 'A1', 'direct', 10);
    dc.addTurn('Q2', 'A2', 'direct', 20);
    dc.addTurn('Q3', 'A3', 'direct', 30);
    dc.addTurn('Q4', 'A4', 'direct', 40);

    expect(dc.turnCount).toBe(3);
    const result = dc.buildAugmentedQuery('继续');
    expect(result).toBeDefined();
    expect(result).not.toContain('Q1');
    expect(result).toContain('Q2');
  });

  it('includes at most 3 recent turns in context', () => {
    const dc = new DiffContext(5);
    for (let i = 1; i <= 5; i++) {
      dc.addTurn(`Question ${i}`, `Answer ${i}`, 'direct', 50);
    }

    const result = dc.buildAugmentedQuery('继续');
    expect(result).toBeDefined();
    expect(result).not.toContain('Question 1');
    expect(result).not.toContain('Question 2');
    expect(result).toContain('Question 3');
    expect(result).toContain('Question 4');
    expect(result).toContain('Question 5');
  });

  it('clears context', () => {
    const dc = new DiffContext();
    dc.addTurn('Q1', 'A1', 'direct', 100);
    dc.clear();
    expect(dc.turnCount).toBe(0);
    expect(dc.buildAugmentedQuery('继续')).toBeUndefined();
  });

  it('tracks token savings stats', () => {
    const dc = new DiffContext();
    dc.addTurn('Q1', 'A long response with many tokens', 'direct', 500);
    dc.addTurn('Q2', 'Another response', 'light', 300);

    const stats = dc.getStats();
    expect(stats.totalTurns).toBe(2);
    expect(stats.estimatedTokensSaved).toBeGreaterThan(0);
  });

  it('truncates long response summaries', () => {
    const dc = new DiffContext(5, 50);
    const longReport = 'A'.repeat(300);
    dc.addTurn('Q1', longReport, 'direct', 100);

    const result = dc.buildAugmentedQuery('继续');
    expect(result).toBeDefined();
    expect(result!.length).toBeLessThan(300);
  });

  it('39-char question without follow-up pattern is NOT a follow-up', () => {
    const dc = new DiffContext();
    dc.addTurn('Previous question', 'Previous answer', 'direct', 50);

    const shortQ = 'a'.repeat(39);
    expect(dc.buildAugmentedQuery(shortQ)).toBeUndefined();
  });

  it('40-char question without follow-up pattern returns undefined', () => {
    const dc = new DiffContext();
    dc.addTurn('Previous question', 'Previous answer', 'direct', 50);

    const longQ = 'x'.repeat(40);
    expect(dc.buildAugmentedQuery(longQ)).toBeUndefined();
  });

  it('handles empty/whitespace-only response summary', () => {
    const dc = new DiffContext();
    dc.addTurn('Q1', '\n\n  \n', 'direct', 50);

    const result = dc.buildAugmentedQuery('继续');
    expect(result).toBeDefined();
    expect(result).toContain('(empty)');
  });

  it('truncates long questions to 120 chars', () => {
    const dc = new DiffContext();
    const longQuestion = 'Q'.repeat(200);
    dc.addTurn(longQuestion, 'answer', 'direct', 50);

    const result = dc.buildAugmentedQuery('继续');
    expect(result).toBeDefined();
    expect(result).not.toContain('Q'.repeat(200));
    expect(result).toContain('Q'.repeat(120));
  });

  it('single turn has zero estimated token savings', () => {
    const dc = new DiffContext();
    dc.addTurn('Q1', 'A1', 'direct', 100);

    const stats = dc.getStats();
    expect(stats.totalTurns).toBe(1);
    expect(stats.estimatedTokensSaved).toBe(0);
  });
});
