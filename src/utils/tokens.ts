/**
 * Token estimation utilities for context budgeting
 */

/**
 * Rough token estimation (4 chars per token is a reasonable approximation for code)
 *
 * This is intentionally simple - for budget estimation we don't need tiktoken's
 * precision, just a ballpark to avoid sending too much context.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Budget allocation by category (explicit files get priority, then session, etc.)
 *
 * These percentages determine how the token budget is divided when multiple
 * categories of files compete for space.
 */
export const BUDGET_ALLOCATION = {
  explicit: 0.15,
  session: 0.3,
  git: 0.1,
  dependency: 0.15,
  dependent: 0.15,
  test: 0.1,
  type: 0.05,
} as const;

export type BudgetCategory = keyof typeof BUDGET_ALLOCATION;

/**
 * Priority order for processing categories during budget allocation.
 * Higher priority categories are processed first and get their allocation.
 * Unused budget from earlier categories spills over to later ones.
 */
export const CATEGORY_PRIORITY_ORDER: BudgetCategory[] = [
  "explicit",   // User explicitly requested - highest priority
  "session",    // Claude worked on these - critical context
  "git",        // Other git changes
  "dependency", // Files imported by modified code
  "dependent",  // Files that import modified code
  "test",       // Related tests
  "type",       // Type definitions - lowest priority
];
