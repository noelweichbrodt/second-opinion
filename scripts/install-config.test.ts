import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { execFileSync, spawnSync } from "child_process";

// These tests run the real installer as a subprocess against a throwaway HOME,
// rather than unit-testing a extracted predicate. The branch that matters
// overwrites a file in the user's home directory, so the thing worth proving is
// the actual script's actual filesystem behavior.

const projectRoot = path.resolve(__dirname, "..");
const scriptPath = path.join(projectRoot, "scripts", "install-config.js");
const templatePath = path.join(projectRoot, "templates", "second-opinion.md");
const manifestPath = path.join(
  projectRoot,
  "templates",
  "methodology-manifest.json"
);

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
const packagedTemplate = fs.readFileSync(templatePath, "utf-8");

const sha256 = (content: string) =>
  crypto.createHash("sha256").update(content, "utf-8").digest("hex");

let fakeHome: string;

function installedPath() {
  return path.join(fakeHome, ".config", "second-opinion", "second-opinion.md");
}

function writeInstalled(content: string) {
  fs.mkdirSync(path.dirname(installedPath()), { recursive: true });
  fs.writeFileSync(installedPath(), content);
}

function runInstaller() {
  return execFileSync("node", [scriptPath], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HOME: fakeHome },
  });
}

/** Runs the installer and returns stdout and stderr concatenated. */
function runInstallerCombined(): string {
  const result = spawnSync("node", [scriptPath], {
    encoding: "utf-8",
    env: { ...process.env, HOME: fakeHome },
  });
  expect(result.status).toBe(0);
  return `${result.stdout}${result.stderr}`;
}

describe("install-config: methodology install", () => {
  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "so-install-home-"));
  });

  afterEach(() => {
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  it("installs the packaged template when nothing is present", () => {
    const output = runInstaller();

    expect(output).toContain("Installed default review instructions");
    expect(fs.readFileSync(installedPath(), "utf-8")).toBe(packagedTemplate);
  });

  it("leaves an already-current methodology untouched", () => {
    writeInstalled(packagedTemplate);
    const before = fs.statSync(installedPath()).mtimeMs;

    const output = runInstaller();

    expect(output).toContain("up to date");
    expect(fs.readFileSync(installedPath(), "utf-8")).toBe(packagedTemplate);
    expect(fs.statSync(installedPath()).mtimeMs).toBe(before);
  });

  it("refreshes a copy matching an earlier release", () => {
    // The oldest shipped methodology: 0/6 anchors, and the exact state that
    // stranded users once the review prompt stopped restating them.
    const stale = "# Code Review Methodology\n\nold and unmodified\n";
    const staleHash = sha256(stale);
    const original = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    fs.writeFileSync(
      manifestPath,
      JSON.stringify(
        { ...original, released: [...original.released, staleHash] },
        null,
        2
      )
    );

    try {
      writeInstalled(stale);
      const output = runInstaller();

      expect(output).toContain("Updated review instructions");
      expect(output).toContain("matched an earlier release");
      expect(fs.readFileSync(installedPath(), "utf-8")).toBe(packagedTemplate);
    } finally {
      fs.writeFileSync(manifestPath, `${JSON.stringify(original, null, 2)}\n`);
    }
  });

  it("preserves a customized methodology", () => {
    // Carries every anchor, so it is a legitimate custom methodology and must
    // draw no warning — only silence and preservation.
    const custom = `# My Own Methodology\n\n${manifest.anchors.join(
      "\n\nbody\n\n"
    )}\n`;
    writeInstalled(custom);

    const output = runInstallerCombined();

    expect(output).toContain("Skipping to preserve your customizations");
    expect(output).not.toContain("Warning");
    expect(fs.readFileSync(installedPath(), "utf-8")).toBe(custom);
  });

  it("warns which delegated sections a customized methodology lacks", () => {
    const kept = manifest.anchors.slice(0, 2) as string[];
    const dropped = manifest.anchors.slice(2) as string[];
    writeInstalled(`# My Own Methodology\n\n${kept.join("\n\nbody\n\n")}\n`);

    const output = runInstallerCombined();

    expect(output).toContain("Skipping to preserve your customizations");
    expect(output).toContain(`missing ${dropped.length} section(s)`);
    for (const anchor of dropped) {
      expect(output).toContain(anchor);
    }
    for (const anchor of kept) {
      // Present sections must not be listed as missing.
      const missingBlock = output.slice(output.indexOf("missing "));
      expect(missingBlock).not.toContain(anchor);
    }
  });

  it("preserves an unclassifiable file when the manifest is unreadable", () => {
    // Fail closed: without a manifest the installer cannot tell an untouched
    // release from the user's own work, so it must never overwrite.
    const original = fs.readFileSync(manifestPath, "utf-8");
    const custom = "# Mine\n";
    fs.writeFileSync(manifestPath, "{ not json");

    try {
      writeInstalled(custom);
      const output = runInstallerCombined();

      expect(output).toContain("Skipping to preserve your customizations");
      expect(output).not.toContain("Warning");
      expect(fs.readFileSync(installedPath(), "utf-8")).toBe(custom);
    } finally {
      fs.writeFileSync(manifestPath, original);
    }
  });

  it("leaves no temp file behind after a refresh", () => {
    const stale = "# Code Review Methodology\n\nold\n";
    const original = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    fs.writeFileSync(
      manifestPath,
      JSON.stringify(
        { ...original, released: [...original.released, sha256(stale)] },
        null,
        2
      )
    );

    try {
      writeInstalled(stale);
      runInstaller();

      const dir = path.dirname(installedPath());
      expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    } finally {
      fs.writeFileSync(manifestPath, `${JSON.stringify(original, null, 2)}\n`);
    }
  });
});

describe("methodology manifest", () => {
  it("lists the packaged template as a released version", () => {
    // Editing templates/second-opinion.md without running
    // `npm run gen:template-hashes` would leave every user's untouched copy
    // looking customized, silently restoring the old skip-if-exists behavior.
    expect(manifest.released).toContain(sha256(packagedTemplate));
  });

  it("released hashes are unique and well formed", () => {
    const released = manifest.released as string[];
    expect(new Set(released).size).toBe(released.length);
    for (const hash of released) {
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
