#!/usr/bin/env node

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");

// Paths for review instructions template
const configDir = path.join(os.homedir(), ".config", "second-opinion");
const templatePath = path.join(projectRoot, "templates", "second-opinion.md");
const targetPath = path.join(configDir, "second-opinion.md");
const manifestPath = path.join(
  projectRoot,
  "templates",
  "methodology-manifest.json"
);

// Paths for slash command
const claudeCommandsDir = path.join(os.homedir(), ".claude", "commands");
const skillPath = path.join(projectRoot, "second-opinion.skill.md");
const commandTargetPath = path.join(claudeCommandsDir, "second-opinion.md");

function isPermissionError(error) {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "EACCES" || error.code === "EPERM")
  );
}

const sha256 = (content) =>
  crypto.createHash("sha256").update(content, "utf-8").digest("hex");

/**
 * Reads the shipped methodology manifest.
 *
 * Returns null when it is missing or unreadable, which downgrades the install
 * to the historical skip-if-exists behavior. An unreadable manifest must never
 * be grounds for touching a file we cannot classify.
 */
function readManifest() {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    if (!Array.isArray(manifest.released) || !Array.isArray(manifest.anchors)) {
      return null;
    }
    return manifest;
  } catch {
    return null;
  }
}

/**
 * Decides what an already-installed methodology file is.
 *
 * "Exists" and "customized" are different facts, and conflating them is what
 * stranded users on methodology versions predating the sections the review
 * prompt now delegates to. A file hashing to any release this package has
 * shipped was never edited, so refreshing it loses nothing.
 *
 * @returns {"current"|"stale"|"customized"|"unknown"}
 */
function classifyInstalled(existing, packaged, manifest) {
  if (!manifest) return "unknown";
  const hash = sha256(existing);
  if (hash === sha256(packaged)) return "current";
  return manifest.released.includes(hash) ? "stale" : "customized";
}

/** Anchors the review system prompt delegates to that this file does not state. */
function missingAnchors(content, manifest) {
  return manifest ? manifest.anchors.filter((a) => !content.includes(a)) : [];
}

/**
 * Replaces the installed methodology without ever leaving a partial file in
 * place: write beside the target, then rename over it.
 */
function refreshTemplate() {
  const tmpPath = `${targetPath}.${process.pid}.tmp`;
  try {
    fs.copyFileSync(templatePath, tmpPath);
    fs.renameSync(tmpPath, targetPath);
  } catch (error) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Nothing to clean up; report the original failure instead.
    }
    throw error;
  }
}

// Runs one install step; a permission failure anywhere in the step (mkdir or
// copy) degrades to a warning so `npm install` / `npm run build` never abort
// in sandboxed or restricted-home environments.
function tryInstallStep(description, fn) {
  try {
    fn();
    return true;
  } catch (error) {
    if (!isPermissionError(error)) {
      throw error;
    }
    console.warn(`Warning: ${description} (permission denied).`);
    return false;
  }
}

// Install review instructions template into ~/.config/second-opinion
const configInstalled = tryInstallStep(
  `Could not install review instructions at ${targetPath}`,
  () => {
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
      console.log(`Created config directory: ${configDir}`);
    }
    if (!fs.existsSync(targetPath)) {
      fs.copyFileSync(templatePath, targetPath);
      console.log(`Installed default review instructions to: ${targetPath}`);
      return;
    }

    const manifest = readManifest();
    const existing = fs.readFileSync(targetPath, "utf-8");
    const packaged = fs.readFileSync(templatePath, "utf-8");

    switch (classifyInstalled(existing, packaged, manifest)) {
      case "current":
        console.log(`Review instructions are up to date: ${targetPath}`);
        break;

      case "stale":
        refreshTemplate();
        console.log(`Updated review instructions at: ${targetPath}`);
        console.log(
          "  Your copy matched an earlier release, so it was refreshed."
        );
        break;

      case "customized": {
        console.log(`Review instructions already exist at: ${targetPath}`);
        console.log("Skipping to preserve your customizations.");
        const missing = missingAnchors(existing, manifest);
        if (missing.length > 0) {
          console.warn(
            `\n  Warning: your methodology is missing ${missing.length} section(s)`
          );
          console.warn("  that the review prompt delegates to:");
          for (const anchor of missing) {
            console.warn(`    ${anchor}`);
          }
          console.warn("  Reviews will not state these anywhere. Compare with:");
          console.warn(`    ${templatePath}\n`);
        }
        break;
      }

      default:
        // No usable manifest: cannot tell customized from stale, so preserve.
        console.log(`Review instructions already exist at: ${targetPath}`);
        console.log("Skipping to preserve your customizations.");
    }
  }
);
if (!configInstalled) {
  console.warn(
    `The build succeeded; copy templates/second-opinion.md to ${targetPath} manually if needed.`
  );
}

// Install slash command to ~/.claude/commands/
if (fs.existsSync(skillPath)) {
  const commandInstalled = tryInstallStep(
    `Could not install /second-opinion command at ${commandTargetPath}`,
    () => {
      if (!fs.existsSync(claudeCommandsDir)) {
        fs.mkdirSync(claudeCommandsDir, { recursive: true });
        console.log(`Created Claude commands directory: ${claudeCommandsDir}`);
      }
      fs.copyFileSync(skillPath, commandTargetPath);
      console.log(`Installed /second-opinion command to: ${commandTargetPath}`);
    }
  );
  if (!commandInstalled) {
    console.warn(
      "The build succeeded; copy second-opinion.skill.md there manually if needed."
    );
  }
} else {
  console.log(`Warning: Skill file not found at ${skillPath}`);
}

console.log("\nSetup complete!");
console.log("  GEMINI_API_KEY is optional and enables Gemini/consensus.");
console.log("  Run `codex login` for Codex using ChatGPT-plan auth.");
console.log("Install the openai-codex Claude Code plugin for /codex:rescue.");
