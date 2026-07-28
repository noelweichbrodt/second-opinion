#!/usr/bin/env node

/**
 * Regenerates the `released` hash list in templates/methodology-manifest.json
 * from git history.
 *
 * The installer uses that list to tell an untouched methodology from a
 * customized one: a file hashing to any version this repo has ever shipped was
 * never edited by its owner, so refreshing it is safe. A file matching nothing
 * is the user's own work and is preserved.
 *
 * Run after every edit to templates/second-opinion.md. A test fails until you
 * do, so the list cannot silently fall behind.
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");
const templateRelPath = "templates/second-opinion.md";
const manifestPath = path.join(
  projectRoot,
  "templates",
  "methodology-manifest.json"
);

function git(...args) {
  // execFileSync, never a shell string: commit ids and paths reach git as
  // argv entries, so no quoting or metacharacter question arises.
  return execFileSync("git", args, {
    cwd: projectRoot,
    encoding: "utf-8",
    maxBuffer: 32 * 1024 * 1024,
  });
}

const sha256 = (content) =>
  crypto.createHash("sha256").update(content, "utf-8").digest("hex");

const commits = git("log", "--format=%H", "--", templateRelPath)
  .split("\n")
  .filter(Boolean);

if (commits.length === 0) {
  console.error(`No git history found for ${templateRelPath}.`);
  process.exit(1);
}

// Ordered newest-first, deduplicated: a commit that touched the file without
// changing its content (a revert-and-restore, say) yields a repeat hash.
const released = [];
for (const commit of commits) {
  const blob = git("cat-file", "blob", `${commit}:${templateRelPath}`);
  const hash = sha256(blob);
  if (!released.includes(hash)) {
    released.push(hash);
  }
}

// The working-tree template may be edited but not yet committed; the manifest
// has to describe what ships, so include it.
const packaged = sha256(
  fs.readFileSync(path.join(projectRoot, templateRelPath), "utf-8")
);
if (!released.includes(packaged)) {
  released.unshift(packaged);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
manifest.released = released;
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Wrote ${released.length} released hashes to ${manifestPath}`);
console.log(`  current packaged template: ${packaged.slice(0, 16)}…`);
