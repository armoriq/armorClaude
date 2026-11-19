# ArmorClaude

ArmorIQ intent-based security enforcement plugin for Claude Code and Claude Cowork. Enforces that an AI agent declares what it intends to do before doing it, and every action is checked against that declared intent.

## How It Works

```
User Prompt ──► Prompt identity ──► register_intent_plan ──► Signed token
                                                                        │
Tool Call ──► PreToolUse hook ──► Policy check ──► Intent verification ──┘
                                      │                    │
                                  deny/allow         drift detected?
                                                          │
Tool Result ──► PostToolUse hook ──► Audit log sent to IAP
```

1. **Before the agent acts**: Gives each root prompt an identity. Before the first tool that needs a plan, Claude calls `register_intent_plan` with a structured plan. ArmorIQ confirms the plan and returns a signed intent token. Chat only prompts create no plan.
2. **On every tool call**: Checks the tool against the approved plan, verifies the token hasn't expired, evaluates local policy rules (allow/deny by tool name, data classification like PCI/PII), and optionally verifies CSRG cryptographic proofs. Blocks execution if any check fails.
3. **After tool execution**: Sends audit logs to ArmorIQ IAP for compliance tracking.
4. **Enforcement**: An enforcing policy blocks tools that need a plan until registration is confirmed. Billing refusals keep the plan and policy checks local and show an upgrade notice. A policy that allows every tool continues to allow them.

### Workspace mode: Quiet, Show in chat, Block

A signed-in ArmorClaude follows the mode its workspace picks under **Tool calls in the chat** on the [Monitor page](https://tools.armoriq.ai/monitor), read at the start of each session.

- **Quiet** (the default): every tool call runs and nothing from ArmorClaude shows in the session. Each call your policy would have blocked or held is listed on the Monitor page.
- **Show in chat**: every tool call still runs, and the chat shows one line on each call your policy would have blocked or held, for example `ArmorIQ would block this call in Enforce (<reason>). Monitor let it run.`
- **Block**: blocked calls stop in the chat and held calls ask first, as described above.

A workspace admin picks the mode on the Monitor page, and can give one teammate their own mode in its **Teammates** card. A change applies from the next session.

`ARMORIQ_ORG_MODE=enforce` makes this machine block whatever the workspace says.

## Install

### One-line install (recommended)

```bash
curl -fsSL https://armoriq.ai/install_armorclaude.sh | bash
```

This adds the `armoriq` Claude Code marketplace and installs the `armorclaude` plugin. Dependencies are installed automatically on first hook fire.

### Manual install (Claude Code marketplace)

First install:

```bash
claude plugin marketplace add armoriq/armorClaude
claude plugin install armorclaude@armoriq
```

If the `armoriq` marketplace is already added, refresh it instead. Running `marketplace add` again
rewrites its settings entry and drops the auto-update setting:

```bash
claude plugin marketplace update armoriq
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
- **No API key is needed to start.** Until you sign in, the plugin runs in **local-only mode**
  (no data leaves your machine, see [Data & Privacy](#data--privacy)). Signing in with
  `armoriq login --product armorclaude` adds backend audit, intent tokens, and CSRG proofs.

If `claude mcp list` does not show `✓ Connected`, run the server directly from the plugin
directory to surface the install/startup error:

```bash
node scripts/bootstrap.mjs mcp
```

### Update / disable / uninstall

ArmorClaude updates itself. At session start, at most once a day, it checks in the background for a
newer version and runs `claude plugin update` for you; the session never waits for it. When it has
updated, it says so once: `ArmorClaude updated to X. Run /reload-plugins to use it.` The new version
loads on `/reload-plugins` or the next launch. The stable plugin moves when its version in
`marketplace.json` changes; `armorclaude-dev` moves with every commit on `dev`.

To keep updates manual, turn auto-update off for the `armoriq` marketplace (`/plugin`, Marketplaces,
`armoriq`) or set `ARMORCLAUDE_NO_AUTO_UPDATE=1`. ArmorClaude then only tells you once per version that
an update exists. The installer also turns on Claude Code's own marketplace auto-update as a backup;
Claude Code runs that only in an interactive session, up to 10 minutes after your first message.

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
├── install_armorclaude.sh        # Curl-able installer (armorclaude, production)
├── install_armorclaude_dev.sh    # Same for armorclaude-dev
├── scripts/
│   ├── bootstrap.mjs             # Auto-installs npm deps on first run
│   ├── hook-router.mjs           # Hook entrypoint (dispatches events)
│   ├── policy-mcp.mjs            # MCP server (policy_read, register_intent_plan)
│   └── lib/
│       ├── engine.mjs            # Main handlers for all hook events
│       ├── config.mjs            # Configuration (env vars + userConfig)
│       ├── plan-request.mjs      # Canonical plan hashes and stable request ids
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

ArmorClaude takes its ArmorIQ key and org only from `armoriq login --product armorclaude`,
which saves them in `~/.armoriq/credentials.json` for the backend ArmorClaude calls. There is no
key setting, and `ARMORIQ_API_KEY` is ignored.

### Plugin userConfig (recommended)

When installed as a Claude Code plugin, these values are prompted on enable:

| Key | Sensitive | Description |
|-----|-----------|-------------|
| `default_template` | No | Policy template proposed on first run for you to confirm |
| `disable_observability` | No | Turn off execution traces to your ArmorIQ dashboard |
| `disable_usage_sync` | No | Turn off token usage sync |

Whether calls are blocked comes from your login and the workspace mode above, not from a setting here.

### Environment Variables

**Core:**
| Variable | Default | Description |
|----------|---------|-------------|
| `ARMORIQ_ORG_MODE` | unset | `enforce` makes this machine block whatever the workspace mode says |
| `ARMORCLAUDE_DATA_DIR` | `$CLAUDE_PLUGIN_DATA` or `~/.claude/armorclaude` | Data storage directory |
| `ARMORCLAUDE_DEBUG` | `false` | Enable stderr debug logging |

**ArmorIQ Integration:**
| Variable | Default | Description |
|----------|---------|-------------|
| `ARMORCLAUDE_USE_SDK_INTENT` | `true` | Use ArmorIQ SDK for intent capture |
| `ARMORCLAUDE_INTENT_URL` | — | Custom intent endpoint (overrides SDK) |
| `ARMORCLAUDE_VERIFY_STEP_URL` | `<backend>/iap/verify-step` | IAP verify endpoint |
| `ARMORCLAUDE_BACKEND_ENDPOINT` | production or localhost | IAP backend URL |
| `ARMORCLAUDE_IAP_ENDPOINT` | production or localhost | CSRG service URL |
| `ARMORIQ_INTENT_VALIDITY_SECONDS` | `3600` | Token validity in seconds, from 180 to 3600. Invalid values stop startup. |

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
| `ARMORIQ_USAGE_SYNC_DISABLED` | `false` | Set to `true`/`1`/`yes` to stop the token usage sync. Applies only while observability is on. Equivalent to the `disable_usage_sync` plugin option. |
| `ARMORIQ_RUN_REPORTING_ENABLED` | `false` | Set to `true` only after every serving backend revision supports prompt ids. Reports prompt starts and turn endings, tool counts, confirmed plan ids and reasons for missing plans through `/iap/runs/batch`. Reports stay bound to the login at prompt start. Delivery pauses on logout or a missing endpoint. Authenticated monitor sessions are included. Run state and unsent receipts live beside the runtime file in `runtime.json.runs.json`. Each hook's switch value also controls daemon delivery until the next hook or daemon reload. `/armorclaude:armor status` shows pending and paused run reports. |

**Policy Management:**
| Variable | Default | Description |
|----------|---------|-------------|
| `ARMORCLAUDE_POLICY_UPDATE_ENABLED` | `true` | Allow runtime policy updates |
| `ARMORCLAUDE_POLICY_UPDATE_ALLOWLIST` | `*` | CSV of allowed actors |

## Hook Events

| Event | Handler | Purpose |
|-------|---------|---------|
| `SessionStart` | Initialize session, prune stale sessions | Lifecycle setup |
| `UserPromptSubmit` | Policy commands, prompt identity and plan directive | Pre-processing |
| `PreToolUse` | Policy check, intent verification, CSRG proofs, expired token guard | **Enforcement** |
| `PostToolUse` | Audit logging (success) | Compliance |
| `PostToolUseFailure` | Audit logging (failure) | Compliance |
| `Stop` | Close the prompt and stop its refreshes | Turn cleanup |
| `SessionEnd` | Remove session state | Lifecycle cleanup |

## Plan Generation

The `UserPromptSubmit` directive asks Claude to call `register_intent_plan` before the first tool that needs a plan. Claude writes the plan in the tool arguments using its current turn. Only this tool and `trust_reanchor` create plans. Plan mode files and ordinary tool calls create none.

The first registration in a prompt is `new`. A changed plan is a `revision`. Repeating a confirmed plan with a usable token sends no request. Retries reuse the saved request id, and a reply says registered only after backend confirmation. Prompt text stays on the machine.

The daemon checks open prompts every 15 seconds and refreshes tokens near expiry. Refreshes keep the counted plan id. They stop at `Stop` or after 30 minutes without activity. When process lookup is unavailable, including on Windows, session routing falls back to the active root session pointer.

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
- **Allow-all policy**: With the `all-allow` template, or with no confirmed policy yet, intent is captured but never blocks. Claude is still asked to register a plan, a signed intent token is requested, and audit rows are linked to that plan, but missing plans, drift, expired tokens and proof failures do not deny a tool call. The session banner shows `intent=capture`.

Audit delivery keeps transient failures pending without spending delivery attempts. An authentication
failure pauses only that login. The daemon checks the original credential every two minutes while it
is available. A successful check, another successful authenticated call with that same backend and
credential, or an explicit login restore lets delivery resume.

This version uses separate audit queue files and leaves released versions' files and cursors
untouched. Unsent older rows without a saved login binding and client row id stay local and are never
sent by this version. `/armor status` counts them as written by an older version and not sent by this
version. Older rows with a provable saved binding can be delivered under that original login, using
stable row ids and receipts in this version's storage. A released daemon can continue to drain its own
files alongside this version.

## Data & Privacy

ArmorClaude's security enforcement works by inspecting prompts and tool calls. **What leaves your
machine depends entirely on whether an ArmorIQ API key is configured:**

- **Local-only mode (not signed in).** Nothing is transmitted. Policy checks, intent-drift
  detection, and audit logging all run locally.
- **Connected mode (signed in).** The following is sent to the ArmorIQ backend
  (`api.armoriq.ai` / `iap.armoriq.ai`) to provide intent tokens, audit trails, and CSRG proofs:
  - The captured **prompt and structured intent plan** (goal + steps).
  - Per-step **audit logs** containing the tool name and its **inputs and outputs**.
  - **Observability execution traces** (spans for planning, policy checks, and tool
    inputs/outputs) — **on by default** in connected mode.
  - **Token usage** per Claude Code session, model and UTC hour, with the repo path and device name,
    for every session in `~/.claude/projects`, including sessions that ran without ArmorClaude.
    On by default while observability is on; see below to turn it off.

  Tool inputs and outputs are passed through secret redaction and parameter sanitization before
  transmission.

### Turning off observability

Observability traces are **enabled by default** when an API key is set. To disable them (audit
and intent enforcement still work):

- **Plugin option:** set `disable_observability: true` in the plugin's userConfig, **or**
- **Environment variable:** set `ARMORIQ_OBSERVABILITY_DISABLED=true` (also accepts `1` / `yes`).

Turning off observability also stops the token usage sync.

### Turning off the token usage sync

While observability is on, a background sync uploads token counts (per session, model and UTC hour,
with the repo path and device name) for every Claude Code session in `~/.claude/projects`,
including sessions that ran without ArmorClaude. It sends no prompts or transcript text. To stop
it and keep observability traces:

- **Plugin option:** set `disable_usage_sync: true` in the plugin's userConfig, **or**
- **Environment variable:** set `ARMORIQ_USAGE_SYNC_DISABLED=true` (also accepts `1` / `yes`).

- **Product overview and setup:** <https://armoriq.ai/tools/armorclaude>
- **Privacy policy (data collected, retention, opt-out):** <https://armoriq.ai/privacy-policy> (Section 6, "Product-Specific Data Flows")

## Tests

```bash
node --test tests/*.test.mjs
```
