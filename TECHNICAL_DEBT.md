# ArmorClaude Technical Debt

## Legacy Flat Policy Rules Projection

Status: resolved

Resolved in branch: `codex/armor-policy-secure-ux`

Canonical source of truth: `armor.policy.v1`

The previous dual-shape policy model has been removed from active policy
flows. ArmorClaude no longer persists, stages, confirms, renders, or saves a
flat `{ id, action, tool }` rules mirror for active policy data.

### What Changed

- Proposal and diff rendering now compare canonical IR to canonical IR.
- Pending proposals store `proposedPolicy`, `basePolicyHash`, `proposalHash`,
  and JSON patch entries over `/statements`, `/metadata`, and `/defaults`.
- Built-in templates are authored as native `armor.policy.v1`.
- Profiles are saved and loaded as native `armor.policy.v1`; old profile files
  are migrated on read.
- Crypto policy token plans derive CSRG steps directly from IR statements.
- OPA/SDK compilers accept canonical IR first and carry the IR statements
  forward in compiled payloads.
- The old `policyIrToLegacyRules()` projection was removed from production
  code.

### Remaining Compatibility Boundary

Only one-time migration input remains:

- old local policy files with `policy.rules`
- old profile files with `policy.rules` or top-level `rules`
- old backend profile payloads that still contain flat `rules`
- explicit migration tests

Those inputs are immediately normalized into `armor.policy.v1` and are not
persisted back as flat rules.

### Done Criteria

- Active policy storage is canonical IR only.
- `/armor policy view` shows canonical IR only.
- New mutations never flatten IR and rebuild policy from flat rules.
- Draft, stage, confirm, save, profile switch, sync, and view preserve grouped
  IR statements.
- Legacy flat rules are used only as migration input.
