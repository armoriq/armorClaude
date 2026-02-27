# ArmorCowork

ArmorIQ plugin scaffold for Claude Code with:
- `PreToolUse` enforcement hook
- `UserPromptSubmit` policy/intention handling
- plugin-bundled MCP policy server
- local policy engine (`allow` / `deny` / `require_approval`)
- ArmorIQ SDK intent issuance compatibility (`capturePlan` + `getIntentToken`)
- `/iap/verify-step` payload/response compatibility
- CSRG proof extraction and token `step_proofs` fallback

## Structure

- `.claude-plugin/plugin.json`: plugin manifest
- `hooks/hooks.json`: hook registration
- `.mcp.json`: plugin MCP server registration
- `scripts/hook-router.mjs`: hook entrypoint
- `scripts/policy-mcp.mjs`: MCP server for policy tools
- `scripts/lib/*.mjs`: policy, intent, runtime, and engine modules

## Install Locally

1. Build/install dependencies (none required currently):
```bash
cd /Users/kbhardwaj6/armoriq/ArmorCowork
npm install
```
2. Use plugin directly:
```bash
claude --plugin-dir /Users/kbhardwaj6/armoriq/ArmorCowork
```

3. Validate plugin:
```bash
claude plugin validate /Users/kbhardwaj6/armoriq/ArmorCowork
```

## Environment

Core:
- `ARMORCOWORK_MODE=enforce|monitor` (default: `enforce`)
- `ARMORCOWORK_INTENT_REQUIRED=true|false` (default: `false`)
- `ARMORCOWORK_DATA_DIR` (default: `~/.claude/armorcowork`)
- `ARMORCOWORK_POLICY_FILE` (default: `<data_dir>/policy.json`)
- `ARMORCOWORK_RUNTIME_FILE` (default: `<data_dir>/runtime.json`)
- `ARMORCOWORK_CONTEXT_HINTS_ENABLED=true|false` (default: `true`)

ArmorIQ optional endpoints:
- `ARMORIQ_API_KEY`
- `ARMORCOWORK_INTENT_URL`
- `ARMORCOWORK_VERIFY_STEP_URL`
- `ARMORCOWORK_USE_SDK_INTENT=true|false` (default: `true`)
- `ARMORCOWORK_USE_PRODUCTION=true|false` (default: depends on `ARMORIQ_ENV`)
- `ARMORCOWORK_BACKEND_ENDPOINT` / `BACKEND_ENDPOINT`
- `ARMORCOWORK_IAP_ENDPOINT` / `IAP_ENDPOINT`
- `ARMORCOWORK_PROXY_ENDPOINT` / `PROXY_ENDPOINT`
- `ARMORCOWORK_USER_ID`
- `ARMORCOWORK_AGENT_ID`
- `ARMORCOWORK_CONTEXT_ID`
- `ARMORCOWORK_VALIDITY_SECONDS` (default: `60`)
- `ARMORCOWORK_TIMEOUT_MS` (default: `8000`)
- `ARMORCOWORK_MAX_RETRIES` (default: `3`)
- `ARMORCOWORK_VERIFY_SSL=true|false` (default: `true`)
- `ARMORCOWORK_LLM_ID` (default: `claude-code`)
- `ARMORCOWORK_MCP_NAME` (default: `claude-code`)

CSRG verification:
- `REQUIRE_CSRG_PROOFS=true|false` (default: `true`)
- `CSRG_VERIFY_ENABLED=true|false` (default: `true`)

Policy updates:
- `ARMORCOWORK_POLICY_UPDATE_ENABLED=true|false` (default: `true`)
- `ARMORCOWORK_POLICY_UPDATE_ALLOWLIST` (CSV, default: `*`)

## Policy Commands

Policy commands are handled from user prompts and blocked from normal model processing after execution:

- `Policy list`
- `Policy get policy1`
- `Policy delete policy1`
- `Policy reset`
- `Policy update policy1: block web_fetch for payment data`
- `Policy new: block write for PII`
- `Policy prioritize policy2 1`

MCP tools exposed:
- `policy_update` (`text` or structured `update`)
- `policy_read` (`id` optional)

## Current Scope

Implemented:
- local policy enforcement in `PreToolUse`
- ArmorIQ SDK-compatible intent issuance (`capturePlan` + `getIntentToken`)
- optional external planning endpoint (`ARMORCOWORK_INTENT_URL`)
- ArmorIQ-compatible `/iap/verify-step` request contract
- CSRG proof handling:
  - explicit headers from hook input
  - fallback proof resolution from token `step_proofs`
  - duplicate-tool step disambiguation with per-session step usage tracking
- MCP policy server (`policy_update`, `policy_read`)

Not implemented yet:
- CSRG proof path extraction and cryptographic verification parity
- full audit trail export
