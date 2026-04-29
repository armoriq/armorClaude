# ArmorClaude — Design Document

## Overview

ArmorClaude is a security plugin for Claude Code / Claude Cowork that enforces intent-based access control on tool calls. It is the Claude Code equivalent of ArmorClaw (for OpenClaw).

Core idea: an AI agent declares what it intends to do before doing it, and every action is checked against that declared intent. This prevents prompt injection from causing unauthorized tool use, blocks data exfiltration, and provides an audit trail of every tool call decision.

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                           Claude Code Session                            │
│                                                                          │
│  User Prompt                                                             │
│       │                                                                  │
│       ▼                                                                  │
│  ┌──────────────────────┐                                                │
│  │ UserPromptSubmit Hook │─► Injects directive into Claude's context     │
│  └──────────────────────┘   "Before any tool, register your plan"        │
│       │                                                                  │
│       ▼                                                                  │
│  Claude's LLM (same turn, same credentials)                              │
│       │                                                                  │
│       ├─► Calls register_intent_plan MCP tool ◄── Plan Path A           │
│       │       │                                                          │
│       │       ▼                                                          │
│       │   ┌─────────────────────────┐                                    │
│       │   │ MCP Handler             │                                    │
│       │   │  • Validate plan schema │                                    │
│       │   │  • Send to ArmorIQ IAP  │──► Signed intent token             │
│       │   │  • Write pending-plan   │                                    │
│       │   └─────────────────────────┘                                    │
│       │                                                                  │
│       ├─► ExitPlanMode (plan mode)  ◄── Plan Path B                     │
│       │       │                                                          │
│       │       ▼                                                          │
│       │   ┌─────────────────────────┐                                    │
│       │   │ PreToolUse Hook         │                                    │
│       │   │  • Parse plan file JSON │                                    │
│       │   │  • Send to ArmorIQ IAP  │──► Signed intent token             │
│       │   └─────────────────────────┘                                    │
│       │                                                                  │
│       ▼                                                                  │
│  Tool Call (Read, Write, Bash, etc.)                                     │
│       │                                                                  │
│       ▼                                                                  │
│  ┌──────────────────────────────────────────────────────────┐            │
│  │ PreToolUse Hook — ENFORCEMENT POINT                      │            │
│  │  1. Whitelist: allow register_intent_plan, ExitPlanMode  │            │
│  │  2. Consume pending-plan.json if present                 │            │
│  │  3. Static policy evaluation (allow/deny rules)          │            │
│  │  4. Crypto policy digest verification (optional)         │            │
│  │  5. Intent token plan check (tool in plan? params match?)│            │
│  │  6. CSRG Merkle proof verification (optional)            │            │
│  │  7. IAP remote step verification (optional)              │            │
│  │  8. Token expiry check                                   │            │
│  │  9. Fail-closed: deny if intentRequired and no token     │            │
│  └──────────────────────────────────────────────────────────┘            │
│       │                                                                  │
│       ▼                                                                  │
│  Tool executes (or is blocked)                                           │
│       │                                                                  │
│       ▼                                                                  │
│  ┌──────────────────────┐                                                │
│  │ PostToolUse Hook     │─► Audit log sent to ArmorIQ IAP               │
│  └──────────────────────┘                                                │
└──────────────────────────────────────────────────────────────────────────┘
```

## Plan Generation — Two Paths, One Schema

The plugin does NOT make its own LLM call. Instead, it uses Claude's own LLM by:

**Path A — MCP Tool (default, no plan mode)**:
`UserPromptSubmit` injects a directive telling Claude to call `register_intent_plan` before any other tool. Claude produces the plan as tool arguments — the plan is generated as part of Claude's normal reasoning turn. The MCP handler validates the schema, forwards to ArmorIQ, and writes a pending-plan file for PreToolUse to consume.

**Path B — Plan Mode (ExitPlanMode interception)**:
When Claude is in plan mode, it writes a plan file and calls `ExitPlanMode`. The `PreToolUse` hook intercepts this, reads the plan file, extracts a fenced ```json block (or falls back to heuristic markdown parsing), and forwards to ArmorIQ.

Both paths use the same Zod schema (`INTENT_PLAN_ZOD` in `intent-schema.mjs`) and the same normalization function (`normalizeIntentPlan`), and both feed the same `requestIntent()` pipeline.

## Security Model

### Defense Layers

1. **Static Policy Rules** — allow/deny/require_approval by tool name, data classification (PCI, PAYMENT, PHI, PII), and parameter patterns. Evaluated before intent checks.

2. **Intent Drift Detection** — every tool call is checked against the registered plan. If a tool wasn't declared in the plan, it's blocked ("intent drift"). This prevents prompt injection from causing Claude to use unauthorized tools.

3. **Parameter Enforcement** — plan steps can constrain expected parameters. If the actual tool call parameters don't match the plan's declared inputs, the call is blocked.

4. **Token Expiry** — intent tokens have a configurable TTL (default 60s). Expired tokens block all tool calls, forcing a fresh plan registration.

5. **CSRG Cryptographic Proofs** — optional Merkle tree proofs from ArmorIQ's CSRG service. Each plan step gets a cryptographic proof that's verified before execution.

6. **Crypto Policy Binding** — optional: policy rules are hashed into a Merkle tree and signed. If someone modifies policy rules after token issuance, the digest mismatch is detected.

7. **Audit Trail** — every tool execution (success and failure) is logged to ArmorIQ IAP with token, step index, tool name, sanitized input/output, and timestamp.

### Fail-Closed

If any of the following occurs in enforce mode, all tool calls are blocked:
- No intent plan registered (and `intentRequired=true`)
- Intent token expired
- Tool not in plan (intent drift)
- Parameters don't match plan constraints
- Policy rule denies the tool
- Crypto policy digest mismatch
- CSRG proof validation fails
- IAP verify-step returns denied
- Internal error in the hook

Monitor mode (`ARMORCLAUDE_MODE=monitor`) logs these events but allows tool calls to proceed.

## Module Responsibilities

```
scripts/
├── hook-router.mjs          Stdin/stdout dispatcher — routes hook events to handlers
├── policy-mcp.mjs           MCP server: policy_update, policy_read, register_intent_plan
└── lib/
    ├── engine.mjs            Hook handlers: SessionStart, UserPromptSubmit, PreToolUse,
    │                         PostToolUse, PostToolUseFailure, Stop, SessionEnd
    ├── intent-schema.mjs     Shared Zod schema + format string + normalizeIntentPlan
    ├── intent.mjs            Intent token lifecycle: requestIntent, checkIntentTokenPlan,
    │                         CSRG proof resolution, step tracking
    ├── iap-service.mjs       IAP backend client: verifyStep, verifyWithCsrg, createAuditLog
    ├── crypto-policy.mjs     Merkle tree policy binding: issuePolicyToken, verifyPolicyDigest
    ├── policy.mjs            Policy rules: evaluate, parse commands, data class detection
    ├── planner.mjs           Plan file parsing: extractPlanJsonBlock, parsePlanMarkdown
    ├── config.mjs            Configuration from env vars + CLAUDE_PLUGIN_OPTION_*
    ├── runtime-state.mjs     Session management + tool discovery
    ├── hook-output.mjs       Hook response formatters (denyPreTool, blockPrompt, addPromptContext)
    ├── common.mjs            Utilities: sanitize, postJson, sha256, type helpers
    └── fs-store.mjs          JSON file I/O
```

## Hook Event Flow

| Event | Handler | Purpose |
|-------|---------|---------|
| `SessionStart` | Initialize session, prune stale sessions | Lifecycle |
| `UserPromptSubmit` | Policy commands; inject plan directive | Pre-processing |
| `PreToolUse` | **Enforcement**: whitelist, consume plan, policy, intent, proofs | Gate |
| `PostToolUse` | Audit log (success) | Compliance |
| `PostToolUseFailure` | Audit log (failure) | Compliance |
| `Stop` | Token expiry warning | Turn cleanup |
| `SessionEnd` | Remove session state | Lifecycle |

## State Management

Hooks are stateless short-lived processes (new Node process per event). All state is persisted to files:

| File | Contents | Lifecycle |
|------|----------|-----------|
| `runtime.json` | Sessions: intent tokens, plans, allowed actions, step tracking, discovered tools | Per-session, pruned after 24h |
| `policy.json` | Policy rules, version history | Persistent, user-managed |
| `pending-plan.json` | Plan + token from `register_intent_plan` MCP tool, awaiting consumption | Consumed and deleted by next PreToolUse |
| `crypto-policy-state.json` | Cached CSRG policy token + digest | Refreshed on policy change |

## Comparison with ArmorClaw

| Feature | ArmorClaw (OpenClaw) | ArmorClaude (Claude Code) |
|---------|---------------------|--------------------------|
| Plan generation | Separate LLM call via pi-ai | Claude's own LLM via MCP tool / plan mode |
| Plan API key | Uses agent's runtime.modelAuth | None needed (session LLM) |
| Hook system | OpenClaw events (llm_input, before_tool_call) | Claude Code hooks (UserPromptSubmit, PreToolUse) |
| State management | In-memory Maps (long-lived process) | File-based JSON (stateless hook processes) |
| Policy tool | Inline tool registration | MCP server (policy_update, register_intent_plan) |
| Intent capture | ArmorIQ SDK (capturePlan + getIntentToken) | Same SDK, triggered from MCP tool handler |
| CSRG proofs | Full (verifyStep, verifyWithCsrg) | Full (same, via iap-service.mjs) |
| Audit logging | createAuditLog in IAPVerificationService | Same, triggered from PostToolUse hook |
| Crypto policy | CryptoPolicyService (Merkle tree) | Same, adapted with file-based state |

## Key Design Decision: No Separate LLM Call

ArmorClaw calls a planning LLM before tool execution. We considered and rejected these approaches for Claude Code:

| Approach | Why rejected |
|----------|-------------|
| Separate Anthropic API key | Requires extra credentials; doubles LLM cost |
| `prompt` hook type | Only returns yes/no, not structured output |
| `agent` hook type | Can't make HTTP calls to ArmorIQ backend |
| `claude -p` subprocess | Undocumented, recursive hook risk, adds latency |

**Chosen approach**: MCP tool called by Claude as part of its normal turn. Zero extra cost, zero extra latency, uses session credentials, enforced by PreToolUse denial.
