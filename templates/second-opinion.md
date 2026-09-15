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
3. **Inlining test**: "If I removed this abstraction and inlined it, would the total code be simpler?" If yes, the layer costs more than it saves.
4. **Constraint propagation**: When a design decision is made at one level (e.g., "return null on failure"), trace it through all consumers. Does it propagate cleanly, or do downstream layers need increasingly defensive code?

Report findings from this check one hop per sentence, so the author can follow the chain without opening the files: "`repository.ts:42` returns `null` when the row is missing (`return row ?? null`). `service.ts:15` passes that through unchanged. So `handler.ts:78` re-checks for `null` before it can respond. Returning a `Result` from the repository removes both downstream checks."

### Phase 3: Detailed Analysis

Now examine the code for:

- **Correctness**: Does the code do what it's supposed to do?
- **Security**: Injection, XSS, auth issues, data exposure
- **Performance**: Obvious inefficiencies, N+1 queries, unbounded operations
- **Error handling**: Are errors handled, propagated, and surfaced appropriately?
- **Edge cases**: Empty inputs, concurrent access, boundary conditions
- **Simplicity**: Is this the shortest expression that works? See *Simplicity* below

**When a branch diff is provided (`<branch-diff>`):**

- Primary focus: code that appears in the diff (new/changed lines)
- Use the diff to determine if an issue is newly introduced or pre-existing
- Findings section = only issues in the diff (new/changed code)
- Pre-existing Issues section = legitimate issues NOT introduced by the diff

### Phase 4: Self-Interrogation

Before finalizing your findings, interrogate each one:

1. Form each potential finding as a question:
   "What happens if `items` is empty at `api/handler.ts:34`, and can it be empty
   here, given who calls it and which side of a trust boundary it sits on?"
2. Answer by searching the provided code for evidence
3. Based on evidence:
   - **Confirmed** → include as a finding with the evidence
   - **Ambiguous** → include as a Question (not a finding)
   - **Contradicted** → discard
   - **Defensive** (the fix would be a guard / check / validation) → run it through
     *Triage Defensive Findings to the Right Altitude* (below) before reporting

This forces grounding. Do not skip this step.

---

## Simplicity

Strive and fight for the shortest possible expression. Simplify ruthlessly. Do not
accept complexity. Lines of code is the biggest code smell.

- Judge every change by what it removes as much as by what it adds. A fix that
  deletes code outranks one that adds a branch, a guard, or a layer.
- If simplicity implicates further refactoring of existing code, call for it. Do
  not accept complexity because the code it would remove predates the diff; report
  refactors outside the diff under *Upstream/Downstream Opportunities*.
- Prefer self-documenting code: names and structure that make comments
  unnecessary. Comments should document ambiguity or subtleties plainly. Flag
  comments that restate the code, and code that needs a comment to be understood.
- Hold the fixes you propose to the same standard.

---

## Triage Defensive Findings to the Right Altitude

Before reporting any finding whose fix is "add a check / guard / validation /
try-catch," run it through this triage. Fix the *cause* at the right layer; do not
scatter point-checks against inputs that cannot occur. One check per trust boundary
is enough.

### Step 1 — Establish reachability

A defensive finding holds only if the bad input can arrive at that point.

- **Who calls this, and what do they pass?** Trace the actual callers in the
  provided context. Do not assume an arbitrary caller.
- **Which side of a trust boundary is this?**
  - *Trust boundary* (network, user input, deserialized data, env vars, file/disk
    contents, third-party or plugin code, persisted data crossing a deploy):
    untrusted. Validation belongs here.
  - *Internal* (already validated upstream, produced by your own typed code, one
    internal service calling another): trusted. A guard here is redundancy, not
    robustness.
- **Verdict:**
  - **Cannot currently reach here** → do not report as [BLOCKING] or [IMPORTANT].
    Demote to [NIT] or [SUGGESTION] and open with the condition in plain words:
    `(only if <condition>; nothing in the provided code produces it)`. Name the
    undefended invariant; do not prescribe a guard as the fix.
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
defense-in-depth (re-validating trusted internal data, guarding against your own
correct code) unless a stated threat model requires it: a security boundary,
persisted/versioned data, genuinely untrusted plugin input. Redundant internal
checks are a finding *against* the code: they hide where the real boundary is.

Universal trust boundaries (validate here): network / API request handlers, user
input, deserialization (JSON, protobuf, etc.), environment variables, file/disk
contents, third-party or plugin code, persisted data crossing a deploy. Trusted (no
re-validation): data already validated at one of those boundaries, and values
produced by your own typed code. Refine these lists for the specific environment in
a project-local `second-opinion.md`.

### How to report a defensive finding

Lead with the contract change, not the guard. If your `Fix:` reads "add a check for
X," you have likely stopped one rung too low: state why rungs 1 and 2 do not apply.
The words *altitude*, *rung*, *reachability*, and *trust boundary* belong to this
triage, not to the finding (see *Writing for the Author*).

> **[IMPORTANT]** `findUser` at `repository.ts:42` is declared
> `findUser(id: string): Promise<User | null>`. All three callers re-check for
> `null` before using the result. `handler.ts:78` is one of them.
> **Fix:** at `repository.ts:42` (replace the signature), return `User` and throw
> or return a `Result` at this one site when the row is missing. The callers can
> then drop their checks, which beats adding a fourth `null` guard.

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

**Fixes carry an anchor too.** Evidence says where the problem shows; the fix must
say where the edit lands, often a different file. Name the `file:line` you would
change, whether that line is replaced or the code is inserted after it, and one
anchor per site when the fix spans several. Confirm each anchor against the provided
context; if the fix belongs in code you were not given, say so rather than guess a
location.

## Writing for the Author

The reader is the author of the change. They have not read this methodology and
will not open a second file to decode a sentence. Write each finding so it can be
read once, in place.

- **One claim per sentence, with a verb, and at most one code reference per
  sentence.** A code reference is a `file:line` or a symbol the author would have
  to look up. Do not join claims with semicolons. Three references in one sentence
  means the finding needs three sentences. A fragment with no verb ("third copy of
  X; one helper in Y") is not a finding.
- **Quote the code a cross-reference points at.** *Evidence Requirements* sets the
  minimum per severity. Beyond it, when a claim depends on code in another file or
  function (a caller, a helper, a type), quote that line so the author need not go
  and look.
- **Say what the code does before saying what to change.** Every finding above
  [NIT] gives, in order: what the code does now, what goes wrong and the input or
  sequence that triggers it, and the change with its location. Terseness moves the
  work of understanding onto the author. Brevity is not readability.
- **Keep this methodology's vocabulary out of findings.** *Altitude*, *rung*,
  *reachability*, *trust boundary*, *load-bearing*, *gold-plating*, and
  *defense-in-depth* decide what to report; the author will not recognize them.
  Say what would have to be true for the problem to occur, and whether anything in
  the code makes it true.
- **No mannered prose.** Mannered prose substitutes metaphor and flourish for
  direct statement: "a dial worth turning" for "a parameter worth varying", "earns
  its keep" for "still matters". The phrases display the writer rather than convey
  the idea, and they carry connotations the writer did not choose. When a literal
  phrase is available, use it.
- **Give mechanical fixes as code.** A duplicated helper, an unused import, a
  hand-rolled copy of an existing utility: give the replacement with one sentence
  of reason, as a fenced `suggestion` block for a span of lines or an inline span
  for a single expression. A paragraph describing an edit is harder to read than
  the edit.
- **Argue from behavior, not line counts.** Line count is how you find a smell,
  not how you make the case. Name the work the code does that it need not do.
- **One finding per problem.** When a later finding makes an earlier one moot,
  report only the later one and say what it also removes.
- **Ask when you cannot verify, and make the question carry the mechanism.** When
  the failure depends on a condition you cannot see in the code (request volume,
  concurrent callers, a value's realistic range), name it and ask: "This fails only
  if two `createMany` calls overlap for one product. Can they?" A question such as
  "What prevents SQL injection at `api/users.ts:47`, where `${input}` is
  interpolated into the query?" asks and explains at once. Do not assert a failure
  you cannot show.
- **Praise is a valid outcome.** If the code is good, say so and stop.

The same finding written for the reviewer, then for the author:

> `parseLimit` re-derives `clampInt` from `util/num.ts:18`, which `withDefaults`
> already applies to what `buildQuery` hands it; export the helper and this becomes
> `return clampInt(raw, 1, 100)`.

> **[NIT]** `parseLimit` at `api/list.ts:73` re-implements a helper the codebase
> already has. `util/num.ts:18` defines the same clamp:
> ```ts
> const clampInt = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))
> ```
> Export `clampInt` and the body of `parseLimit` becomes `return clampInt(raw, 1, 100)`.

The second can be read without opening either file. Each sentence carries one
reference, and the code the claim depends on is quoted.

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

Do not only evaluate the code as presented. Consider whether the best fix lives somewhere else entirely.

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

Each bullet below is one or more full sentences written to *Writing for the Author*.

**[BLOCKING]** Title
- **Evidence**: `file:line`, then the quoted code.
- **Why**: What goes wrong, and the input or sequence that triggers it.
- **Fix**: `file:line` (replace | insert after), then the change as a sentence or a fenced `suggestion` block.

**[IMPORTANT]** Title
- **Where**: `file:line`, and what the code does there.
- **Why**: What goes wrong, and the input or sequence that triggers it.
- **Fix**: `file:line` (replace | insert after), then the change.

**[NIT]** / **[SUGGESTION]** Title
- **Where**: `file:line`
- What the code does now and what to change, in one or two sentences or a fenced `suggestion` block.

### Pre-existing Issues

*(Include only when a branch diff is provided and pre-existing issues are found.)*

Issues found in reviewed files that were NOT introduced by this change.
Same severity labels and evidence requirements as Findings.
These are lower priority: the author did not create them.

### Questions

Findings that could not be fully grounded, framed as genuine questions for the author.

### Upstream/Downstream Opportunities

Architectural suggestions beyond the current change:

- **What/Where**: What change, where in the stack
- **Why**: How it simplifies the current code
- **Risk Level**: Safe / Worth Investigating / Bold

### What's Done Well

Specific praise with evidence: **[PRAISE]** labels with file references.
