import * as fs from "fs";
import * as path from "path";
import { glob } from "glob";

// Regex patterns for different import styles
const IMPORT_PATTERNS = [
  // ES6 imports: import x from 'y', import { x } from 'y', import * as x from 'y'
  /import\s+(?:[\w*{}\s,]+\s+from\s+)?['"]([^'"]+)['"]/g,
  // ES6 dynamic imports: import('y')
  /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  // CommonJS requires: require('y')
  /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  // ES6 export from: export { x } from 'y'
  /export\s+(?:[\w*{}\s,]+\s+)?from\s+['"]([^'"]+)['"]/g,
];

// File extensions to consider for imports
const CODE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

/**
 * Extract import paths from a file's content
 */
export function extractImports(content: string): string[] {
  const imports = new Set<string>();

  for (const pattern of IMPORT_PATTERNS) {
    // Reset regex state
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      imports.add(match[1]);
    }
  }

  return Array.from(imports);
}

/**
 * Check if a path is within the project bounds
 * Resolves symlinks to handle cases like /var -> /private/var on macOS
 */
export function isWithinProject(
  filePath: string,
  projectPath: string
): boolean {
  // Use realpathSync to resolve symlinks (falls back to normalize if path doesn't exist)
  let realFile: string;
  let realProject: string;

  try {
    realFile = fs.realpathSync(filePath);
  } catch {
    realFile = path.normalize(path.resolve(filePath));
  }

  try {
    realProject = fs.realpathSync(projectPath);
  } catch {
    realProject = path.normalize(path.resolve(projectPath));
  }

  return realFile.startsWith(realProject + path.sep) ||
    realFile === realProject;
}

/**
 * Resolve an import path to an actual file path
 */
export function resolveImportPath(
  importPath: string,
  fromFile: string,
  projectPath: string
): string | null {
  // Skip node_modules and external packages
  if (
    !importPath.startsWith(".") &&
    !importPath.startsWith("/") &&
    !importPath.startsWith("@/")
  ) {
    return null;
  }

  const fromDir = path.dirname(fromFile);
  let targetPath: string;

  // Handle @ alias (common in many projects)
  if (importPath.startsWith("@/")) {
    targetPath = path.join(projectPath, "src", importPath.slice(2));
  } else if (importPath.startsWith("/")) {
    targetPath = path.join(projectPath, importPath);
  } else {
    targetPath = path.resolve(fromDir, importPath);
  }

  // Try with different extensions
  const candidates = [
    targetPath,
    ...CODE_EXTENSIONS.map((ext) => targetPath + ext),
    ...CODE_EXTENSIONS.map((ext) => path.join(targetPath, "index" + ext)),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      // Bounds check: ensure resolved path is within project
      if (!isWithinProject(candidate, projectPath)) {
        return null;
      }
      return candidate;
    }
  }

  return null;
}

/**
 * Get all files that a given file imports (dependencies)
 */
export function getDependencies(
  filePath: string,
  projectPath: string
): string[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const importPaths = extractImports(content);

    const dependencies: string[] = [];
    for (const importPath of importPaths) {
      const resolved = resolveImportPath(importPath, filePath, projectPath);
      if (resolved) {
        dependencies.push(resolved);
      }
    }

    return dependencies;
  } catch {
    return [];
  }
}

/**
 * Get dependencies for multiple files
 */
export function getDependenciesForFiles(
  files: string[],
  projectPath: string
): string[] {
  const allDeps = new Set<string>();

  for (const file of files) {
    const deps = getDependencies(file, projectPath);
    for (const dep of deps) {
      // Don't include files that are already in our modified set
      if (!files.includes(dep)) {
        allDeps.add(dep);
      }
    }
  }

  return Array.from(allDeps);
}

/**
 * Import index for efficient dependent lookups
 * Maps each file to the files that import it (reverse dependency map)
 */
export interface ImportIndex {
  // Reverse map: file -> files that import it
  importedBy: Map<string, Set<string>>;
}

/**
 * Build an import index for the project
 * Scans all files once and builds both forward and reverse dependency maps
 */
export async function buildImportIndex(
  projectPath: string
): Promise<ImportIndex> {
  const index: ImportIndex = {
    importedBy: new Map(),
  };

  // Get all code files in the project
  const patterns = CODE_EXTENSIONS.map((ext) => `**/*${ext}`);
  const allFiles = await glob(patterns, {
    cwd: projectPath,
    absolute: true,
    ignore: ["**/node_modules/**", "**/dist/**", "**/build/**", "**/.git/**"],
  });

  // Build the reverse dependency map by scanning each file once
  for (const file of allFiles) {
    try {
      const content = fs.readFileSync(file, "utf-8");
      const importPaths = extractImports(content);

      for (const importPath of importPaths) {
        const resolved = resolveImportPath(importPath, file, projectPath);
        if (resolved) {
          if (!index.importedBy.has(resolved)) {
            index.importedBy.set(resolved, new Set());
          }
          index.importedBy.get(resolved)!.add(file);
        }
      }
    } catch {
      // Skip files that can't be read
    }
  }

  return index;
}

/**
 * Get dependents for multiple files using a pre-built index
 * O(M) lookups instead of O(M*N) file reads
 */
export function getDependentsFromIndex(
  files: string[],
  index: ImportIndex
): string[] {
  const allDependents = new Set<string>();
  const fileSet = new Set(files);

  for (const file of files) {
    const dependents = index.importedBy.get(file);
    if (dependents) {
      for (const dep of dependents) {
        // Don't include files that are already in our modified set
        if (!fileSet.has(dep)) {
          allDependents.add(dep);
        }
      }
    }
  }

  return Array.from(allDependents);
}

/**
 * Get dependents for multiple files
 * Uses an index-based approach for better performance
 */
export async function getDependentsForFiles(
  files: string[],
  projectPath: string
): Promise<string[]> {
  // Build index once, then do O(1) lookups for each file
  const index = await buildImportIndex(projectPath);
  return getDependentsFromIndex(files, index);
}
