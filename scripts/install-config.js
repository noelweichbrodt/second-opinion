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

// Create config directory if it doesn't exist
if (!fs.existsSync(configDir)) {
  fs.mkdirSync(configDir, { recursive: true });
  console.log(`Created config directory: ${configDir}`);
}

// Copy template if target doesn't exist
if (!fs.existsSync(targetPath)) {
  fs.copyFileSync(templatePath, targetPath);
  console.log(`Installed default review instructions to: ${targetPath}`);
} else {
  console.log(`Review instructions already exist at: ${targetPath}`);
  console.log("Skipping to preserve your customizations.");
}

// Install slash command to ~/.claude/commands/
if (!fs.existsSync(claudeCommandsDir)) {
  fs.mkdirSync(claudeCommandsDir, { recursive: true });
  console.log(`Created Claude commands directory: ${claudeCommandsDir}`);
}

if (fs.existsSync(skillPath)) {
  fs.copyFileSync(skillPath, commandTargetPath);
  console.log(`Installed /second-opinion command to: ${commandTargetPath}`);
} else {
  console.log(`Warning: Skill file not found at ${skillPath}`);
}

console.log("\nSetup complete! Make sure to set your API keys:");
console.log("  export GEMINI_API_KEY=your-key    # For Gemini");
console.log("  export OPENAI_API_KEY=your-key    # For GPT");
