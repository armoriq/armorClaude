# ArmorClaude Demo Script

A 90-second demo that takes a viewer from "what is this" to "I see it block a tool call." Designed to be screen-recorded with voiceover.

## Setup (do this before recording)

```bash
# Make sure plugin is NOT installed yet
claude plugin uninstall armorclaude 2>/dev/null
claude plugin marketplace remove armoriq 2>/dev/null

# Open a terminal sized at ~110 cols × 30 rows
# Open a fresh project directory
mkdir -p /tmp/armorclaude-demo && cd /tmp/armorclaude-demo
echo "# Demo project" > README.md
```

## Take 1 — install (15 sec)

**On screen:**
```
$ curl -fsSL https://armoriq.ai/install_armorclaude.sh | bash
```

**Voiceover:**
> "ArmorClaude installs in one curl command. It adds a Claude Code marketplace and installs the security plugin."

**Show the output until you see `ArmorClaude is installed.`**

## Take 2 — verify (10 sec)

**On screen:**
```
$ claude plugin list
$ claude mcp list | grep armorclaude
```

**Voiceover:**
> "The plugin is enabled, and its policy MCP server is connected. No backend, no API key — just intent enforcement out of the box."

## Take 3 — see it allow what's planned (25 sec)

**On screen — open Claude Code:**
```
$ claude
```

**Type the prompt:**
> Read README.md and tell me what's in it.

**Voiceover during the response:**
> "ArmorClaude tells Claude to register its plan first. Claude calls `register_intent_plan` declaring that it intends to use `Read`. Then when Claude actually calls `Read`, ArmorClaude checks the call against the plan — `Read` is in the plan, so it passes through."

**Highlight in the transcript:**
- The `register_intent_plan` tool call
- The plan content (`{"goal": "...", "steps": [{"action": "Read"}]}`)
- The successful `Read`

## Take 4 — see it block intent drift (25 sec)

**Same Claude Code session, type:**
> Now run a shell command to list everything in /etc.

**What happens:**
- Claude tries `Bash` without re-registering the plan
- `PreToolUse` hook returns `deny: ArmorCowork intent drift: tool not in plan (Bash)`
- Claude sees the denial, registers a new plan that includes `Bash`, and retries

**Voiceover:**
> "Claude tried `Bash` — but `Bash` wasn't in the original plan. ArmorClaude blocked it as intent drift. The agent has to declare what it intends to do before doing it. This stops prompt injection from quietly steering an agent into running unauthorized commands."

## Take 5 — policy rules (15 sec)

**Same session, type:**
> Policy new: deny WebFetch

**Then ask:**
> Fetch the contents of https://example.com.

**What happens:**
- ArmorClaude denies WebFetch via the policy rule, regardless of plan

**Voiceover:**
> "Beyond intent, you can declare hard policy rules — like 'never call WebFetch.' These are evaluated before intent and block the tool no matter what plan Claude registers."

## Take 6 — wrap (10 sec)

**On screen:**
```
$ exit
$ claude plugin disable armorclaude  # one-line off
```

**Voiceover:**
> "Three layers of defense — intent, policy, audit — added to Claude Code in a single curl command. Repo, docs, and the optional ArmorIQ backend at github.com/armoriq/armorClaude."

## Total: ~90 seconds

## Recording tips

- Use **asciinema** or **OBS** at 30fps — clear text, low file size
- Record with `claude --no-spinner` if the spinner distracts
- Set `ARMORCOWORK_DEBUG=true` if you want to show stderr decisions live
- For the "allow" case, pause on the `register_intent_plan` MCP call so viewers can see the plan
- For the "deny" case, the red `✘ ArmorCowork intent drift` message is the money shot — let it sit on screen for a beat

## What to capture for the post

- 30-sec GIF of the install + intent drift block (Take 1 + 4 condensed) — best for tweets
- Full 90-sec MP4 — best for landing page
- One screenshot of `claude plugin list` showing armorclaude enabled — best for the marketplace listing
