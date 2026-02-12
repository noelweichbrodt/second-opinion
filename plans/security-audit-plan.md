# Security Audit Plan: second-opinion MCP Server

## Overview

This audit targets the second-opinion MCP server, which sends code context to external LLMs (Gemini/OpenAI) for review. The security surface includes supply chain, data exfiltration, credential handling, input validation, file system access, and code injection vectors.

---

## 1. Supply Chain Security Audit

### Objective
Verify dependencies are secure and no malicious code can execute during install.

### Steps
1. Run `npm audit` to identify known vulnerabilities in all 187 packages
2. Run `npm outdated` to identify stale dependencies
3. Verify lock file integrity (SHA-512 hashes) in `package-lock.json`
4. Scan all packages for `preinstall`/`postinstall` lifecycle scripts
5. Check for typosquatting in dependency names
6. Review extraneous packages (`@anthropic-ai/sdk`, `tiktoken`) not in package.json

### Files
- `package.json`
- `package-lock.json`
- `scripts/install-config.js`

### What to Look For
- CVEs in dependencies
- Malicious install scripts
- Dependency confusion attacks
- Outdated packages with known issues

---

## 2. Data Exfiltration Risk Assessment

### Objective
Assess what sensitive data could be transmitted to external APIs.

### Steps
1. Audit `SENSITIVE_PATH_PATTERNS` for completeness (bundler.ts:32-51)
2. Test that `.env` files are blocked (currently NOT blocked - **HIGH PRIORITY**)
3. Review conversation context for credential exposure (session.ts:403-429)
4. Verify no secret scanning/redaction before API transmission
5. Document full data payload sent to Gemini/OpenAI

### Files
- `src/context/bundler.ts` - sensitive path patterns, context collection
- `src/context/session.ts` - conversation parsing
- `src/providers/gemini.ts` - API transmission
- `src/providers/openai.ts` - API transmission

### Missing Patterns to Add
- `.env`, `.env.*` files
- `secrets.yaml`, `secrets.json`
- `.azure/`, `.gcloud/`
- `.yarnrc.yml` (may contain tokens)

---

## 3. Credential Handling Review

### Objective
Ensure API keys are handled securely.

### Steps
1. Review key loading from env vars vs config file (config.ts:42-43)
2. Check for key exposure in logs, error messages, stack traces
3. Verify keys not included in output files
4. Assess config file permissions (plaintext at `~/.config/second-opinion/config.json`)
5. Review documentation for secure storage guidance

### Files
- `src/config.ts`
- `src/providers/index.ts`
- `CLAUDE.md`

### Risks
- Plaintext storage in config.json
- No file permission validation
- Keys visible via `/proc` environment

---

## 4. Input Validation Testing

### Objective
Test all user inputs for injection and path traversal vulnerabilities.

### Test Cases

**Path Traversal:**
```
projectPath: "/tmp/../etc/passwd"
projectPath: "/tmp/./../../etc"
includeFiles: ["../../../etc/passwd"]
includeFiles: ["~/.ssh/id_rsa"]
```

**Session ID Injection:**
```
sessionId: "../../../etc/passwd"
sessionId: "valid; rm -rf /"
```

**Reviews Directory Escape:**
```
reviewsDir: "../../../tmp"
```

### Files
- `src/tools/review.ts` - validateProjectPath() at lines 16-38
- `src/output/writer.ts` - validateReviewsDir() at lines 27-44
- `src/context/session.ts` - sessionId used at line 190

---

## 5. File System Security Testing

### Objective
Test symlink handling and path boundary enforcement.

### Steps
1. Test symlink to sensitive location (e.g., `~/.ssh`)
2. Test nested symlinks (A -> B -> sensitive)
3. Test circular symlinks (infinite loop potential)
4. Test TOCTOU race condition (symlink modified after check)
5. Test case sensitivity on macOS (case-insensitive FS)
6. Verify `isWithinProject()` bounds checking (imports.ts:41-49)

### Files
- `src/context/bundler.ts` - expandPath() at lines 65-149
- `src/context/imports.ts` - isWithinProject() at lines 41-49

### Test Scenarios
```bash
ln -s /etc/passwd /project/data.txt
ln -s ~/.ssh /project/config
```

---

## 6. Code Injection Assessment

### Objective
Identify and test command injection vulnerabilities.

### Critical Finding: Command Injection in git.ts:92

```typescript
const relativePath = path.relative(projectPath, filePath);
const diff = execSync(`git diff HEAD -- "${relativePath}"`, {...})
```

**Vulnerability:** `relativePath` derived from user-controllable `filePath` is interpolated into shell command. Special characters can escape quotes.

### Test Cases
```bash
# Create file with malicious name
touch '/project/"; id > /tmp/pwned; #.ts'

# Test injection
filePath: '/project/"; cat /etc/passwd; #.ts'
filePath: '/project/$(whoami).ts'
filePath: '/project/`id`.ts'
```

### Files
- `src/context/git.ts` - getFileDiff() at lines 82-101

### Remediation
Use array form of `execSync` or escape shell arguments properly.

---

## 7. Configuration Security Review

### Objective
Verify configuration defaults are secure and validate edge cases.

### Steps
1. Test `maxContextTokens` with edge values (-1, 0, very large)
2. Verify model string validation (arbitrary models accepted)
3. Test review instructions injection via malicious project's `second-opinion.md`
4. Verify output file permissions (umask-dependent)

### Test Cases
```bash
MAX_CONTEXT_TOKENS=-1 node dist/index.js
MAX_CONTEXT_TOKENS=999999999 node dist/index.js
GEMINI_MODEL="arbitrary-model-name" node dist/index.js
```

### Files
- `src/config.ts` - ConfigSchema defaults at lines 6-14

---

## Priority Summary

### Critical (Immediate)
1. **Command injection in git.ts:92** - shell command with unsanitized path
2. **Missing .env file blocking** - credentials sent to external APIs
3. **Credentials in conversation** - no secret scanning/redaction

### High (Before Production)
4. Symlink TOCTOU race condition
5. API keys in plaintext config
6. Session ID path injection

### Medium
7. Additional sensitive path patterns needed
8. No bounds checking on maxContextTokens
9. No model allowlist
10. Output file permissions

---

## Verification

### How to Test Changes
1. **Unit tests:** Create test cases for each vulnerability
2. **Manual testing:** Run injection test cases listed above
3. **npm audit:** Verify no new vulnerabilities introduced
4. **Integration test:** Verify normal operation still works
5. **Code review:** Verify all fixes follow secure coding practices

### Commands
```bash
npm audit
npm run build
npm run start  # with test inputs
```
