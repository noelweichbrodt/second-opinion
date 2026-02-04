import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "path";
import { findTestFiles, findTestFilesForFiles } from "./tests.js";
import {
  createTempDir,
  cleanupTempDir,
  createProjectStructure,
} from "../test-utils.js";

describe("findTestFiles", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = createTempDir("tests-finder");

    // Create a comprehensive test project structure
    createProjectStructure(tmpDir, {
      // Source files
      "src/index.ts": "export const main = 1;",
      "src/utils/helper.ts": "export function helper() {}",
      "src/auth/login.ts": "export function login() {}",
      "src/api/client.ts": "export class ApiClient {}",

      // Pattern 1: Same directory - foo.test.ts, foo.spec.ts
      "src/index.test.ts": "test('index', () => {});",
      "src/utils/helper.spec.ts": "test('helper', () => {});",

      // Pattern 2: __tests__ directory
      "src/__tests__/index.ts": "test('index', () => {});",
      "src/__tests__/index.test.ts": "test('index', () => {});",
      "src/utils/__tests__/helper.ts": "test('helper', () => {});",

      // Pattern 3: Top-level test directories
      "tests/auth/login.test.ts": "test('login', () => {});",
      "test/api/client.test.ts": "test('client', () => {});",
      "__tests__/index.test.ts": "test('index', () => {});",
    });
  });

  afterAll(() => {
    cleanupTempDir(tmpDir);
  });

  it("finds foo.test.ts in same directory", () => {
    const tests = findTestFiles(
      path.join(tmpDir, "src/index.ts"),
      tmpDir
    );

    expect(tests).toContainEqual(
      expect.stringContaining("index.test.ts")
    );
  });

  it("finds foo.spec.ts in same directory", () => {
    const tests = findTestFiles(
      path.join(tmpDir, "src/utils/helper.ts"),
      tmpDir
    );

    expect(tests).toContainEqual(
      expect.stringContaining("helper.spec.ts")
    );
  });

  it("finds __tests__/foo.ts", () => {
    const tests = findTestFiles(
      path.join(tmpDir, "src/index.ts"),
      tmpDir
    );

    expect(tests.some((t) =>
      t.includes("__tests__") && t.endsWith("index.ts")
    )).toBe(true);
  });

  it("finds __tests__/foo.test.ts", () => {
    const tests = findTestFiles(
      path.join(tmpDir, "src/index.ts"),
      tmpDir
    );

    expect(tests.some((t) =>
      t.includes("__tests__") && t.includes("index.test.ts")
    )).toBe(true);
  });

  it("finds tests/foo.test.ts with src mirroring", () => {
    const tests = findTestFiles(
      path.join(tmpDir, "src/auth/login.ts"),
      tmpDir
    );

    expect(tests).toContainEqual(
      expect.stringContaining("tests/auth/login.test.ts")
    );
  });

  it("finds test/foo.test.ts with src mirroring", () => {
    const tests = findTestFiles(
      path.join(tmpDir, "src/api/client.ts"),
      tmpDir
    );

    expect(tests).toContainEqual(
      expect.stringContaining("test/api/client.test.ts")
    );
  });

  it("deduplicates results", () => {
    const tests = findTestFiles(
      path.join(tmpDir, "src/index.ts"),
      tmpDir
    );

    const uniqueTests = new Set(tests);
    expect(tests.length).toBe(uniqueTests.size);
  });

  it("returns empty array for file with no tests", () => {
    // Create a file with no corresponding tests
    createProjectStructure(tmpDir, {
      "src/orphan/lonely.ts": "export const lonely = 1;",
    });

    const tests = findTestFiles(
      path.join(tmpDir, "src/orphan/lonely.ts"),
      tmpDir
    );

    expect(tests).toEqual([]);
  });

  it("returns absolute paths", () => {
    const tests = findTestFiles(
      path.join(tmpDir, "src/index.ts"),
      tmpDir
    );

    for (const test of tests) {
      expect(path.isAbsolute(test)).toBe(true);
    }
  });
});

describe("findTestFilesForFiles", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = createTempDir("tests-multi");

    createProjectStructure(tmpDir, {
      // Source files
      "src/a.ts": "export const a = 1;",
      "src/b.ts": "export const b = 1;",
      "src/c.ts": "export const c = 1;",

      // Test files
      "src/a.test.ts": "test('a', () => {});",
      "src/b.test.ts": "test('b', () => {});",
      "src/shared.test.ts": "test('shared', () => {});",
    });
  });

  afterAll(() => {
    cleanupTempDir(tmpDir);
  });

  it("collects tests for multiple files", () => {
    const tests = findTestFilesForFiles(
      [
        path.join(tmpDir, "src/a.ts"),
        path.join(tmpDir, "src/b.ts"),
      ],
      tmpDir
    );

    expect(tests.some((t) => t.includes("a.test.ts"))).toBe(true);
    expect(tests.some((t) => t.includes("b.test.ts"))).toBe(true);
  });

  it("excludes files already in the input list", () => {
    // Pass a.test.ts as both source and (potential) test
    const tests = findTestFilesForFiles(
      [
        path.join(tmpDir, "src/a.ts"),
        path.join(tmpDir, "src/a.test.ts"), // Already in list
      ],
      tmpDir
    );

    // a.test.ts should not be in results since it's in input
    expect(tests).not.toContainEqual(
      path.join(tmpDir, "src/a.test.ts")
    );
  });

  it("deduplicates across multiple files", () => {
    const tests = findTestFilesForFiles(
      [
        path.join(tmpDir, "src/a.ts"),
        path.join(tmpDir, "src/b.ts"),
      ],
      tmpDir
    );

    const uniqueTests = new Set(tests);
    expect(tests.length).toBe(uniqueTests.size);
  });

  it("returns empty array when no tests exist", () => {
    const tests = findTestFilesForFiles(
      [path.join(tmpDir, "src/c.ts")], // c.ts has no tests
      tmpDir
    );

    expect(tests).toEqual([]);
  });

  it("handles empty input array", () => {
    const tests = findTestFilesForFiles([], tmpDir);

    expect(tests).toEqual([]);
  });
});
