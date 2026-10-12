# Changelog

Changes to the ArmorClaude plugin, newest first. An install picks up code only when the plugin version changes, so each pull request is listed under the first version that shipped it. Versions 0.2.3 to 0.2.9 shipped on the stable channel (`armorclaude`, from `main`); 0.2.9 to 0.2.18 on the dev channel (`armorclaude-dev`, from `dev`).

## [Unreleased]

- Publish armorclaude-dev variant in the marketplace catalog (#142)
- Track latest compatible SDK on both branches with Dependabot (#143)

## [0.2.18] - 2026-10-12

- feat(usage): send Claude session titles with the usage upload (#410)
- feat(usage): send per-message usage records with the usage upload (#411)

## [0.2.17] - 2026-10-12

- fix(daemon): follow the current login on every hook (#362)
- fix(daemon): keep one audit WAL per login and ship it with that login's key (#365)
- fix(intent): stop passing useProduction to the SDK client (#368)
- fix(guard): match real write targets and policy-handler runs; keep large results under the daemon cap (#370)
- fix(audit): write a blocked audit row on every PreToolUse deny (#373)
- fix(audit): record a repeated tool against the next unused plan step (#379)
- feat(observability): one generation span per assistant message at Stop (#396)
- feat(usage): post full-turn latency from the live upload (#397)
- feat(intent): send the Claude session id as the intent token's context (#398)
- feat(enforce): deny the tools the intent token's plan check denies (#399)
- fix(auth): send the API key once in x-api-key (#400)

## [0.2.16] - 2026-10-10

- feat(usage-sync): add the per-session live usage uploader (part 1 of 2, #326) (#331)
- feat(usage-sync): post each session's usage on Stop on its own (part 2 of 2, #326) (#327)
- feat(usage-sync): keep live usage batches on disk until they are acknowledged (part 1 of 2, #335) (#336)
- feat(usage-sync): add a single-pass usage worker for discovery and earlier history (part 2 of 2, #335) (#337)
- feat(usage-sync): run the usage worker on a timer while a session is open (#346)
- refactor(usage-sync): delete the old usage scanner (#347)

## [0.2.15] - 2026-10-09

- fix(login): name the backend and the dev CLI when no armorclaude login loads (#321)
- fix(tokens): report subagent usage with its session; backfill sessions, not files (#155)
- feat(tokens): sync token usage per UTC hour for every local Claude Code session (#160)
- feat(tokens): run the usage sync from the hooks and the daemon (#214)
- feat(tokens): add a disable_usage_sync option under observability (#162)
- chore(tokens): remove scripts/backfill.mjs, which the usage sync replaces (#166)
- fix(tokens): report failed usage-sync posts by status and reason (#181)
- fix(tokens): write the usage sync log, request marker and lock owner-only (#182 part 2) (#184)
- fix(usage): a session posts only the messages it wrote, not a fork's copies (#247)
- fix(usage-sync): keep sync state per user of the API key (#270)
- feat(usage-sync): upload a device's earlier history when the dashboard asks (#274)
- feat(usage-sync): assign usage to users by login history (#290)

## [0.2.14] - 2026-10-09

- fix(audit): link audit rows to the plan by id and fit them under the WAL cap (#296)
- fix(intent): capture intent under an allow-all policy instead of turning it off (#297)
- fix(marketplace): install armorclaude-dev over HTTPS, not SSH (#300)
- fix(marketplace): drop the version from the armorclaude-dev entry (#301)

## [0.2.13] - 2026-10-09

- fix(config): take the key and org only from the armorclaude login profile (#173)
- Expose accepted login identity and durable history (#284)

## [0.2.12] - 2026-10-08

- fix(obs): a slash-command event carries its own call id, so a replay knows its span landed (#218)
- fix(obs): each hook span ends at its event's time, and a tool span lasts its duration_ms (#222)
- fix(obs): a fallback hook starts a detached shipper, so the spool ships with no daemon (#220)

## [0.2.11] - 2026-10-06

- fix(daemon): log daemon failures and in-process fallbacks to daemon.log (#161)
- fix(daemon): keep the socket path inside sun_path for any data dir (#172)
- test: fail any test process that connects outside loopback (#176)
- fix(store): write the audit log and plugin state owner-only (#182 part 1) (#183)
- test: stop the daemons the state-file-mode tests start (#189)
- Migrate dev observability bridge to SDK 0.7 Otel API (part 1) (#149)
- Migrate dev observability bridge to SDK 0.7 Otel API (part 2) (#150)
- chore(obs): remove the vendored obs-recorder and the axios dependency (#171)
- fix(obs): export the deciding rule's code as the policy reason code, never the reason text (#206)
- fix(obs): drain daemon exports past 1.5 s and close with the options object (#195)
- fix(obs): wait for the policy lease and share it through an owner-only file (#196)
- fix(obs): pass Claude Code's tool_use_id as the call id of policy and tool spans (#197)
- fix(obs): spool fallback hook spans for the daemon to ship (#198)
- fix(obs): the daemon writes its spans to the spool and ships them from there (#207)
- fix(obs): journal the events the daemon answers so a SIGKILL loses none of them (#199)
- fix(obs): keep events recorded without a policy lease and record them once one arrives (#202)

## [0.2.10] - 2026-09-23

- Fix dev installer to install the armorclaude-dev variant (#141)
- chore(deps): bump @modelcontextprotocol/sdk from 1.29.0 to 1.30.0 (#146)
- chore(deps): bump zod from 3.25.76 to 4.6.5 (#148)
- fix(tokens): report token usage per day with repo and device (#152)

## [0.2.9] - 2026-08-12

- feat(policy): new users default to all-allow (frictionless onboarding) (#102)
- fix(enforcement): honor the policy you set (allow/deny/hold) regardless of subscription (#101)
- fix(mcp): resolve bootstrap via ${CLAUDE_PLUGIN_ROOT} so the MCP server registers on install (#105)
- docs: surface privacy policy URL in manifest and README per Anthropic review (#106)
- fix(engine): only inject register_intent_plan directive when intent is enforced (#107)
- docs: note `armoriq register` is Python-CLI + macOS pip3 gotcha (#108)
- fix(engine): record session-scoped audit in all-allow mode (#117)
- fix(plugin): repair MCP bootstrap path, enforce registered plan before minting (#118)
- fix(armor): say that a confirmed policy is session-local until the dashboard confirms it (#119)
- ci: add Pullfrog agent workflow (#120)
- chore: add SECURITY.md and CODEOWNERS (#123)
- fix(observability): require SDK exports used by telemetry (#124)
- fix(plugin): monitor mode when not connected (don't brick fresh install) (#99)
- feat(observability): session slash commands, MCP category, and connect event (#122)
- fix(engine): exempt /armorclaude:armor management skill from policy (unblock the escape hatch) (#103)
- feat: one-shot token-usage backfill for historical sessions (#128)
- fix: use @armoriq/sdk-dev on dev branch (#57)
- fix: bootstrap --ignore-scripts + sdk-dev path (#60)
- feat: pull active dashboard policy on SessionStart (#64)
- fix(engine): capture real per-tool duration instead of hardcoding 0 (#109)

## [0.2.8] - 2026-07-14

- feat: optional default_template in /plugin configure (staged for confirm on first run) (#94)
- fix(sync): pull confirmed dashboard policy on session start (dashboard = source of truth) (#95)
- feat(tokens): report per-session token usage to the dashboard (#96)
- chore(deps): bump @armoriq/sdk to ^0.6.2 (#97)
- feat(observability): armorClaude observability bridge + real-session fixes (#98)

## [0.2.7] - 2026-07-03

- docs(installer): surface optional policy bundles in finale (#92)
- fix(bootstrap): npm install fails on Windows (exit null) — run through shell (#93)

## [0.2.6] - 2026-07-03

- feat(policy): multi-bundle template install with most-restrictive merge (0.2.6) (#91)

## [0.2.5] - 2026-07-03

- chore: add MIT LICENSE and tighten package.json metadata (#67)
- fix(plugin-manifests): point homepage at armoriq.ai/tools/armorclaude (#69)
- chore: clean up public repo (remove internal docs/scripts + drop armorclaude-dev) (#71)
- Soften /armor command UX: tag handled responses instead of bare "bloc… (#72)
- chore(assets): add ArmorClaude brand logo SVG (#74)
- fix: seed builtin profiles eagerly on daemon startup (#75)
- fix: show /armorclaude:armor prefix in all user-facing prompts (#76)
- fix: register /armor as a global bare slash command (#77)
- fix: use relative path for MCP bootstrap in .mcp.json (#79)
- fix: policy template falls back to seeded profiles on disk (#78)
- fix: sync confirmed policy to backend for all engines (#80)
- fix(policy): sync terminal policy to backend as a staged proposal (#89)

## [0.2.4] - 2026-06-08

- fix: default ARMORIQ_ENV to production on main branch (#62)

## [0.2.3] - 2026-06-08

- feat(marketplace): list both armorclaude (prod) and armorclaude-dev variants (#51)
- fix: extend intent token validity to 1 hour and flush audit WAL on exit (#52)
- Add Husky pre-commit hook (#19)
- Improve ArmorClaude policy hold UX and reports (#53)
- Ignore generated report artifacts (#54)
- Fix ArmorClaude dev/staging endpoint resolution (#55)
- fix: bump @armoriq/sdk to ^0.3.7 (#58)
- fix: bootstrap --ignore-scripts for plugin install (#59)
