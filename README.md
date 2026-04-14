# ArmorCowork

ArmorIQ intent-based security enforcement plugin for Claude Code and Claude Cowork. Enforces that an AI agent declares what it intends to do before doing it, and every action is checked against that declared intent.

## How It Works

```
User Prompt ──► UserPromptSubmit hook ──► Intent plan captured ──► Signed token
                                                                        │
Tool Call ──► PreToolUse hook ──► Policy check ──► Intent verification ──┘
                                      │                    │
                                  deny/allow         drift detected?
                                                          │
Tool Result ──► PostToolUse hook ──► Audit log sent to IAP
```

1. **Before the agent acts**: Intercepts prompts, captures a structured plan (from Claude's built-in plan mode or an LLM fallback call), and sends it to ArmorIQ IAP for a signed intent token.
2. **On every tool call**: Checks the tool against the approved plan, verifies the token hasn't expired, evaluates local policy rules (allow/deny by tool name, data classification like PCI/PII), and optionally verifies CSRG cryptographic proofs. Blocks execution if any check fails.
3. **After tool execution**: Sends audit logs to ArmorIQ IAP for compliance tracking.
4. **Fail-closed**: If planning fails, identity is missing, or the token is invalid — all tool calls are blocked by default.

## Structure

```
armorcowork/
├── .claude-plugin/plugin.json    # Plugin manifest with userConfig
├── hooks/hooks.json              # Hook registration (7 lifecycle events)
├── .mcp.json                     # MCP server for policy tools
├── scripts/
│   ├── hook-router.mjs           # Hook entrypoint (dispatches events)
│   ├── policy-mcp.mjs            # MCP server (policy_update, policy_read)
│   └── lib/
│       ├── engine.mjs            # Main handlers for all hook events
│       ├── config.mjs            # Configuration (env vars + userConfig)
│       ├── planner.mjs           # Plan generation (plan file + LLM fallback)
│       ├── intent.mjs            # Intent token verification & CSRG proofs
│       ├── iap-service.mjs       # IAP backend (verify-step, audit, CSRG)
│       ├── crypto-policy.mjs     # Merkle tree policy binding (CSRG)
│       ├── policy.mjs            # Policy evaluation & management
│       ├── runtime-state.mjs     # Session & tool discovery tracking
│       ├── hook-output.mjs       # Hook response formatters
│       ├── fs-store.mjs          # JSON file I/O
│       └── common.mjs            # Utilities (sanitize, HTTP, hashing)
└── tests/                        # node:test test suite
```

## Install

```bash
cd armorcowork && npm install
claude --plugin-dir ./armorcowork
```

Or validate:
```bash
claude plugin validate ./armorcowork
```

## Configuration

### Plugin userConfig (recommended)

When installed as a Claude Code plugin, these values are prompted on enable:

| Key | Sensitive | Description |
|-----|-----------|-------------|
| `api_key` | Yes | ArmorIQ API key |
| `mode` | No | `enforce` (default) or `monitor` |
| `intent_required` | No | Require intent for all tools (default: `true`) |
| `crypto_policy_enabled` | No | Enable Merkle tree policy binding |
| `use_production` | No | Use production ArmorIQ endpoints |

### Environment Variables

**Core:**
| Variable | Default | Description |
|----------|---------|-------------|
| `ARMORCOWORK_MODE` | `enforce` | `enforce` blocks on failure, `monitor` logs only |
| `ARMORCOWORK_INTENT_REQUIRED` | `true` | Block tool calls with no intent token |
| `ARMORCOWORK_DATA_DIR` | `$CLAUDE_PLUGIN_DATA` or `~/.claude/armorcowork` | Data storage directory |
| `ARMORCOWORK_DEBUG` | `false` | Enable stderr debug logging |

**ArmorIQ Integration:**
| Variable | Default | Description |
|----------|---------|-------------|
| `ARMORIQ_API_KEY` | — | ArmorIQ SDK API key |
| `ARMORCOWORK_USE_SDK_INTENT` | `true` | Use ArmorIQ SDK for intent capture |
| `ARMORCOWORK_INTENT_URL` | — | Custom intent endpoint (overrides SDK) |
| `ARMORCOWORK_VERIFY_STEP_URL` | `<backend>/iap/verify-step` | IAP verify endpoint |
| `ARMORCOWORK_BACKEND_ENDPOINT` | production or localhost | IAP backend URL |
| `ARMORCOWORK_IAP_ENDPOINT` | production or localhost | CSRG service URL |
| `ARMORCOWORK_VALIDITY_SECONDS` | `60` | Intent token TTL |

**Plan Directive:**
| Variable | Default | Description |
|----------|---------|-------------|
| `ARMORCOWORK_PLANNING_ENABLED` | `true` | Inject directive telling Claude to register an intent plan |

**Crypto Policy Binding:**
| Variable | Default | Description |
|----------|---------|-------------|
| `ARMORCOWORK_CRYPTO_POLICY_ENABLED` | `false` | Merkle tree policy binding |
| `CSRG_URL` | IAP endpoint | CSRG service URL |
| `REQUIRE_CSRG_PROOFS` | `true` | Require cryptographic proofs |
| `CSRG_VERIFY_ENABLED` | `true` | Enable CSRG verification |

**Audit Logging:**
| Variable | Default | Description |
|----------|---------|-------------|
| `ARMORCOWORK_AUDIT_ENABLED` | `true` (when API key set) | Send audit logs to IAP |

**Policy Management:**
| Variable | Default | Description |
|----------|---------|-------------|
| `ARMORCOWORK_POLICY_UPDATE_ENABLED` | `true` | Allow runtime policy updates |
| `ARMORCOWORK_POLICY_UPDATE_ALLOWLIST` | `*` | CSV of allowed actors |

## Hook Events

| Event | Handler | Purpose |
|-------|---------|---------|
| `SessionStart` | Initialize session, prune stale sessions | Lifecycle setup |
| `UserPromptSubmit` | Policy commands, intent capture, LLM planning | Pre-processing |
| `PreToolUse` | Policy check, intent verification, CSRG proofs, ExitPlanMode capture | **Enforcement** |
| `PostToolUse` | Audit logging (success) | Compliance |
| `PostToolUseFailure` | Audit logging (failure) | Compliance |
| `Stop` | Token expiry check | Turn cleanup |
| `SessionEnd` | Remove session state | Lifecycle cleanup |

## Plan Generation

ArmorCowork supports two plan generation strategies:

### 1. Claude's Built-in Plan Mode (primary)
When Claude operates in plan mode, it writes a plan file and calls `ExitPlanMode`. ArmorCowork intercepts `ExitPlanMode` via the `PreToolUse` hook, parses the plan file, and sends it to ArmorIQ for intent token generation.

### 2. MCP Tool (when plan mode is off)
A directive injected via `UserPromptSubmit` instructs Claude to call `register_intent_plan` as its first tool call. Claude produces the plan as the tool's arguments — using its own LLM in the same turn, with no separate API key or extra LLM call. The MCP tool handler sends the plan to ArmorIQ for a signed intent token.

## Policy Commands

From the chat prompt:
- `Policy list` — show all rules
- `Policy get <id>` — show specific rule
- `Policy delete <id>` — remove rule
- `Policy reset` — clear all rules
- `Policy new: block web_fetch for payment data` — create rule
- `Policy update <id>: allow write` — modify rule
- `Policy prioritize <id> <position>` — reorder

MCP tools: `policy_update`, `policy_read`

## Security Model

- **Intent Drift Detection**: Every tool call is checked against the approved plan. Unauthorized tools are blocked.
- **Token Expiry**: Intent tokens have configurable TTL (default 60s). Expired tokens block all tool calls.
- **Data Class Detection**: Automatic PCI, PAYMENT, PHI, PII detection in tool parameters.
- **Crypto Policy Binding**: Optional Merkle tree binding via CSRG ensures policy rules can't be tampered with after token issuance.
- **Audit Trail**: Every tool execution (success/failure) is logged to ArmorIQ IAP.
- **Fail-Closed**: Missing tokens, failed planning, invalid proofs — all result in denied tool calls in enforce mode.

## Tests

```bash
node --test tests/*.test.mjs
```
