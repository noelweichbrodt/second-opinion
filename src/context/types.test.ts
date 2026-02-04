import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "path";
import {
  extractTypeImports,
  isTypeFile,
  findAllTypeFiles,
  findTypeFilesForFiles,
} from "./types.js";
import {
  createTempDir,
  cleanupTempDir,
  createProjectStructure,
} from "../test-utils.js";

describe("extractTypeImports", () => {
  it("extracts import type { X } from statements", () => {
    const code = `import type { User } from './types';`;
    const imports = extractTypeImports(code);

    expect(imports).toContain("./types");
  });

  it("extracts import { type X } from statements", () => {
    const code = `import { type Config, loadConfig } from './config';`;
    const imports = extractTypeImports(code);

    expect(imports).toContain("./config");
  });

  it("extracts imports from type-ish locations", () => {
    const code = `
      import { User } from './types/user';
      import { Order } from '../interfaces/order';
      import { Product } from './models/product';
    `;
    const imports = extractTypeImports(code);

    expect(imports).toContain("./types/user");
    expect(imports).toContain("../interfaces/order");
    expect(imports).toContain("./models/product");
  });

  it("extracts multiple type imports", () => {
    const code = `
      import type { A } from './a';
      import type { B } from './b';
      import { type C } from './c';
    `;
    const imports = extractTypeImports(code);

    expect(imports).toContain("./a");
    expect(imports).toContain("./b");
    expect(imports).toContain("./c");
  });

  it("returns empty array for code without type imports", () => {
    const code = `
      import { foo } from './foo';
      import bar from './bar';
    `;
    const imports = extractTypeImports(code);

    // These don't match type import patterns
    expect(imports.length).toBe(0);
  });

  it("deduplicates imports", () => {
    const code = `
      import type { A } from './types';
      import type { B } from './types';
    `;
    const imports = extractTypeImports(code);

    expect(imports.filter((i) => i === "./types")).toHaveLength(1);
  });
});

describe("isTypeFile", () => {
  it("detects .d.ts files", () => {
    expect(isTypeFile("/project/types.d.ts")).toBe(true);
    expect(isTypeFile("/project/global.d.ts")).toBe(true);
    expect(isTypeFile("/project/src/custom.d.ts")).toBe(true);
  });

  it("detects files in /types/ directory", () => {
    expect(isTypeFile("/project/types/user.ts")).toBe(true);
    expect(isTypeFile("/project/src/types/config.ts")).toBe(true);
  });

  it("detects files in /interfaces/ directory", () => {
    expect(isTypeFile("/project/interfaces/order.ts")).toBe(true);
    expect(isTypeFile("/project/src/interfaces/api.ts")).toBe(true);
  });

  it("detects files in /models/ directory", () => {
    expect(isTypeFile("/project/models/product.ts")).toBe(true);
    expect(isTypeFile("/project/src/models/user.ts")).toBe(true);
  });

  it("detects files in /@types/ directory", () => {
    expect(isTypeFile("/project/@types/custom.ts")).toBe(true);
    expect(isTypeFile("/project/src/@types/lib.ts")).toBe(true);
  });

  it("detects types.ts and type.ts files", () => {
    expect(isTypeFile("/project/src/types.ts")).toBe(true);
    expect(isTypeFile("/project/src/type.ts")).toBe(true);
    expect(isTypeFile("/project/config/types.js")).toBe(true);
  });

  it("detects interfaces.ts and interface.ts files", () => {
    expect(isTypeFile("/project/src/interfaces.ts")).toBe(true);
    expect(isTypeFile("/project/src/interface.ts")).toBe(true);
  });

  it("returns false for regular source files", () => {
    expect(isTypeFile("/project/src/index.ts")).toBe(false);
    expect(isTypeFile("/project/src/utils/helper.ts")).toBe(false);
    expect(isTypeFile("/project/lib/api.js")).toBe(false);
  });

  it("is case insensitive", () => {
    expect(isTypeFile("/project/TYPES/User.ts")).toBe(true);
    expect(isTypeFile("/project/Types/User.ts")).toBe(true);
    expect(isTypeFile("/project/src/Types.ts")).toBe(true);
  });
});

describe("findAllTypeFiles", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = createTempDir("types-finder");

    createProjectStructure(tmpDir, {
      // Type definition files
      "types/user.ts": "export interface User {}",
      "types/config.ts": "export interface Config {}",
      "src/types/api.ts": "export interface ApiResponse {}",
      "interfaces/order.ts": "export interface Order {}",
      "src/interfaces/product.ts": "export interface Product {}",
      "models/entity.ts": "export interface Entity {}",
      "@types/custom.ts": "export type Custom = string;",

      // .d.ts files
      "global.d.ts": "declare global {}",
      "src/custom.d.ts": "declare module 'custom' {}",

      // Non-type files (should not be found)
      "src/index.ts": "export const main = 1;",
      "src/utils/helper.ts": "export function helper() {}",

      // Files that should be ignored
      "node_modules/types/lib.ts": "export interface Lib {}",
      "dist/types/output.ts": "export interface Output {}",
    });
  });

  afterAll(() => {
    cleanupTempDir(tmpDir);
  });

  it("finds files in types/ directory", async () => {
    const files = await findAllTypeFiles(tmpDir);

    expect(files.some((f) => f.includes("types/user.ts"))).toBe(true);
    expect(files.some((f) => f.includes("types/config.ts"))).toBe(true);
  });

  it("finds files in src/types/ directory", async () => {
    const files = await findAllTypeFiles(tmpDir);

    expect(files.some((f) => f.includes("src/types/api.ts"))).toBe(true);
  });

  it("finds files in interfaces/ directory", async () => {
    const files = await findAllTypeFiles(tmpDir);

    expect(files.some((f) => f.includes("interfaces/order.ts"))).toBe(true);
  });

  it("finds files in models/ directory", async () => {
    const files = await findAllTypeFiles(tmpDir);

    expect(files.some((f) => f.includes("models/entity.ts"))).toBe(true);
  });

  it("finds .d.ts files", async () => {
    const files = await findAllTypeFiles(tmpDir);

    expect(files.some((f) => f.endsWith(".d.ts"))).toBe(true);
  });

  it("excludes node_modules", async () => {
    const files = await findAllTypeFiles(tmpDir);

    expect(files.every((f) => !f.includes("node_modules"))).toBe(true);
  });

  it("excludes dist directory", async () => {
    const files = await findAllTypeFiles(tmpDir);

    expect(files.every((f) => !f.includes("dist"))).toBe(true);
  });

  it("returns absolute paths", async () => {
    const files = await findAllTypeFiles(tmpDir);

    for (const file of files) {
      expect(path.isAbsolute(file)).toBe(true);
    }
  });

  it("only returns TypeScript/JavaScript files", async () => {
    const files = await findAllTypeFiles(tmpDir);

    for (const file of files) {
      expect(file).toMatch(/\.(ts|tsx|js|jsx)$/);
    }
  });
});

describe("findTypeFilesForFiles", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = createTempDir("types-for-files");

    createProjectStructure(tmpDir, {
      // Type files
      "src/types/user.ts": "export interface User { name: string; }",
      "src/types/config.ts": "export interface Config { debug: boolean; }",
      "src/models/product.ts": "export interface Product { id: number; }",

      // Source files that import types
      "src/services/auth.ts": `
        import type { User } from '../types/user';
        import { login } from './api';
        export function authenticate(user: User) {}
      `,
      "src/services/settings.ts": `
        import type { Config } from '../types/config';
        export function loadSettings(): Config {}
      `,

      // Source file that imports from models
      "src/api/products.ts": `
        import { Product } from '../models/product';
        export function getProducts(): Product[] {}
      `,

      // Source file without type imports
      "src/utils/helper.ts": `
        export function helper() { return 1; }
      `,
    });
  });

  afterAll(() => {
    cleanupTempDir(tmpDir);
  });

  it("finds type files imported by source files", async () => {
    const types = await findTypeFilesForFiles(
      [path.join(tmpDir, "src/services/auth.ts")],
      tmpDir
    );

    expect(types.some((t) => t.includes("types/user.ts"))).toBe(true);
  });

  it("finds type files from multiple source files", async () => {
    const types = await findTypeFilesForFiles(
      [
        path.join(tmpDir, "src/services/auth.ts"),
        path.join(tmpDir, "src/services/settings.ts"),
      ],
      tmpDir
    );

    expect(types.some((t) => t.includes("types/user.ts"))).toBe(true);
    expect(types.some((t) => t.includes("types/config.ts"))).toBe(true);
  });

  it("finds models as type files", async () => {
    const types = await findTypeFilesForFiles(
      [path.join(tmpDir, "src/api/products.ts")],
      tmpDir
    );

    expect(types.some((t) => t.includes("models/product.ts"))).toBe(true);
  });

  it("excludes input files from results", async () => {
    // If a type file is in the input, it shouldn't be in results
    const types = await findTypeFilesForFiles(
      [
        path.join(tmpDir, "src/services/auth.ts"),
        path.join(tmpDir, "src/types/user.ts"), // Already in input
      ],
      tmpDir
    );

    expect(types).not.toContainEqual(
      path.join(tmpDir, "src/types/user.ts")
    );
  });

  it("returns empty array for files without type imports", async () => {
    const types = await findTypeFilesForFiles(
      [path.join(tmpDir, "src/utils/helper.ts")],
      tmpDir
    );

    expect(types).toEqual([]);
  });

  it("handles non-existent files gracefully", async () => {
    const types = await findTypeFilesForFiles(
      [path.join(tmpDir, "src/nonexistent.ts")],
      tmpDir
    );

    expect(types).toEqual([]);
  });

  it("handles empty input array", async () => {
    const types = await findTypeFilesForFiles([], tmpDir);

    expect(types).toEqual([]);
  });
});
