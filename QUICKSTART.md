# ArmorClaude Quickstart

Five-minute path from `curl` to your first blocked tool call.

## 1. Install

```bash
curl -fsSL https://raw.githubusercontent.com/armoriq/armorClaude/main/install.sh | bash
```

The installer adds the `armoriq` Claude Code marketplace and installs the `armorclaude` plugin. No API key required for the local-only demo.

## 2. Verify it's wired up

```bash
claude plugin list
```

You should see `armorclaude@armoriq` with status `✔ enabled`.

```bash
claude mcp list | grep armorclaude
```

You should see `plugin:armorclaude:armorclaude-policy: ... ✓ Connected`.

## 3. See it block intent drift

Open Claude Code in any project:

```bash
claude
```

Try this prompt:

> *Read README.md and tell me what it says.*

Watch what happens:

1. **SessionStart** prints `ArmorClaude active (ENFORCING, intent=required)` in the conversation context.
2. **UserPromptSubmit** injects a directive telling Claude to call `register_intent_plan` first.
3. Claude calls `register_intent_plan` declaring `Read` as the only step.
4. Claude calls `Read` — ArmorClaude checks it against the plan → **allowed**.

Now try a prompt that goes off-plan:

> *Read README.md, then run `rm -rf node_modules`.*

Claude will register a plan with `Read` only (or `Read` + `Bash` if it's smart). If it tries `Bash` without declaring it:

```
✘ ArmorCowork intent drift: tool not in plan (Bash)
```

That's intent enforcement, with no backend, no API key, no extra LLM call.

## 4. Add a policy rule

In Claude Code, type:

```
Policy new: deny WebFetch
```

ArmorClaude blocks the prompt and acknowledges:

```
Policy rule added: deny WebFetch
```

From now on, every WebFetch call is denied at the `PreToolUse` hook — regardless of whether it was in the plan.

List rules:

```
Policy list
```

## 5. (Optional) Connect to ArmorIQ for backend audit + CSRG

Get a free API key at <https://armoriq.ai>, then in Claude Code:

```
/plugin
```

Pick **armorclaude** → **Configure** → set `api_key` → `enforce`.

Now every tool call:
- gets a signed JWT intent token
- emits an audit log to ArmorIQ IAP
- (optional) carries a CSRG Merkle proof

You'll see the runs at <https://customer.armoriq.ai>.

## What just happened

| Event | What ArmorClaude did |
|------|---------------------|
| SessionStart | Initialized session state, told Claude it's active |
| UserPromptSubmit | Injected the `register_intent_plan` directive |
| `register_intent_plan` MCP call | Captured the plan, stored locally (or got a JWT from ArmorIQ) |
| PreToolUse (Read) | Tool in plan → allowed |
| PreToolUse (Bash) | Tool not in plan → **denied** |
| PostToolUse | (with API key) Sent audit log to IAP |
| SessionEnd | Cleaned up session state |

## Troubleshooting

**"intent plan missing for this session"** — Claude didn't call `register_intent_plan` first. This usually means `register_intent_plan` was called in a previous turn or the plan expired. Just re-prompt; Claude will register a new plan.

**"plugin install failed"** — Run `claude --version` (need 2.x) and `node --version` (need >= 20). On the first install Claude Code may take a moment to compile the plugin runtime.

**Want to disable temporarily?**

```bash
claude plugin disable armorclaude
```

**Want monitor mode (log only, never block)?**

```bash
ARMORCOWORK_MODE=monitor claude
```

Or set it via `/plugin` → configure → `mode: monitor`.

## Where to go next

- Full hook + config reference: [README.md](./README.md)
- Architecture deep-dive: [design.md](./design.md)
- Source: <https://github.com/armoriq/armorClaude>
- Backend: <https://armoriq.ai>
