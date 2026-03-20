# Two-Pass Budget Allocation Refactor

## Problem

The bundler processes file categories sequentially (explicit → session → pr → git → dependency → dependent → test → type). Each category gets a base budget (percentage of remaining tokens) plus "spillover" from prior categories that underused their allocation. Spillover only flows forward.

**Consequence:** Early categories (session) can't benefit from later categories (dependency, test, type) being empty. Important files get dropped even when the total budget has plenty of room.

**Real example:** Session files (CLAUDE.md ~12k, README ~8k, bundler.ts ~25k) consume the ~53k session allocation. Files like git.ts, base.ts, consensus.ts, review.ts get dropped — even though total context is 32k of a 200k budget.

## Design: Two-Pass Architecture

### Pass 1: Measure (Collect Candidates)

Collect all candidate files for every category without committing any budget. Store results in a `Map<BudgetCategory, CandidateFile[]>`.

```typescript
interface CandidateFile {
  path: string;
  content: string;
  category: FileEntry["category"];
  tokenEstimate: number;
  annotation?: string;
  skipBoundsCheck?: boolean;
  redactionCount: number;
  redactedTypes: string[];
}
```

**Fixed overhead** is computed during this pass and subtracted from the total pool before file allocation:

```
filePool = maxTokens - conversationTokens - prMetadataTokens - branchDiffTokens
```

Branch diff keeps its existing cap (`min(15% of remainingBudget, 20000)`) with hunk-aware truncation. PR metadata is included at its natural size. These don't compete with file categories — they're always included.

### Deduplication (Between Passes)

When a file appears in multiple categories, assign it to the highest-priority category (per `CATEGORY_PRIORITY_ORDER`) and remove from lower-priority candidate lists.

### Pass 2: Allocate (Distribute Budget)

With full demand visibility, distribute the file pool across categories.

**Algorithm:**

1. Compute `demand[cat]` = sum of token estimates for all candidates in that category.

2. **If totalDemand <= filePool**: Include everything. No budget math needed. This is the common case and directly fixes the original problem.

3. **If totalDemand > filePool** (contention): Surplus redistribution:

   a. Start with base allocations: `baseAlloc[cat] = filePool * BUDGET_ALLOCATION[cat]`

   b. Identify **surplus categories** (`demand < baseAlloc`) and **deficit categories** (`demand > baseAlloc`).

   c. Set surplus categories' effective allocation to their demand. Compute `totalSurplus`.

   d. Distribute surplus to deficit categories proportionally to their deficit sizes:
      ```
      effectiveAlloc[cat] = baseAlloc[cat] + totalSurplus * (deficit[cat] / totalDeficit)
      ```

   e. Iterate up to 3 rounds (new surplus may emerge as deficit categories get more than they need). One round usually suffices.

4. **Within each category**, select files greedily up to `effectiveAlloc[cat]`:
   - explicit/session: preserve insertion order (user intent)
   - all others: sort smallest first (maximize file count)

5. Unselected files become omitted with `reason: "budget_exceeded"`.

### Core Function

```typescript
interface CategoryCandidates {
  category: BudgetCategory;
  files: CandidateFile[];
  totalDemand: number;
}

interface AllocationResult {
  included: FileEntry[];
  omitted: OmittedFile[];
  categoryTokens: Record<BudgetCategory, number>;
}

function allocateBudget(
  candidates: CategoryCandidates[],
  filePool: number,
  budgetWeights: Record<BudgetCategory, number>,
  priorityOrder: BudgetCategory[]
): AllocationResult
```

---

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| **Total demand < supply** (common case) | All files included. Zero omissions. Fixes the original bug. |
| **Total demand > supply** (contention) | Surplus redistribution ensures empty categories donate to busy ones. Works bidirectionally — session benefits from empty type/test/dependent. |
| **One category dominates** | If session needs 150k of 200k and others need 30k, session gets its 20% base (40k) + ~140k surplus from categories with low demand. |
| **Branch diff very large** | Capped and truncated as fixed overhead before file allocation. No interaction with category budgets. |
| **Conversation very large** | Subtracted as fixed overhead. Reduces file pool, allocator handles gracefully. |
| **All files in one category** | That category gets the entire file pool. Base percentages only matter under cross-category contention. |

---

## File Changes

### `src/context/bundler.ts` (primary refactor)

Restructure `bundleContext` into three phases:

**Phase A — Collection:** Same file collection logic (session parsing, git changes, dependency resolution, etc.) but stores into `candidates: Map<BudgetCategory, CandidateFile[]>` instead of calling `addFilesWithBudget`. Fixed overhead (conversation, PR metadata, branch diff) computed inline.

**Phase B — Deduplication:** Iterate candidates in priority order, remove duplicates from lower-priority lists.

**Phase C — Allocation:** Call `allocateBudget()` with the candidate map and file pool.

**Removals:**
- `addFilesWithBudget` closure
- `getBudgetWithSpillover` closure
- `spilloverBudget` variable and all spillover tracking
- `baseBudgets` computation (moved into allocator)
- Branch diff budget absorption logic (replaced by fixed overhead subtraction)

### `src/utils/tokens.ts` (minor)

Add fixed overhead cap constants:
```typescript
export const FIXED_OVERHEAD_CAPS = {
  branchDiffFraction: 0.15,
  branchDiffAbsoluteMax: 20000,
} as const;
```

`BUDGET_ALLOCATION` percentages unchanged — they're now priority weights for contention only.

### `src/context/bundler.test.ts` (test updates + additions)

**Existing tests requiring updates:**
- "respects maxTokens budget" — with two-pass, small files that fit in total budget will no longer be dropped. Adjust maxTokens or add competing categories to force contention.
- "prioritizes files by category budget allocation" — same issue; add cross-category competition.
- "spills over unused budget to later categories" — spillover concept replaced; rephrase as redistribution tests.

**New tests:**
1. **All-fit fast path**: Files across 4 categories totaling 30% of budget → zero omissions
2. **Backward redistribution**: Session files at 50% of budget, empty dep/test/type → all session files included
3. **Priority under contention**: Files in all 8 categories totaling 3x budget → explicit/session get proportionally more than test/type
4. **Branch diff as fixed overhead**: Diff reduces file pool but doesn't affect per-category percentages
5. **Dedup by priority**: File in both session and dependency → included as session only
6. **Unit tests for `allocateBudget`**: all-fit, single-round redistribution, multi-round convergence, exact-fit edge case

---

## Implementation Sequence

1. Add `FIXED_OVERHEAD_CAPS` to `tokens.ts` (trivial, no behavior change)
2. Implement `allocateBudget` as standalone function, write unit tests for it in isolation
3. Refactor `bundleContext` to two-pass architecture — collection logic stays nearly identical, main change is storing candidates instead of committing budget inline
4. Update existing tests that need assertion adjustments
5. Add new tests for redistribution, all-fit, and contention behaviors
6. Run full suite, verify no regressions

## Risks

| Risk | Mitigation |
|------|------------|
| Subtle behavior changes in edge cases | `ContextBundle` interface unchanged. Existing tests as regression gate. The only change is *more* files included — strictly beneficial. |
| Performance regression | Measure pass does same I/O as today. Allocate pass is pure arithmetic over <100 candidates. No measurable impact. |
| Category ordering changes | Same selection ordering within categories (insertion-order for explicit/session, smallest-first for others). Only effective budgets change — meaning more files, not different files. |
