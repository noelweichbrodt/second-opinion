import * as fs from "fs";
import * as path from "path";

/**
 * Find test files that correspond to a given source file
 *
 * Checks common test file patterns:
 * - foo.ts -> foo.test.ts, foo.spec.ts
 * - foo.ts -> __tests__/foo.ts, __tests__/foo.test.ts
 * - src/foo.ts -> tests/foo.test.ts, test/foo.test.ts
 */
export function findTestFiles(
  filePath: string,
  projectPath: string
): string[] {
  const testFiles: string[] = [];
  const ext = path.extname(filePath);
  const baseName = path.basename(filePath, ext);
  const dir = path.dirname(filePath);
  const relativeDir = path.relative(projectPath, dir);

  // Common test extensions
  const testExtensions = [".test" + ext, ".spec" + ext, ext];

  // Pattern 1: Same directory - foo.test.ts, foo.spec.ts
  for (const testExt of [".test" + ext, ".spec" + ext]) {
    const candidate = path.join(dir, baseName + testExt);
    if (fs.existsSync(candidate)) {
      testFiles.push(candidate);
    }
  }

  // Pattern 2: __tests__ directory in same location
  const testsDir = path.join(dir, "__tests__");
  if (fs.existsSync(testsDir)) {
    for (const testExt of testExtensions) {
      const candidate = path.join(testsDir, baseName + testExt);
      if (fs.existsSync(candidate)) {
        testFiles.push(candidate);
      }
    }
  }

  // Pattern 3: Top-level tests/ or test/ directory mirroring src structure
  const testRootDirs = ["tests", "test", "__tests__"];
  for (const testRoot of testRootDirs) {
    const testRootPath = path.join(projectPath, testRoot);
    if (fs.existsSync(testRootPath)) {
      // Try to mirror the relative path
      // e.g., src/auth/login.ts -> tests/auth/login.test.ts
      let mirrorPath = relativeDir;
      if (mirrorPath.startsWith("src/") || mirrorPath.startsWith("src\\")) {
        mirrorPath = mirrorPath.slice(4);
      }

      const mirrorDir = path.join(testRootPath, mirrorPath);
      if (fs.existsSync(mirrorDir)) {
        for (const testExt of testExtensions) {
          const candidate = path.join(mirrorDir, baseName + testExt);
          if (fs.existsSync(candidate)) {
            testFiles.push(candidate);
          }
        }
      }

      // Also try without mirroring - just tests/foo.test.ts
      for (const testExt of testExtensions) {
        const candidate = path.join(testRootPath, baseName + testExt);
        if (fs.existsSync(candidate)) {
          testFiles.push(candidate);
        }
      }
    }
  }

  // Deduplicate
  return [...new Set(testFiles)];
}

/**
 * Find test files for multiple source files
 */
export function findTestFilesForFiles(
  files: string[],
  projectPath: string
): string[] {
  const allTests = new Set<string>();

  for (const file of files) {
    const tests = findTestFiles(file, projectPath);
    for (const test of tests) {
      // Don't include if it's already in our file list
      if (!files.includes(test)) {
        allTests.add(test);
      }
    }
  }

  return Array.from(allTests);
}
