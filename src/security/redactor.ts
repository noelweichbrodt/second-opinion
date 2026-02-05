/**
 * Secret redaction for file content before sending to external LLMs.
 * Scans content for common secret patterns and replaces them with placeholders.
 */

export interface RedactionResult {
  content: string;
  redactionCount: number;
  redactedTypes: string[];
}

interface SecretPattern {
  name: string;
  pattern: RegExp;
}

/**
 * Patterns for detecting secrets in file content.
 * These are designed to catch common secret formats while minimizing false positives.
 *
 * IMPORTANT: Order matters! More specific patterns should come before generic ones
 * to ensure proper classification. For example, `openai_key` (sk-...) should be
 * checked before `generic_secret` which might also match.
 */
const SECRET_PATTERNS: SecretPattern[] = [
  // Private keys (PEM format) - check first as they're very specific
  {
    name: "private_key",
    pattern:
      /-----BEGIN [A-Z]+ PRIVATE KEY-----[\s\S]+?-----END [A-Z]+ PRIVATE KEY-----/g,
  },
  // JWT tokens (three base64 segments separated by dots)
  {
    name: "jwt",
    pattern: /eyJ[A-Za-z0-9-_]+\.eyJ[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+/g,
  },
  // AWS access keys (always start with AKIA)
  {
    name: "aws_key",
    pattern: /AKIA[0-9A-Z]{16}/g,
  },
  // GitHub tokens (personal access tokens, OAuth tokens, etc.)
  {
    name: "github_token",
    pattern: /gh[pousr]_[A-Za-z0-9_]{36,}/g,
  },
  // OpenAI API keys (sk- prefix, more specific than generic)
  {
    name: "openai_key",
    pattern: /sk-[A-Za-z0-9]{20,}/g,
  },
  // Stripe API keys
  {
    name: "stripe_key",
    pattern: /sk_(?:live|test)_[A-Za-z0-9]{24,}/g,
  },
  // Slack tokens
  {
    name: "slack_token",
    pattern: /xox[baprs]-[A-Za-z0-9-]+/g,
  },
  // Database connection strings
  {
    name: "connection_string",
    pattern: /(mongodb|postgres|postgresql|mysql|redis|amqp):\/\/[^\s'"]+/gi,
  },
  // Basic auth in URLs
  {
    name: "basic_auth",
    pattern: /https?:\/\/[^:]+:[^@]+@[^\s'"]+/gi,
  },
  // Bearer tokens in strings
  {
    name: "bearer_token",
    pattern: /['"]Bearer\s+[A-Za-z0-9._-]{20,}['"]/gi,
  },
  // Hex-encoded secrets (32+ chars, typically 64 for SHA-256)
  // Must come before generic patterns
  {
    name: "hex_secret",
    pattern: /(secret|key|token|hash)\s*[:=]\s*['"][a-fA-F0-9]{32,}['"]/gi,
  },
  // Base64-encoded secrets (common in configs)
  {
    name: "base64_secret",
    pattern:
      /(secret|key|token|password)\s*[:=]\s*['"][A-Za-z0-9+/]{40,}={0,2}['"]/gi,
  },
  // Generic API key assignments - should be near last as it's broad
  {
    name: "api_key",
    pattern: /(api[_-]?key|apikey)\s*[:=]\s*['"][^'"]{10,}['"]/gi,
  },
  // Generic secret/password assignments - last as catch-all
  {
    name: "generic_secret",
    pattern: /(secret|password|passwd|pwd)\s*[:=]\s*['"][^'"]{8,}['"]/gi,
  },
];

/**
 * Redact secrets from content, replacing them with type-specific placeholders.
 *
 * @param content - The file content to scan and redact
 * @returns RedactionResult containing cleaned content and redaction statistics
 */
export function redactSecrets(content: string): RedactionResult {
  let redactedContent = content;
  let totalRedactions = 0;
  const typesFound = new Set<string>();

  for (const { name, pattern } of SECRET_PATTERNS) {
    // Reset lastIndex for global patterns
    pattern.lastIndex = 0;

    // Count matches before replacing
    const matches = content.match(pattern);
    if (matches) {
      totalRedactions += matches.length;
      typesFound.add(name);
    }

    // Replace all matches with a redaction placeholder
    redactedContent = redactedContent.replace(
      pattern,
      `[REDACTED:${name}]`
    );
  }

  return {
    content: redactedContent,
    redactionCount: totalRedactions,
    redactedTypes: Array.from(typesFound),
  };
}

/**
 * Check if content contains any secrets without modifying it.
 * Useful for validation before deciding to proceed.
 *
 * @param content - The content to check
 * @returns true if secrets were detected
 */
export function containsSecrets(content: string): boolean {
  for (const { pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(content)) {
      return true;
    }
  }
  return false;
}

/**
 * Get a list of all secret types that would be detected
 */
export function getSecretPatternNames(): string[] {
  return SECRET_PATTERNS.map((p) => p.name);
}
