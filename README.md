# ArmorClaude

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

## Install

### One-line install (recommended)

```bash
curl -fsSL https://armoriq.ai/install_armorclaude.sh | bash
```

This adds the `armoriq` Claude Code marketplace and installs the `armorclaude` plugin. Dependencies are installed automatically on first hook fire.

### Manual install (Claude Code marketplace)

```bash
claude plugin marketplace add armoriq/armorClaude
claude plugin install armorclaude@armoriq
```

### Verify

```bash
claude plugin list
# ❯ armorclaude@armoriq  Status: ✔ enabled

claude mcp list | grep armorclaude
# plugin:armorclaude:armorclaude-policy: ... ✓ Connected
```

### First-run behavior

The plugin ships its Node dependencies uninstalled. On the **first launch** (first hook fire or
first MCP-server start), `scripts/bootstrap.mjs` performs a **one-time `npm install`** and prints
to stderr:

```
[armorclaude] installing dependencies (one-time)...
```

- Requires **Node.js >= 20** and **npm on PATH**, plus **network access on that first run**.
- The bundled MCP server (`armorclaude-policy`) registers once dependencies finish installing;
  it stays connected on subsequent runs without reinstalling.
- **No API key is needed to start.** With `api_key` blank the plugin runs in **local-only mode**
  (no data leaves your machine — see [Data & Privacy](#data--privacy)); a key only adds backend
  audit, intent tokens, and CSRG proofs.

If `claude mcp list` does not show `✓ Connected`, run the server directly from the plugin
directory to surface the install/startup error:

```bash
node scripts/bootstrap.mjs mcp
```

### Update / disable / uninstall

```bash
claude plugin update armorclaude
claude plugin disable armorclaude   # turn off without removing
claude plugin enable  armorclaude
claude plugin uninstall armorclaude
```

### Requirements

- Claude Code 2.x (`claude --version`)
- Node.js >= 20
- (Optional) ArmorIQ API key for backend audit + CSRG proofs — get one at https://armoriq.ai

> **Getting an API key via the CLI:** account registration (`armoriq register`) is provided by
> the Python CLI, not the TypeScript CLI. Install it with `pip3 install armoriq-sdk`, then run
> `armoriq register`. On macOS use **`pip3`** (plain `pip` is often not on `PATH`).

## Structure

```
armorClaude/
├── .claude-plugin/
│   ├── plugin.json               # Plugin manifest with userConfig
│   └── marketplace.json          # Marketplace listing for `claude plugin install`
├── hooks/hooks.json              # Hook registration (7 lifecycle events)
├── .mcp.json                     # MCP server for policy + intent tools
├── install_armorclaude.sh        # Curl-able installer
├── scripts/
│   ├── bootstrap.mjs             # Auto-installs npm deps on first run
│   ├── hook-router.mjs           # Hook entrypoint (dispatches events)
│   ├── policy-mcp.mjs            # MCP server (policy_read, register_intent_plan)
│   └── lib/
│       ├── engine.mjs            # Main handlers for all hook events
│       ├── config.mjs            # Configuration (env vars + userConfig)
│       ├── planner.mjs           # Plan parsing (plan file + JSON block)
│       ├── intent.mjs            # Intent token verification & CSRG proofs
│       ├── iap-service.mjs       # IAP backend (verify-step, audit, CSRG)
│       ├── crypto-policy.mjs     # Merkle tree policy binding (CSRG)
│       ├── policy.mjs            # Policy evaluation & management
│       ├── runtime-state.mjs     # Session & tool discovery tracking
│       ├── hook-output.mjs       # Hook response formatters
│       ├── fs-store.mjs          # JSON file I/O
│       └── common.mjs            # Utilities (sanitize, HTTP, hashing)
└── tests/                        # node:test test suite (48 tests)
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
| `ARMORCLAUDE_MODE` | `enforce` | `enforce` blocks on failure, `monitor` logs only |
| `ARMORCLAUDE_INTENT_REQUIRED` | `true` | Block tool calls with no intent token |
| `ARMORCLAUDE_DATA_DIR` | `$CLAUDE_PLUGIN_DATA` or `~/.claude/armorclaude` | Data storage directory |
| `ARMORCLAUDE_DEBUG` | `false` | Enable stderr debug logging |

**ArmorIQ Integration:**
| Variable | Default | Description |
|----------|---------|-------------|
| `ARMORIQ_API_KEY` | — | ArmorIQ SDK API key |
| `ARMORCLAUDE_USE_SDK_INTENT` | `true` | Use ArmorIQ SDK for intent capture |
| `ARMORCLAUDE_INTENT_URL` | — | Custom intent endpoint (overrides SDK) |
| `ARMORCLAUDE_VERIFY_STEP_URL` | `<backend>/iap/verify-step` | IAP verify endpoint |
| `ARMORCLAUDE_BACKEND_ENDPOINT` | production or localhost | IAP backend URL |
| `ARMORCLAUDE_IAP_ENDPOINT` | production or localhost | CSRG service URL |
| `ARMORCLAUDE_VALIDITY_SECONDS` | `60` | Intent token TTL |

**Plan Directive:**
| Variable | Default | Description |
|----------|---------|-------------|
| `ARMORCLAUDE_PLANNING_ENABLED` | `true` | Inject directive telling Claude to register an intent plan |

**Crypto Policy Binding:**
| Variable | Default | Description |
|----------|---------|-------------|
| `ARMORCLAUDE_CRYPTO_POLICY_ENABLED` | `false` | Merkle tree policy binding |
| `CSRG_URL` | IAP endpoint | CSRG service URL |
| `REQUIRE_CSRG_PROOFS` | `true` | Require cryptographic proofs |
| `CSRG_VERIFY_ENABLED` | `true` | Enable CSRG verification |

**Audit Logging:**
| Variable | Default | Description |
|----------|---------|-------------|
| `ARMORCLAUDE_AUDIT_ENABLED` | `true` (when API key set) | Send audit logs to IAP |

**Observability:**
| Variable | Default | Description |
|----------|---------|-------------|
| `ARMORIQ_OBSERVABILITY_DISABLED` | `false` | Set to `true`/`1`/`yes` to stop sending execution traces to the ArmorIQ dashboard. Observability is **on by default** when an API key is set — see [Data & Privacy](#data--privacy). Equivalent to the `disable_observability` plugin option. |

**Policy Management:**
| Variable | Default | Description |
|----------|---------|-------------|
| `ARMORCLAUDE_POLICY_UPDATE_ENABLED` | `true` | Allow runtime policy updates |
| `ARMORCLAUDE_POLICY_UPDATE_ALLOWLIST` | `*` | CSV of allowed actors |

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

ArmorClaude supports two plan generation strategies:

### 1. Claude's Built-in Plan Mode (primary)
When Claude operates in plan mode, it writes a plan file and calls `ExitPlanMode`. ArmorClaude intercepts `ExitPlanMode` via the `PreToolUse` hook, parses the plan file, and sends it to ArmorIQ for intent token generation.

### 2. MCP Tool (when plan mode is off)
A directive injected via `UserPromptSubmit` instructs Claude to call `register_intent_plan` as its first tool call. Claude produces the plan as the tool's arguments — using its own LLM in the same turn, with no separate API key or extra LLM call. The MCP tool handler sends the plan to ArmorIQ for a signed intent token.

## Policy Commands

Policy mutation is human-only. Commands run in the `UserPromptSubmit` hook before Claude's LLM sees the prompt; Claude can read policy through MCP but cannot update it.

Primary commands:
- `/armor` — show policy command help
- `/armor policy list` — show all rules
- `/armor policy add allow Read and Grep, deny Write, hold Bash` — stage deterministic policy changes
- `/armor policy confirm [proposal-id]` — apply a staged proposal
- `/armor policy cancel [proposal-id]` — discard a staged proposal
- `/armor yes` — apply the current staged proposal
- `/armor no` — discard the current staged proposal
- `/armor policy rebind` — reissue the crypto policy token for the current policy
- `/armor profile save <name>` — save the current policy as a profile
- `/armor mcp approve <server>` — approve an MCP server

Rules staged with `hold` / `require_approval` use Claude Code's native tool approval UI at `PreToolUse` time after ArmorClaude policy and intent checks pass. Unknown MCP servers also use native approval for a one-time tool call; use `/armor mcp approve <server>` only when you want to trust that server persistently.

Legacy `/armor-policy ...` is intentionally unsupported. Use `/armor ...` only.

Beginner guide: [ArmorClaude Policy Guide](./POLICY_GUIDE.md)

MCP tools: `policy_read`, `register_intent_plan`, and Trust Update tools. There is intentionally no `policy_update` MCP tool.

## Security Model

- **Intent Drift Detection**: Every tool call is checked against the approved plan. Unauthorized tools are blocked.
- **Token Expiry**: Intent tokens have configurable TTL (default 60s). Expired tokens block all tool calls.
- **Data Class Detection**: Automatic PCI, PAYMENT, PHI, PII detection in tool parameters.
- **Crypto Policy Binding**: Optional Merkle tree binding via CSRG ensures policy rules can't be tampered with after token issuance.
- **Audit Trail**: Every tool execution (success/failure) is logged to ArmorIQ IAP.
- **Fail-Closed**: Missing tokens, failed planning, invalid proofs — all result in denied tool calls in enforce mode.

## Data & Privacy

ArmorClaude's security enforcement works by inspecting prompts and tool calls. **What leaves your
machine depends entirely on whether an ArmorIQ API key is configured:**

- **Local-only mode (no `api_key`)** — nothing is transmitted. Policy checks, intent-drift
  detection, and audit logging all run locally.
- **Connected mode (`api_key` set)** — the following is sent to the ArmorIQ backend
  (`api.armoriq.ai` / `iap.armoriq.ai`) to provide intent tokens, audit trails, and CSRG proofs:
  - The captured **prompt and structured intent plan** (goal + steps).
  - Per-step **audit logs** containing the tool name and its **inputs and outputs**.
  - **Observability execution traces** (spans for planning, policy checks, and tool
    inputs/outputs) — **on by default** in connected mode.

  Tool inputs and outputs are passed through secret redaction and parameter sanitization before
  transmission.

### Turning off observability

Observability traces are **enabled by default** when an API key is set. To disable them (audit
and intent enforcement still work):

- **Plugin option:** set `disable_observability: true` in the plugin's userConfig, **or**
- **Environment variable:** set `ARMORIQ_OBSERVABILITY_DISABLED=true` (also accepts `1` / `yes`).

- **Product overview and setup:** <https://armoriq.ai/tools/armorclaude>
- **Privacy policy (data collected, retention, opt-out):** <https://armoriq.ai/privacy-policy> (Section 6, "Product-Specific Data Flows")

## Tests

```bash
node --test tests/*.test.mjs
```
