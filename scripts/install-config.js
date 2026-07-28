#!/usr/bin/env node

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");

// Paths for review instructions template
const configDir = path.join(os.homedir(), ".config", "second-opinion");
const templatePath = path.join(projectRoot, "templates", "second-opinion.md");
const targetPath = path.join(configDir, "second-opinion.md");

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
    } else {
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
