#!/usr/bin/env node

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configDir = path.join(os.homedir(), ".config", "second-opinion");
const templatePath = path.join(__dirname, "..", "templates", "second-opinion.md");
const targetPath = path.join(configDir, "second-opinion.md");

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
  console.log("Skipping installation to preserve your customizations.");
}

console.log("\nSetup complete! Make sure to set your API keys:");
console.log("  export GOOGLE_API_KEY=your-key    # For Gemini");
console.log("  export OPENAI_API_KEY=your-key    # For GPT");
