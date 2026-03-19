import * as path from "path";

/**
 * Language-specific pitfall hints for code reviews.
 * 3-5 targeted warnings per language, focused on the most common
 * bugs that LLM-generated code tends to introduce.
 */
const LANGUAGE_HINTS: Record<string, string[]> = {
  typescript: [
    "Watch for `any` type abuse that bypasses TypeScript's safety guarantees",
    "Check for unhandled Promise rejections and missing `await` on async calls",
    "Look for accidental prop/state mutation instead of immutable updates",
    "Verify loose equality (`==`) isn't masking type coercion bugs",
    "Check that error types in catch blocks are properly narrowed",
  ],
  javascript: [
    "Watch for unhandled Promise rejections and missing `await` on async calls",
    "Look for accidental mutation of shared objects or arrays",
    "Verify loose equality (`==`) isn't masking type coercion bugs",
    "Check for missing null/undefined guards on optional chaining fallthrough",
    "Look for implicit type coercion in comparisons and arithmetic",
  ],
  python: [
    "Watch for mutable default arguments (`def f(x=[])`), which persist between calls",
    "Look for bare `except:` clauses that swallow all exceptions including KeyboardInterrupt",
    "Check for mutable class attributes that are shared across all instances",
    "Verify f-strings don't interpolate unsanitized user input in SQL/shell contexts",
    "Look for missing `__init__` in dataclass-like classes that rely on class attributes",
  ],
  go: [
    "Check for unchecked error returns — every `error` return value must be handled",
    "Watch for goroutine leaks from missing context cancellation or channel cleanup",
    "Look for nil pointer dereferences on interface types and pointer receivers",
    "Verify `defer` isn't used inside loops (deferred calls execute at function exit, not iteration end)",
    "Check for data races on shared state — use `-race` flag or explicit synchronization",
  ],
  rust: [
    "Watch for `.unwrap()` in production code paths — prefer `?` operator or explicit error handling",
    "Look for unnecessary `.clone()` calls that could be replaced with borrows",
    "Check for lifetime issues at module boundaries where references cross function signatures",
    "Verify `unsafe` blocks are minimal, documented, and actually necessary",
    "Look for potential deadlocks in code using multiple `Mutex` or `RwLock`",
  ],
};

const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".cts": "typescript",
  ".mts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
};

/**
 * Detect the dominant programming language from a list of file paths.
 * Returns null if no recognized language is found.
 */
export function detectDominantLanguage(filePaths: string[]): string | null {
  const counts: Record<string, number> = {};

  for (const filePath of filePaths) {
    const ext = path.extname(filePath).toLowerCase();
    const lang = EXTENSION_TO_LANGUAGE[ext];
    if (lang) {
      counts[lang] = (counts[lang] || 0) + 1;
    }
  }

  let maxLang: string | null = null;
  let maxCount = 0;
  for (const [lang, count] of Object.entries(counts)) {
    if (count > maxCount) {
      maxCount = count;
      maxLang = lang;
    }
  }

  return maxLang;
}

/** Display names for proper capitalization in headings */
const LANGUAGE_DISPLAY_NAMES: Record<string, string> = {
  typescript: "TypeScript",
  javascript: "JavaScript",
  python: "Python",
  go: "Go",
  rust: "Rust",
};

/**
 * Get formatted language-specific hints for injection into the review prompt.
 * Returns null if no hints are available for the given language.
 */
export function getLanguageHints(language: string): string | null {
  const hints = LANGUAGE_HINTS[language];
  if (!hints) return null;

  const name = LANGUAGE_DISPLAY_NAMES[language] || language;
  const lines = [
    `## ${name}-Specific Pitfalls`,
    "",
    "Watch for these common issues in this codebase:",
    "",
    ...hints.map((h) => `- ${h}`),
  ];

  return lines.join("\n");
}
