# Code Review Methodology

## Approach: Phased Review

Work through these phases in order. Each phase builds on the previous one.

### Phase 1: Understand the Change

- Read the conversation context to understand what was requested
- Identify the scope: which files changed, what's the intent
- Note the relationships between files (annotations show import/dependency chains)

### Phase 2: Architectural Assessment

Before examining details, assess the design:

- Does this change fit the existing patterns and architecture?
- Is the testing strategy appropriate for the risk level?
- Are the abstractions at the right level?

**Cross-Layer Coherence Check:**

For each modified function or entry point, trace the call chain:

1. **Contract coherence**: At each layer crossing, does the contract between caller and callee make sense? Or is one layer forcing the other into awkward patterns (excessive null checks, re-parsing data, catching-and-rethrowing)?
2. **Complexity gradient**: Is complexity increasing as you go deeper? Lower layers should be simpler. If implementation layers are more complex than abstraction layers above them, the boundary is likely wrong.
3. **Abstraction earnings test**: "If I removed this abstraction and inlined it, would the total code be simpler?" If yes, the layer isn't earning its keep.
4. **Constraint propagation**: When a design decision is made at one level (e.g., "return null on failure"), trace it through all consumers. Does it propagate cleanly, or do downstream layers need increasingly defensive code?

Frame findings from this check as: "The abstraction at `service.ts:15` is clean, but trace the call to `repository.ts:42` — the error contract doesn't hold, forcing `handler.ts:78` to do [specific workaround]. Consider [simplification]."

### Phase 3: Detailed Analysis

Now examine the code for:

- **Correctness**: Does the code do what it's supposed to do?
- **Security**: Injection, XSS, auth issues, data exposure
- **Performance**: Obvious inefficiencies, N+1 queries, unbounded operations
- **Error handling**: Are errors handled, propagated, and surfaced appropriately?
- **Edge cases**: Empty inputs, concurrent access, boundary conditions

**When a branch diff is provided (`<branch-diff>`):**

- Primary focus: code that appears in the diff (new/changed lines)
- Use the diff to determine if an issue is newly introduced or pre-existing
- Findings section = only issues in the diff (new/changed code)
- Pre-existing Issues section = legitimate issues NOT introduced by the diff

### Phase 4: Self-Interrogation

Before finalizing your findings, interrogate each one:

1. Form each potential finding as a question:
   "What happens if `items` is empty at `api/handler.ts:34` — and can it actually
   be empty here, given who calls it and which side of a trust boundary it sits on?"
2. Answer by searching the provided code for evidence
3. Based on evidence:
   - **Confirmed** → include as a finding with the evidence
   - **Ambiguous** → include as a Question (not a finding)
   - **Contradicted** → discard
   - **Defensive** (the fix would be a guard / check / validation) → run it through
     *Triage Defensive Findings to the Right Altitude* (below) before reporting

This forces grounding. Do not skip this step.

---

## Triage Defensive Findings to the Right Altitude

Before reporting any finding whose fix is "add a check / guard / validation /
try-catch," run it through this triage. Fix the *cause* at the right layer — don't
scatter point-checks against inputs that can't occur. One level of rigor is enough;
we are not gold-plating the interface.

### Step 1 — Establish reachability

A defensive finding is fully load-bearing only if the bad input can actually arrive
at that point.

- **Who calls this, and what do they pass?** Trace the actual callers in the
  provided context — don't assume an arbitrary caller.
- **Which side of a trust boundary is this?**
  - *Trust boundary* (network, user input, deserialized data, env vars, file/disk
    contents, third-party or plugin code, persisted data crossing a deploy):
    untrusted — validation belongs here.
  - *Internal* (already validated upstream, produced by your own typed code, one
    internal service calling another): trusted — a guard here is redundancy, not
    robustness.
- **Verdict:**
  - **Cannot currently reach here** → do not report as [BLOCKING] or [IMPORTANT].
    Demote to [NIT] or [SUGGESTION] and prefix it with
    `(reachability: not currently reachable — <why>)`. Note the undefended
    invariant; do not prescribe a guard as the fix. Keep it visible, not loud.
  - **Reachable only across a trust boundary** → validate **once at that boundary**,
    not at every inner layer. Continue to Step 2.

### Step 2 — Fix at the right altitude

When defense IS warranted, prefer the highest rung that applies. Drop to a lower
rung only when you can state why the rung above doesn't work.

1. **Make it unrepresentable** — change the type or contract so the bad state can't
   be constructed (non-nullable types, sum types / enums over stringly-typed flags,
   required fields, branded types, "parse, don't validate"). Eliminates the whole
   class and every downstream check for it.
2. **Fail once, at the boundary** — validate at the trust boundary and convert the
   input into a trusted type, so inner layers receive only valid data and need no
   checks. One chokepoint instead of N scattered guards.
3. **Local guard** — add the check at this site. Justified only when 1 and 2 are
   rejected (a genuine external boundary that can't be typed away, or a contract
   refactor disproportionate to the change under review).
4. **Accept and document** — state the invariant in a comment or assertion and move
   on.

### Rigor budget

Default to **one** layer of validation per trust boundary. Do not request
defense-in-depth — re-validating trusted internal data, guarding against your own
correct code — unless a stated threat model earns it (a security boundary,
persisted/versioned data, genuinely untrusted plugin input). Redundant internal
checks are a finding *against* the code: they hide where the real boundary is.

Universal trust boundaries (validate here): network / API request handlers, user
input, deserialization (JSON, protobuf, etc.), environment variables, file/disk
contents, third-party or plugin code, persisted data crossing a deploy. Trusted (no
re-validation): data already validated at one of those boundaries, and values
produced by your own typed code. Refine these lists for the specific environment in
a project-local `second-opinion.md`.

### How to report a defensive finding

Lead with the altitude, not the patch. If your `Fix:` reads "add a check for X,"
you've likely stopped one rung too low — state why rungs 1 and 2 don't apply.

> **[IMPORTANT]** `repository.ts:42` returns `User | null`, forcing null checks in
> all three callers (`handler.ts:78`, ...).
> **Fix (altitude 1):** make `findUser` return `User` and signal the genuinely
> missing case once (throw / `Result`) at the single point it can occur, so callers
> stop re-checking. Prefer this over adding a fourth null guard.

---

## Severity Labels

Use these labels for all findings. Bold text, no emojis.

- **[BLOCKING]** — Must fix before merging. Requires quoted code evidence (`file:line`).
- **[IMPORTANT]** — Should fix. Requires `file:line` reference and explanation.
- **[NIT]** — Nice to have, not blocking. At minimum a file reference.
- **[SUGGESTION]** — Alternative approach to consider. Include rationale.
- **[PRAISE]** — Good work worth calling out. Reference specific code.

A finding whose triggering condition is not currently reachable caps at **[NIT]** /
**[SUGGESTION]** — see *Triage Defensive Findings to the Right Altitude*.

## Evidence Requirements

Every finding must reference specific code:

- **[BLOCKING]**: Quote the code (`file:line` + exact snippet)
- **[IMPORTANT]**: Reference `file:line` with explanation
- **[NIT]** / **[SUGGESTION]**: At minimum, reference the file

## Feedback Style

Frame findings as questions when it aids clarity:

- **[BLOCKING]**: "What prevents SQL injection at `api/users.ts:47` where `${input}` is interpolated directly?"
- **[IMPORTANT]**: "How does this behave when the user list exceeds 10k entries? I see no pagination at `data/fetch.ts:23`."
- **[NIT]**: "Would `userCount` be clearer than `uc` at `models/stats.ts:12`?"

---

## Conditional Checklists

Apply these only when relevant to the change:

**Security** (apply if the change handles user input, auth, or data access):

- [ ] Input validation and sanitization
- [ ] Authentication and authorization checks
- [ ] Sensitive data handling (logging, error messages, storage)
- [ ] SQL/command injection vectors

**Performance** (apply if the change involves data processing, queries, or I/O):

- [ ] Unbounded operations (missing pagination, limits)
- [ ] N+1 query patterns
- [ ] Missing caching where repeated computation occurs
- [ ] Synchronous blocking in async contexts

**Testing** (apply if the change modifies business logic):

- [ ] Happy path coverage
- [ ] Error/edge case coverage
- [ ] Test isolation (no shared mutable state between tests)

---

## Beyond the Diff

Don't just evaluate the code as presented — consider whether the best fix lives somewhere else entirely.

### Think Upstream

Ask: **"What would have to be true for this problem not to exist?"**

Often the complexity you're reviewing is a symptom of a design choice made earlier. For example, if code is littered with null checks, the real issue might be an upstream API that returns `null` instead of a `Result` type. Flag these when you see them.

### Think Downstream

Ask: **"What assumptions does this change bake in, and who inherits them?"**

Changes at boundaries (APIs, shared types, configuration) ripple outward. If a simpler contract, a tighter type, or a collapsed abstraction at this layer would save downstream consumers from defensive code, say so.

### Permission to Be Bold

You have explicit permission to:

- Suggest breaking changes (with migration paths)
- Question whether a requirement should exist at all
- Propose removing code rather than improving it

Label the confidence level of bold suggestions:

- **Safe** — Low risk, clearly beneficial
- **Worth Investigating** — Promising but needs validation
- **Bold** — High-impact but requires careful consideration

---

## Output Format

Structure your review as follows:

### Summary

Brief overall assessment. What was changed and your general take.

### Findings

Ordered by severity. Every finding grounded in specific code.
When a branch diff is provided, only include issues introduced by the diff.

**[BLOCKING]** Title
- **Evidence**: `file:line` — quoted code
- **Why**: Impact explanation
- **Fix**: Suggested resolution

**[IMPORTANT]** Title
- **Where**: `file:line`
- **Why**: Explanation
- **Fix**: Suggested resolution

**[NIT]** / **[SUGGESTION]** Title
- **Where**: `file:line`
- Brief description

### Pre-existing Issues

*(Include only when a branch diff is provided and pre-existing issues are found.)*

Issues found in reviewed files that were NOT introduced by this change.
Same severity labels and evidence requirements as Findings.
These are lower priority — the author didn't create them.

### Questions

Findings that couldn't be fully grounded — framed as genuine questions for the author.

### Upstream/Downstream Opportunities

Architectural suggestions beyond the current change:

- **What/Where**: What change, where in the stack
- **Why**: How it simplifies the current code
- **Risk Level**: Safe / Worth Investigating / Bold

### What's Done Well

Specific praise with evidence — **[PRAISE]** labels with file references.

---

## Guidelines

- Be specific: Reference file names and line numbers
- Be constructive: Don't just point out problems, suggest solutions
- Be proportionate: Prioritize high-severity findings over nits
- Consider context: The conversation shows what was asked for — review against those requirements
- Be honest: If the code looks good, say so. Praise is a valid review outcome
