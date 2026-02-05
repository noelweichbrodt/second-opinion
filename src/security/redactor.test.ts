import { describe, it, expect } from "vitest";
import {
  redactSecrets,
  containsSecrets,
  getSecretPatternNames,
} from "./redactor.js";

describe("redactSecrets", () => {
  it("redacts API keys in assignment format", () => {
    // Use api_key assignment which triggers the api_key pattern
    const input = 'const apiKey = "my-secret-api-key-12345";';
    const result = redactSecrets(input);

    expect(result.content).toContain("[REDACTED:api_key]");
    expect(result.content).not.toContain("my-secret-api-key-12345");
    expect(result.redactionCount).toBeGreaterThan(0);
  });

  it("redacts AWS access keys", () => {
    const input = "const awsKey = AKIAIOSFODNN7EXAMPLE;";
    const result = redactSecrets(input);

    expect(result.content).toContain("[REDACTED:aws_key]");
    expect(result.content).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(result.redactedTypes).toContain("aws_key");
  });

  it("redacts JWT tokens", () => {
    const input =
      'token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"';
    const result = redactSecrets(input);

    expect(result.content).toContain("[REDACTED:jwt]");
    expect(result.content).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    expect(result.redactedTypes).toContain("jwt");
  });

  it("redacts MongoDB connection strings", () => {
    const input = 'const uri = "mongodb://user:pass@host:27017/mydb";';
    const result = redactSecrets(input);

    expect(result.content).toContain("[REDACTED:connection_string]");
    expect(result.content).not.toContain("mongodb://user:pass");
    expect(result.redactedTypes).toContain("connection_string");
  });

  it("redacts PostgreSQL connection strings", () => {
    const input = 'DATABASE_URL="postgres://admin:secret@localhost:5432/app"';
    const result = redactSecrets(input);

    expect(result.content).toContain("[REDACTED:connection_string]");
    expect(result.redactedTypes).toContain("connection_string");
  });

  it("redacts private keys", () => {
    const input = `const key = \`-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA0Z3VS...
-----END RSA PRIVATE KEY-----\`;`;
    const result = redactSecrets(input);

    expect(result.content).toContain("[REDACTED:private_key]");
    expect(result.content).not.toContain("MIIEpAIBAAKCAQEA0Z3VS");
    expect(result.redactedTypes).toContain("private_key");
  });

  it("redacts GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_)", () => {
    const inputs = [
      "ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx1234",
      "gho_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx5678",
      "ghu_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx9012",
      "ghs_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx3456",
      "ghr_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx7890",
    ];

    for (const token of inputs) {
      const result = redactSecrets(`token: ${token}`);
      expect(result.content).toContain("[REDACTED:github_token]");
      expect(result.content).not.toContain(token);
    }
  });

  it("redacts generic password assignments", () => {
    const inputs = [
      'password: "mysecretpassword"',
      "secret = 'very-secret-value-123'",
      'pwd: "shortpwd12345"',
    ];

    for (const input of inputs) {
      const result = redactSecrets(input);
      expect(result.content).toContain("[REDACTED:generic_secret]");
      expect(result.redactionCount).toBeGreaterThan(0);
    }
  });

  it("redacts OpenAI API keys", () => {
    // Use a standalone sk- key (not in an api_key= assignment)
    const input = 'const key = sk-abcdefghijklmnopqrstuvwxyz123456;';
    const result = redactSecrets(input);

    expect(result.content).toContain("[REDACTED:openai_key]");
    expect(result.content).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
  });

  it("redacts Stripe API keys", () => {
    const inputs = [
      "sk_live_1234567890abcdefghijklmnop",
      "sk_test_0987654321zyxwvutsrqponmlkj",
    ];

    for (const key of inputs) {
      const result = redactSecrets(`const stripe = "${key}";`);
      expect(result.content).toContain("[REDACTED:stripe_key]");
      expect(result.content).not.toContain(key);
    }
  });

  it("redacts Slack tokens", () => {
    const inputs = [
      "xoxb-123456789012-123456789012-abcdefghijklmnopqrstuvwx",
      "xoxp-123456789012-123456789012-123456789012-abcdefghijklmnopqrstuvwxyz12",
      "xoxa-123456789012-123456789012",
    ];

    for (const token of inputs) {
      const result = redactSecrets(`token: "${token}"`);
      expect(result.content).toContain("[REDACTED:slack_token]");
      expect(result.content).not.toContain(token);
    }
  });

  it("redacts Bearer tokens in strings", () => {
    const input = 'headers: { Authorization: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" }';
    const result = redactSecrets(input);

    expect(result.content).toContain("[REDACTED:");
    expect(result.redactionCount).toBeGreaterThan(0);
  });

  it("redacts basic auth in URLs", () => {
    const input = 'const url = "https://admin:secret123@api.example.com/data";';
    const result = redactSecrets(input);

    expect(result.content).toContain("[REDACTED:basic_auth]");
    expect(result.content).not.toContain("admin:secret123");
  });

  it("redacts hex-encoded secrets", () => {
    // Use 'hash' instead of 'secret' to avoid matching generic_secret first
    const input = 'const hash = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";';
    const result = redactSecrets(input);

    expect(result.content).toContain("[REDACTED:hex_secret]");
  });

  it("handles multiple secrets in one file", () => {
    const input = `
      const config = {
        api_key: "my-secret-api-key-12345",
        password: "hunter2hunter2",
        dbUrl: "postgres://user:pass@host/db",
        github: "ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx1234",
      };
    `;
    const result = redactSecrets(input);

    expect(result.redactionCount).toBeGreaterThanOrEqual(3);
    expect(result.redactedTypes.length).toBeGreaterThanOrEqual(3);
    expect(result.content).not.toContain("my-secret-api-key");
    expect(result.content).not.toContain("hunter2");
    expect(result.content).not.toContain("postgres://user:pass");
  });

  it("returns unchanged content when no secrets found", () => {
    const input = `
      const x = 1;
      function add(a, b) {
        return a + b;
      }
      // Just some normal code
    `;
    const result = redactSecrets(input);

    expect(result.content).toBe(input);
    expect(result.redactionCount).toBe(0);
    expect(result.redactedTypes).toHaveLength(0);
  });

  it("does not flag short passwords", () => {
    // Short passwords (< 8 chars) shouldn't match to avoid false positives
    const input = 'password: "short"';
    const result = redactSecrets(input);

    // This should NOT be redacted because it's too short
    expect(result.redactionCount).toBe(0);
  });

  it("handles empty content", () => {
    const result = redactSecrets("");

    expect(result.content).toBe("");
    expect(result.redactionCount).toBe(0);
    expect(result.redactedTypes).toHaveLength(0);
  });

  it("preserves surrounding content", () => {
    const input = 'const before = 1;\nconst key = "ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx1234";\nconst after = 2;';
    const result = redactSecrets(input);

    expect(result.content).toContain("const before = 1;");
    expect(result.content).toContain("const after = 2;");
    expect(result.content).toContain("[REDACTED:github_token]");
  });
});

describe("containsSecrets", () => {
  it("returns true when secrets are present", () => {
    expect(containsSecrets('api_key: "my-secret-key-12345"')).toBe(true);
    expect(containsSecrets("AKIAIOSFODNN7EXAMPLE")).toBe(true);
    expect(containsSecrets("ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx1234")).toBe(true);
  });

  it("returns false when no secrets are present", () => {
    expect(containsSecrets("const x = 1;")).toBe(false);
    expect(containsSecrets("function hello() {}")).toBe(false);
    expect(containsSecrets("// just a comment")).toBe(false);
  });

  it("returns false for empty content", () => {
    expect(containsSecrets("")).toBe(false);
  });
});

describe("getSecretPatternNames", () => {
  it("returns list of pattern names", () => {
    const names = getSecretPatternNames();

    expect(names).toContain("api_key");
    expect(names).toContain("aws_key");
    expect(names).toContain("jwt");
    expect(names).toContain("github_token");
    expect(names).toContain("private_key");
    expect(names.length).toBeGreaterThan(5);
  });
});
