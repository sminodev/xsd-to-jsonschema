import { expect } from 'vitest';

/** Enable wall-clock budgets for a performance run on an idle machine. */
export function checkElapsed(started: number, budgetMs: number): void {
  if (process.env['CHECK_PERFORMANCE'] === '1') {
    expect(performance.now() - started).toBeLessThan(budgetMs);
  }
}
