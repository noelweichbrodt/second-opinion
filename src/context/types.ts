import * as fs from "fs";
import * as path from "path";
import { glob } from "glob";
import { resolveImportPath } from "./imports.js";

// Patterns for type imports
const TYPE_IMPORT_PATTERNS = [
  // import type { X } from 'y'
  /import\s+type\s+\{[^}]+\}\s+from\s+['"]([^'"]+)['"]/g,
  // import { type X } from 'y'
  /import\s+\{[^}]*type\s+\w+[^}]*\}\s+from\s+['"]([^'"]+)['"]/g,
  // Regular imports from type-ish locations
  /import\s+(?:[\w*{}\s,]+\s+from\s+)?['"]([^'"]*(?:types?|interfaces?|models?)[^'"]*)['"]/gi,
];

// Common type file/directory patterns
const TYPE_LOCATIONS = [
  "types",
  "types/**",
  "interfaces",
  "interfaces/**",
  "models",
  "models/**",
  "@types",
  "@types/**",
  "src/types",
  "src/types/**",
  "src/interfaces",
  "src/interfaces/**",
  "**/*.d.ts",
];

/**
 * Extract type-related imports from file content
 */
export function extractTypeImports(content: string): string[] {
  const typeImports = new Set<string>();

  for (const pattern of TYPE_IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      typeImports.add(match[1]);
    }
  }

  return Array.from(typeImports);
}

/**
 * Check if a file path looks like a type definition file
 */
export function isTypeFile(filePath: string): boolean {
  const normalized = filePath.toLowerCase();
  return (
    normalized.endsWith(".d.ts") ||
    normalized.includes("/types/") ||
    normalized.includes("/interfaces/") ||
    normalized.includes("/models/") ||
    normalized.includes("/@types/") ||
    /\/types?\.(ts|js)$/.test(normalized) ||
    /\/interfaces?\.(ts|js)$/.test(normalized)
  );
}

/**
 * Find all type definition files in a project
 */
export async function findAllTypeFiles(projectPath: string): Promise<string[]> {
  const typeFiles = await glob(TYPE_LOCATIONS, {
    cwd: projectPath,
    absolute: true,
    nodir: true,
    ignore: ["**/node_modules/**", "**/dist/**", "**/build/**"],
  });

  return typeFiles.filter((f) => /\.(ts|tsx|js|jsx)$/.test(f));
}

/**
 * Find type files that are imported by the given files
 */
export async function findTypeFilesForFiles(
  files: string[],
  projectPath: string
): Promise<string[]> {
  const typeFiles = new Set<string>();

  // Get all type files in the project
  const allTypes = await findAllTypeFiles(projectPath);
  const typeFileSet = new Set(allTypes);

  for (const file of files) {
    if (!fs.existsSync(file)) continue;

    try {
      const content = fs.readFileSync(file, "utf-8");
      const typeImports = extractTypeImports(content);

      // Also check regular imports that resolve to type files
      const allImportPattern =
        /import\s+(?:[\w*{}\s,]+\s+from\s+)?['"]([^'"]+)['"]/g;
      let match;
      while ((match = allImportPattern.exec(content)) !== null) {
        const importPath = match[1];
        const resolved = resolveImportPath(importPath, file, projectPath);

        if (resolved && (typeFileSet.has(resolved) || isTypeFile(resolved))) {
          if (!files.includes(resolved)) {
            typeFiles.add(resolved);
          }
        }
      }
    } catch {
      // Skip files that can't be read
    }
  }

  return Array.from(typeFiles);
}
