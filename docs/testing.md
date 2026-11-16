# Testing and comments

People, review bots and coding agents all review this repo against this file. `CLAUDE.md` and `AGENTS.md` link here. Change a rule here, nowhere else.

## Tests to write

Write a test for behaviour that can break and costs us when it does:

- Hook enforcement: OPA enforcement, policy evaluation and merge, the MCP gate (`tests/opa-enforcement.test.mjs`, `tests/policy.test.mjs`, `tests/policy-merge.test.mjs`, `tests/mcp-gate.test.mjs`).
- Failing closed when a policy is missing, malformed or fails its integrity check (`tests/crypto-integrity.test.mjs`, `tests/crypto-policy.test.mjs`).
- The plugin manifest Claude Code loads (`tests/plugin-manifest.test.mjs`).
- Installing over an existing install (`tests/installer.test.mjs`), and never touching the real `~/.claude`.
- The logic a bug fix changed.

How:

1. A bug fix ships a test that fails on the base commit for the reason the issue names and passes on the head. The PR body shows both runs.
2. Test at the lowest layer that fails on the base commit. Pure logic gets a unit test. Hook behaviour gets a test through the hook entry point with a temp home directory. One layer per case, never two.
3. Extend before you add. Add a row to an existing `it.each` or an assertion to an existing case. Write a new `it` only when no case fits. A table keeps one row per code branch.
4. Feature tests follow the requirement in the issue, not the implementation.
5. A failing test means the code is wrong until shown otherwise. Never weaken an assertion to go green.

## Tests not to write

Delete these when a PR touches the file they sit in:

- Shape-only: asserts that an export exists or that a value has the shape the code always returns, with no behaviour behind it.
- Mock-call mirrors: the only assertion is that our own collaborator was called with what the test passed in, or that a handler returns the stub it was given. A call at a system boundary that carries the behaviour is behaviour: the decision a hook prints to Claude Code, a file the hook writes, an outbound request. Keep those.
- Constant and copy mirrors: restates a constant, enum, label or error message with no logic in between. A wire value another repo reads may be pinned once.
- Duplicates: the same case at two layers, in two files, or in two table rows that take the same branch.
- Smoke: "should be defined", "renders", "exports X", "does not throw" on a function with no failure path.
- Dead code: a test whose subject has no caller in `hooks`, `scripts` or `install_armorclaude.sh`. Delete the export and the test together. The installer is production code, so `tests/installer.test.mjs` stays.
- Skip guards that can never fire. Delete them; a quarantine line is for a test that is broken.

## Rewrite, don't delete

These tests guard real behaviour but are written in a way that flakes or leaks. Keep each one and fix it in the PR that touches it:

- Wall clock: a real sleep, a polling loop, an elapsed-time assert, or a per-test timeout raised to get green. Replace it with `mock.timers` from `node:test` or an injected clock.
- Spawn and exec spies asserted whole. Assert command and argv only (`spy.mock.calls.map(([c, a]) => [c, a])`). The runner prints every argument on failure, `env` included.

## Markers

- `// regression: #NNNN` sits on the line above every test a fix PR adds. A marked test is deleted only by a PR that says why the bug cannot come back.
- A test skipped because it is broken carries `// quarantine: #NNNN <why>` on the line above, with an open issue. This covers `it.skip`, `{ skip: ... }` and `t.skip()`. A suite gated on an environment (a database, a live service) uses a named gate constant, never an inline ternary.
- `.only` never merges, with or without a quarantine line. Check before push: `git diff origin/dev... | grep -n -E '^\+.*(\.only\b|\bonly:)'` prints nothing.
- Only a skip may carry a quarantine line. Check before push: every hit of `git diff origin/dev... | grep -n -E '^\+.*(\.skip\b|\bskip:|\btodo:)'` has a quarantine line above it.

## Comments

Default: no comment, and delete as many as you can. When you are not sure a keep clause applies, delete the comment. A comment stays only when it is one of these:

0. Text a tool or the runtime reads: directives such as `@vitest-environment`, `"use client"` and `prettier-ignore`; FastAPI route docstrings; JSDoc `@type` and `@param {T}` in plain JS files; a comment inside an empty `catch {}`; `@ts-expect-error` used as a type-test assertion.
1. A license header.
2. Behaviour forced by something we cannot change: a vendor API, a framework, the runtime, a protocol.
3. A security or race invariant, only when the comment names the failure a likely edit would cause: a deadlock, a leak, failing open. "Must" or "never" alone does not qualify.
4. A contract another repo mirrors, naming that repo.
5. A known limitation with its open issue number.
6. A lint or format suppression with its reason on the same line.

Delete everything else: a restated name or signature, step narration, Arrange/Act/Assert labels, section dividers, history ("previously", "fixed in"), decision or plan IDs, the reason for the fix you just made, commented-out code, a TODO without an issue. The commit body and the PR carry those. A test comment that names the bug it guards becomes `// regression: #NNNN`.

One line where it fits, four lines at most per block.

## Reviewing tests

Review only the tests a PR adds or grows. Each finding names one fix: fold it into an existing case or table, delete it, or keep one layer. Ask for a new test only when a bug fix has none that fails on the base commit.
