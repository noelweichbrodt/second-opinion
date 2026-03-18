import { describe, it, expect } from "vitest";
import { detectDominantLanguage, getLanguageHints } from "./language.js";

describe("detectDominantLanguage", () => {
  it("detects TypeScript as dominant language", () => {
    const files = [
      "/project/src/index.ts",
      "/project/src/utils.ts",
      "/project/src/types.ts",
      "/project/package.json",
    ];
    expect(detectDominantLanguage(files)).toBe("typescript");
  });

  it("detects Python as dominant language", () => {
    const files = [
      "/project/app.py",
      "/project/models.py",
      "/project/tests/test_app.py",
    ];
    expect(detectDominantLanguage(files)).toBe("python");
  });

  it("detects Go as dominant language", () => {
    const files = ["/project/main.go", "/project/handler.go"];
    expect(detectDominantLanguage(files)).toBe("go");
  });

  it("detects Rust as dominant language", () => {
    const files = ["/project/src/main.rs", "/project/src/lib.rs"];
    expect(detectDominantLanguage(files)).toBe("rust");
  });

  it("treats TSX as TypeScript", () => {
    const files = [
      "/project/src/App.tsx",
      "/project/src/Component.tsx",
    ];
    expect(detectDominantLanguage(files)).toBe("typescript");
  });

  it("treats JSX as JavaScript", () => {
    const files = [
      "/project/src/App.jsx",
      "/project/src/Component.jsx",
    ];
    expect(detectDominantLanguage(files)).toBe("javascript");
  });

  it("returns null for empty file list", () => {
    expect(detectDominantLanguage([])).toBeNull();
  });

  it("returns null for unrecognized extensions", () => {
    const files = ["/project/data.csv", "/project/config.yaml"];
    expect(detectDominantLanguage(files)).toBeNull();
  });

  it("picks the language with most files", () => {
    const files = [
      "/project/main.go",
      "/project/src/index.ts",
      "/project/src/utils.ts",
      "/project/src/types.ts",
    ];
    expect(detectDominantLanguage(files)).toBe("typescript");
  });
});

describe("getLanguageHints", () => {
  it("returns hints for TypeScript", () => {
    const hints = getLanguageHints("typescript");
    expect(hints).not.toBeNull();
    expect(hints).toContain("TypeScript-Specific Pitfalls");
    expect(hints).toContain("any");
    expect(hints).toContain("await");
  });

  it("returns hints for Python", () => {
    const hints = getLanguageHints("python");
    expect(hints).not.toBeNull();
    expect(hints).toContain("Python-Specific Pitfalls");
    expect(hints).toContain("mutable default");
  });

  it("returns hints for Go", () => {
    const hints = getLanguageHints("go");
    expect(hints).not.toBeNull();
    expect(hints).toContain("Go-Specific Pitfalls");
    expect(hints).toContain("error");
  });

  it("returns hints for Rust", () => {
    const hints = getLanguageHints("rust");
    expect(hints).not.toBeNull();
    expect(hints).toContain("Rust-Specific Pitfalls");
    expect(hints).toContain("unwrap");
  });

  it("returns null for unknown language", () => {
    expect(getLanguageHints("cobol")).toBeNull();
  });

  it("formats hints as markdown list", () => {
    const hints = getLanguageHints("typescript")!;
    const lines = hints.split("\n");
    // Should have header, blank line, description, blank line, then bullet items
    expect(lines[0]).toMatch(/^## /);
    expect(lines.filter((l) => l.startsWith("- ")).length).toBeGreaterThanOrEqual(3);
  });
});
