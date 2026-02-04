import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  extractImports,
  isWithinProject,
  resolveImportPath,
  getDependencies,
  getDependenciesForFiles,
  buildImportIndex,
  getDependentsFromIndex,
  getDependentsForFiles,
} from "./imports.js";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { createTempDir, cleanupTempDir, createProjectStructure } from "../test-utils.js";

describe("extractImports", () => {
  it("extracts ES6 default imports", () => {
    const code = `import foo from './foo';`;
    expect(extractImports(code)).toContain("./foo");
  });

  it("extracts ES6 named imports", () => {
    const code = `import { bar, baz } from './utils';`;
    expect(extractImports(code)).toContain("./utils");
  });

  it("extracts ES6 namespace imports", () => {
    const code = `import * as helpers from './helpers';`;
    expect(extractImports(code)).toContain("./helpers");
  });

  it("extracts dynamic imports", () => {
    const code = `const module = await import('./dynamic');`;
    expect(extractImports(code)).toContain("./dynamic");
  });

  it("extracts CommonJS requires", () => {
    const code = `const fs = require('fs');`;
    expect(extractImports(code)).toContain("fs");
  });

  it("extracts export from statements", () => {
    const code = `export { foo } from './foo';`;
    expect(extractImports(code)).toContain("./foo");
  });

  it("extracts multiple imports from same file", () => {
    const code = `
      import foo from './foo';
      import { bar } from './bar';
      const baz = require('./baz');
    `;
    const imports = extractImports(code);
    expect(imports).toContain("./foo");
    expect(imports).toContain("./bar");
    expect(imports).toContain("./baz");
  });

  it("deduplicates imports", () => {
    const code = `
      import foo from './foo';
      import { bar } from './foo';
    `;
    const imports = extractImports(code);
    expect(imports.filter((i) => i === "./foo")).toHaveLength(1);
  });
});

describe("isWithinProject", () => {
  it("returns true for files inside project", () => {
    expect(isWithinProject("/project/src/file.ts", "/project")).toBe(true);
  });

  it("returns true for project root itself", () => {
    expect(isWithinProject("/project", "/project")).toBe(true);
  });

  it("returns false for files outside project", () => {
    expect(isWithinProject("/other/file.ts", "/project")).toBe(false);
  });

  it("returns false for sibling directories with similar names", () => {
    expect(isWithinProject("/project-other/file.ts", "/project")).toBe(false);
  });

  it("handles path traversal attempts", () => {
    expect(isWithinProject("/project/../other/file.ts", "/project")).toBe(false);
  });
});

describe("resolveImportPath", () => {
  // These tests need a temp directory with actual files
  const tmpDir = path.join(os.tmpdir(), "imports-test-" + Date.now());

  // Create test files before tests
  beforeAll(() => {
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "foo.ts"), "export const foo = 1;");
    fs.writeFileSync(path.join(tmpDir, "src", "index.ts"), "export * from './foo';");
    fs.mkdirSync(path.join(tmpDir, "src", "utils"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "utils", "index.ts"), "export const util = 1;");
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resolves relative imports", () => {
    const result = resolveImportPath(
      "./foo",
      path.join(tmpDir, "src", "index.ts"),
      tmpDir
    );
    expect(result).toBe(path.join(tmpDir, "src", "foo.ts"));
  });

  it("resolves directory imports to index file", () => {
    const result = resolveImportPath(
      "./utils",
      path.join(tmpDir, "src", "index.ts"),
      tmpDir
    );
    expect(result).toBe(path.join(tmpDir, "src", "utils", "index.ts"));
  });

  it("returns null for node_modules imports", () => {
    const result = resolveImportPath(
      "lodash",
      path.join(tmpDir, "src", "index.ts"),
      tmpDir
    );
    expect(result).toBeNull();
  });

  it("returns null for non-existent files", () => {
    const result = resolveImportPath(
      "./nonexistent",
      path.join(tmpDir, "src", "index.ts"),
      tmpDir
    );
    expect(result).toBeNull();
  });
});

describe("getDependencies", () => {
  const tmpDir = path.join(os.tmpdir(), "deps-test-" + Date.now());

  beforeAll(() => {
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "src", "main.ts"),
      `import { foo } from './foo';\nimport { bar } from './bar';`
    );
    fs.writeFileSync(path.join(tmpDir, "src", "foo.ts"), "export const foo = 1;");
    fs.writeFileSync(path.join(tmpDir, "src", "bar.ts"), "export const bar = 2;");
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns all resolved dependencies", () => {
    const deps = getDependencies(path.join(tmpDir, "src", "main.ts"), tmpDir);
    expect(deps).toContain(path.join(tmpDir, "src", "foo.ts"));
    expect(deps).toContain(path.join(tmpDir, "src", "bar.ts"));
  });

  it("returns empty array for non-existent file", () => {
    const deps = getDependencies(path.join(tmpDir, "nonexistent.ts"), tmpDir);
    expect(deps).toEqual([]);
  });
});

describe("getDependenciesForFiles", () => {
  const tmpDir = path.join(os.tmpdir(), "multi-deps-test-" + Date.now());

  beforeAll(() => {
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "src", "a.ts"),
      `import { shared } from './shared';`
    );
    fs.writeFileSync(
      path.join(tmpDir, "src", "b.ts"),
      `import { shared } from './shared';`
    );
    fs.writeFileSync(path.join(tmpDir, "src", "shared.ts"), "export const shared = 1;");
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("collects dependencies from multiple files", () => {
    const deps = getDependenciesForFiles(
      [path.join(tmpDir, "src", "a.ts"), path.join(tmpDir, "src", "b.ts")],
      tmpDir
    );
    expect(deps).toContain(path.join(tmpDir, "src", "shared.ts"));
  });

  it("excludes files already in the input list", () => {
    const deps = getDependenciesForFiles(
      [
        path.join(tmpDir, "src", "a.ts"),
        path.join(tmpDir, "src", "shared.ts"),
      ],
      tmpDir
    );
    expect(deps).not.toContain(path.join(tmpDir, "src", "shared.ts"));
  });

  it("deduplicates dependencies", () => {
    const deps = getDependenciesForFiles(
      [path.join(tmpDir, "src", "a.ts"), path.join(tmpDir, "src", "b.ts")],
      tmpDir
    );
    const sharedCount = deps.filter((d) =>
      d.endsWith("shared.ts")
    ).length;
    expect(sharedCount).toBe(1);
  });
});

describe("buildImportIndex", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = createTempDir("import-index");

    createProjectStructure(tmpDir, {
      // Library file imported by multiple consumers
      "src/lib/utils.ts": "export function helper() {}",
      "src/lib/constants.ts": "export const API_URL = 'http://api.test';",

      // Consumers
      "src/services/auth.ts": `
        import { helper } from '../lib/utils';
        import { API_URL } from '../lib/constants';
        export function login() { return helper(); }
      `,
      "src/services/api.ts": `
        import { helper } from '../lib/utils';
        export function fetchData() { return helper(); }
      `,
      "src/components/App.ts": `
        import { API_URL } from '../lib/constants';
        export const App = () => API_URL;
      `,

      // No imports
      "src/index.ts": "export const main = 1;",
    });
  });

  afterAll(() => {
    cleanupTempDir(tmpDir);
  });

  it("builds reverse dependency map", async () => {
    const index = await buildImportIndex(tmpDir);

    expect(index.importedBy).toBeInstanceOf(Map);
  });

  it("tracks files that import a given file", async () => {
    const index = await buildImportIndex(tmpDir);
    const utilsPath = path.join(tmpDir, "src/lib/utils.ts");

    const importedBy = index.importedBy.get(utilsPath);

    expect(importedBy).toBeDefined();
    expect(importedBy?.size).toBe(2); // auth.ts and api.ts
  });

  it("excludes node_modules from index", async () => {
    // Create a node_modules file that imports something
    createProjectStructure(tmpDir, {
      "node_modules/pkg/index.ts": "import { helper } from '../../src/lib/utils';",
    });

    const index = await buildImportIndex(tmpDir);

    // The import from node_modules should not be tracked
    const utilsPath = path.join(tmpDir, "src/lib/utils.ts");
    const importedBy = index.importedBy.get(utilsPath);

    // Should still only have 2 importers (auth.ts, api.ts) - not the node_modules file
    expect(importedBy?.size).toBe(2);
  });

  it("returns empty map for files not imported by anything", async () => {
    const index = await buildImportIndex(tmpDir);
    const indexPath = path.join(tmpDir, "src/index.ts");

    const importedBy = index.importedBy.get(indexPath);

    expect(importedBy).toBeUndefined();
  });
});

describe("getDependentsFromIndex", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = createTempDir("dependents-from-index");

    createProjectStructure(tmpDir, {
      "src/shared.ts": "export const shared = 1;",
      "src/a.ts": "import { shared } from './shared';",
      "src/b.ts": "import { shared } from './shared';",
      "src/c.ts": "import { a } from './a';",
    });
  });

  afterAll(() => {
    cleanupTempDir(tmpDir);
  });

  it("returns files that import the given files", async () => {
    const index = await buildImportIndex(tmpDir);
    const dependents = getDependentsFromIndex(
      [path.join(tmpDir, "src/shared.ts")],
      index
    );

    expect(dependents).toContainEqual(expect.stringContaining("a.ts"));
    expect(dependents).toContainEqual(expect.stringContaining("b.ts"));
  });

  it("excludes input files from results", async () => {
    const index = await buildImportIndex(tmpDir);
    const sharedPath = path.join(tmpDir, "src/shared.ts");
    const aPath = path.join(tmpDir, "src/a.ts");

    const dependents = getDependentsFromIndex(
      [sharedPath, aPath], // a.ts imports shared, but a.ts is in input
      index
    );

    expect(dependents).not.toContainEqual(aPath);
    expect(dependents).toContainEqual(expect.stringContaining("b.ts"));
  });

  it("returns empty array for files not imported by anything", async () => {
    const index = await buildImportIndex(tmpDir);
    const dependents = getDependentsFromIndex(
      [path.join(tmpDir, "src/c.ts")],
      index
    );

    expect(dependents).toEqual([]);
  });

  it("deduplicates results", async () => {
    const index = await buildImportIndex(tmpDir);
    const sharedPath = path.join(tmpDir, "src/shared.ts");

    const dependents = getDependentsFromIndex([sharedPath], index);
    const uniqueDependents = new Set(dependents);

    expect(dependents.length).toBe(uniqueDependents.size);
  });
});

describe("getDependentsForFiles", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = createTempDir("dependents-for-files");

    createProjectStructure(tmpDir, {
      "src/lib/core.ts": "export function core() {}",
      "src/services/user.ts": "import { core } from '../lib/core';",
      "src/services/order.ts": "import { core } from '../lib/core';",
      "src/index.ts": "import { user } from './services/user';",
    });
  });

  afterAll(() => {
    cleanupTempDir(tmpDir);
  });

  it("finds all files that import given files", async () => {
    const dependents = await getDependentsForFiles(
      [path.join(tmpDir, "src/lib/core.ts")],
      tmpDir
    );

    expect(dependents).toContainEqual(expect.stringContaining("user.ts"));
    expect(dependents).toContainEqual(expect.stringContaining("order.ts"));
  });

  it("handles multiple input files", async () => {
    const dependents = await getDependentsForFiles(
      [
        path.join(tmpDir, "src/lib/core.ts"),
        path.join(tmpDir, "src/services/user.ts"),
      ],
      tmpDir
    );

    // order.ts depends on core.ts, index.ts depends on user.ts
    expect(dependents).toContainEqual(expect.stringContaining("order.ts"));
    expect(dependents).toContainEqual(expect.stringContaining("index.ts"));
  });

  it("returns empty array for empty input", async () => {
    const dependents = await getDependentsForFiles([], tmpDir);

    expect(dependents).toEqual([]);
  });

  it("returns absolute paths", async () => {
    const dependents = await getDependentsForFiles(
      [path.join(tmpDir, "src/lib/core.ts")],
      tmpDir
    );

    for (const dep of dependents) {
      expect(path.isAbsolute(dep)).toBe(true);
    }
  });
});
