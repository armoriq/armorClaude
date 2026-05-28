# ArmorClaude Policy Guide

ArmorClaude controls what Claude Code is allowed to do with tools.

You can use policy to:

- allow Claude to read files
- block Claude from writing files
- require approval before Bash
- allow only safe Bash commands such as `ls` or `grep`
- block commands such as `psql`, `gcloud`, or destructive shell operations
- save policies as reusable profiles

Claude can read policy and suggest drafts, but only you can activate policy.

## Basic Commands

Show help:

```text
/armor
```

Show the active policy:

```text
/armor policy list
```

Create a policy proposal:

```text
/armor policy add allow Read and Grep, deny Write
```

Apply a proposal:

```text
/armor policy confirm <proposal-id>
```

Discard a proposal:

```text
/armor policy cancel <proposal-id>
```

Save the current policy as a reusable profile:

```text
/armor profile save intern-policy
```

## Simple Example

Type:

```text
/armor policy add allow Read and Grep, deny Write, hold Bash
```

ArmorClaude responds with a proposal:

```text
Parsed deterministically.

Changes:
+ permit tool Read
+ permit tool Grep
+ forbid tool Write
+ require approval for Bash

Next:
  /armor policy confirm pol_1234abcd
  /armor policy cancel pol_1234abcd
```

Nothing is active until you confirm.

## Complex Natural Language Example

Type:

```text
/armor policy add "only allow intern-safe bash file checks, curl, ls, port checks, deny psql and gcloud, save as intern-policy"
```

ArmorClaude should not activate this immediately. It shows a draft:

```text
Drafted from natural language. Not staged.

Ambiguities:
- curl can access external network. Should all URLs be allowed?
- port checks could mean lsof, netstat, ss, nc, or nmap.
- file access could mean read-only or write access.

Draft JSON:
...
```

Read the draft carefully. If it is correct:

```text
/armor policy stage <draft-id>
/armor policy confirm <proposal-id>
```

If it is wrong, revise your request or paste corrected JSON.

## Policy Lifecycle

```text
draft -> stage -> confirm
```

- **Draft** means candidate JSON only. It is not active and is not enforceable.
- **Stage** means a pending proposal exists with an id, hash, base version, and expiry.
- **Confirm** means the exact staged proposal becomes active policy.

## Safety Rules

ArmorClaude never silently updates policy.

A policy change requires:

1. A human submits `/armor policy ...`.
2. The hook validates JSON.
3. The hook shows a diff.
4. The human confirms the proposal id.
5. The hook verifies hash, version, and expiry.
6. The policy is saved.

Claude cannot skip this flow.

Claude cannot:

- call a write-capable policy MCP tool
- use the policy skill to activate policy
- directly edit `policy.json`
- directly edit staged proposals
- import and call the policy command module through Bash

## Reading Diffs

A policy diff looks like:

```text
+ permit tool Read
+ forbid tool Write
+ permit Bash when bash.program in ["ls", "grep"]
- permit tool WebFetch
```

`+` means added.

`-` means removed.

`permit` means allowed.

`forbid` means blocked.

`require approval` means Claude must ask before using it.

## Recommended Starter Policies

Read-only:

```text
/armor policy add allow Read and Grep and Glob, deny Write and Edit and Bash
```

Balanced:

```text
/armor policy add allow Read and Grep and Glob, hold Bash and Write and Edit
```

Intern-safe:

```text
/armor policy add allow Read and Grep and Glob, hold Bash, deny Write and Edit
```

## How To Know It Worked

Run:

```text
/armor policy list
```

Then ask Claude to do something blocked, such as writing a file. ArmorClaude should deny it.

## Policy JSON

ArmorClaude stores policy in a stable JSON format called `armor.policy.v1`.

It uses an enterprise-style structure:

- `principal`: who is acting
- `action`: what they want to do
- `resource`: what they act on
- `conditions`: when it is allowed
- `effect`: `permit`, `forbid`, or `require_approval`

Example:

```json
{
  "schemaVersion": "armor.policy.v1",
  "kind": "PolicyProfile",
  "metadata": {
    "name": "intern-policy",
    "description": "Intern-safe Claude Code policy"
  },
  "defaults": {
    "decision": "deny",
    "conflictResolution": "deny_overrides"
  },
  "statements": [
    {
      "id": "allow-read-tools",
      "effect": "permit",
      "principal": { "type": "agent", "id": "claude-code" },
      "action": { "type": "tool", "in": ["Read", "Grep", "Glob"] },
      "resource": { "type": "workspace", "scope": "current" },
      "conditions": []
    }
  ]
}
```

ArmorClaude uses this JSON as its source of truth and can compile it to OPA-style policy data for scalable enforcement later.
