#!/usr/bin/env python3
"""Generate ArmorClaude Policy Redesign PDF report."""

from fpdf import FPDF

class Report(FPDF):
    def header(self):
        self.set_font("Helvetica", "B", 9)
        self.set_text_color(120, 120, 120)
        self.cell(0, 8, "ArmorClaude Policy System Redesign - Implementation Report", align="R")
        self.ln(4)
        self.set_draw_color(200, 200, 200)
        self.line(10, self.get_y(), 200, self.get_y())
        self.ln(4)

    def footer(self):
        self.set_y(-15)
        self.set_font("Helvetica", "I", 8)
        self.set_text_color(150, 150, 150)
        self.cell(0, 10, f"Page {self.page_no()}/{{nb}}", align="C")

    def title_page(self):
        self.add_page()
        self.ln(50)
        self.set_font("Helvetica", "B", 28)
        self.set_text_color(30, 30, 30)
        self.cell(0, 15, "ArmorClaude", align="C")
        self.ln(14)
        self.set_font("Helvetica", "", 20)
        self.set_text_color(80, 80, 80)
        self.cell(0, 12, "Policy System Redesign", align="C")
        self.ln(10)
        self.set_font("Helvetica", "", 14)
        self.cell(0, 10, "Implementation Report", align="C")
        self.ln(30)
        self.set_draw_color(60, 120, 200)
        self.set_line_width(0.8)
        self.line(60, self.get_y(), 150, self.get_y())
        self.ln(15)
        self.set_font("Helvetica", "", 11)
        self.set_text_color(100, 100, 100)
        self.cell(0, 8, "Date: May 26, 2026", align="C")
        self.ln(6)
        self.cell(0, 8, "Author: ArmorIQ Engineering", align="C")
        self.ln(6)
        self.cell(0, 8, "195 Automated Tests | 0 Failures | 7 Phases Complete", align="C")

    def section(self, title, level=1):
        self.ln(4)
        if level == 1:
            self.set_font("Helvetica", "B", 16)
            self.set_text_color(30, 60, 140)
            self.cell(0, 10, title)
            self.ln(4)
            self.set_draw_color(30, 60, 140)
            self.set_line_width(0.5)
            self.line(10, self.get_y(), 200, self.get_y())
            self.ln(4)
        elif level == 2:
            self.set_font("Helvetica", "B", 13)
            self.set_text_color(50, 80, 150)
            self.cell(0, 9, title)
            self.ln(6)
        else:
            self.set_font("Helvetica", "B", 11)
            self.set_text_color(60, 60, 60)
            self.cell(0, 8, title)
            self.ln(5)

    def body(self, text):
        self.set_font("Helvetica", "", 10)
        self.set_text_color(40, 40, 40)
        self.multi_cell(0, 5.5, text)
        self.ln(2)

    def bullet(self, text, indent=10):
        x = self.get_x()
        self.set_font("Helvetica", "", 10)
        self.set_text_color(40, 40, 40)
        self.set_x(x + indent)
        self.cell(4, 5.5, "-")
        self.multi_cell(0, 5.5, text)
        self.ln(1)

    def code_block(self, text):
        self.set_font("Courier", "", 8.5)
        self.set_fill_color(245, 245, 245)
        self.set_text_color(50, 50, 50)
        self.set_draw_color(220, 220, 220)
        x = self.get_x()
        y = self.get_y()
        lines = text.split("\n")
        h = len(lines) * 4.5 + 4
        if y + h > 270:
            self.add_page()
            y = self.get_y()
        self.rect(10, y, 190, h, "DF")
        self.set_xy(12, y + 2)
        for line in lines:
            self.cell(0, 4.5, line)
            self.ln(4.5)
            self.set_x(12)
        self.ln(3)

    def table_row(self, cells, widths, bold=False, fill=False):
        style = "B" if bold else ""
        self.set_font("Helvetica", style, 9)
        if fill:
            self.set_fill_color(235, 240, 250)
        else:
            self.set_fill_color(255, 255, 255)
        self.set_text_color(40, 40, 40)
        h = 7
        x = self.get_x()
        max_h = h
        for i, (cell, w) in enumerate(zip(cells, widths)):
            lines = self.multi_cell(w, h, cell, border=1, fill=fill, split_only=True)
            cell_h = len(lines) * h
            if cell_h > max_h:
                max_h = cell_h
        # Now actually draw
        self.set_x(x)
        for i, (cell, w) in enumerate(zip(cells, widths)):
            self.set_font("Helvetica", style, 9)
            y_before = self.get_y()
            x_before = self.get_x()
            self.multi_cell(w, h, cell, border=1, fill=fill)
            self.set_xy(x_before + w, y_before)
        self.ln(max_h)


pdf = Report()
pdf.alias_nb_pages()
pdf.set_auto_page_break(auto=True, margin=20)

# --- Title Page ---
pdf.title_page()

# --- Executive Summary ---
pdf.add_page()
pdf.section("Executive Summary")
pdf.body(
    "ArmorClaude had a critical security flaw: Claude itself could modify the policies that "
    "were supposed to govern it. The policy_update MCP tool was callable by the LLM, and "
    "buildPolicyContextHints() even instructed Claude to call it. The tool was allowlisted in "
    "PreToolUse, bypassing all intent checks. This completely defeated the purpose of policy "
    "enforcement."
)
pdf.body(
    "This redesign creates an immutable policy layer where only the human user can set or "
    "change policies. It introduces deny-by-default for unknown MCP servers, policy profiles "
    "for save/switch workflows, dual enforcement (local JSON + cloud OPA), and cryptographic "
    "tamper detection. All 7 implementation phases are complete with 195 automated tests "
    "passing and zero failures."
)

pdf.section("Key Security Guarantees", 2)
pdf.bullet("Claude cannot modify policies via any code path (MCP tool, file edit, shell command)")
pdf.bullet("/armor-policy commands execute in the UserPromptSubmit hook layer, before Claude's LLM")
pdf.bullet("Unknown MCP servers are denied by default until the user explicitly approves them")
pdf.bullet("Policy files are protected by a path guard that blocks all write operations")
pdf.bullet("Cryptographic digest binding detects tampering of policy.json outside ArmorClaude")
pdf.bullet("OPA enforcement mode fail-closes (deny) when the OPA server is unreachable")

# --- The Problem ---
pdf.add_page()
pdf.section("The Problem")
pdf.body(
    "ArmorClaude is a Claude Code plugin that enforces policies on tool usage. It intercepts "
    "every tool call via PreToolUse hooks and checks them against policy rules. However, "
    "several design flaws undermined this enforcement:"
)
pdf.section("Vulnerability: Claude Could Rewrite Its Own Rules", 2)
pdf.body(
    "The policy_update MCP tool was registered as a Claude-callable tool. Claude could call "
    "it at any time to add, remove, or modify policy rules. The buildPolicyContextHints() "
    "function injected instructions telling Claude exactly how to call policy_update. The "
    "tool was in the armorTools allowlist, bypassing all intent and policy checks. A prompt "
    "injection attack could silently modify policies through Claude."
)
pdf.section("Additional Gaps", 2)
pdf.bullet("New MCP servers were implicitly trusted - any third-party tool could execute without approval")
pdf.bullet("No onboarding existed - first-time users had zero protection and no guidance")
pdf.bullet("Policy configurations couldn't be saved, switched, or shared across a team")
pdf.bullet("Enforcement was local-only with no path to enterprise (cloud OPA) deployment")
pdf.bullet("Policy files had no cryptographic tamper detection")

# --- Architecture ---
pdf.add_page()
pdf.section("Architecture")
pdf.body("The redesign establishes clear separation between the human-only policy authoring channel "
         "and the LLM-facing enforcement pipeline:")

pdf.code_block(
    "Human types in terminal\n"
    "        |\n"
    "        v\n"
    "  UserPromptSubmit hook\n"
    "        |\n"
    "   /armor-policy?  --> Policy mutation (human-only, policy-immune)\n"
    "        |               blockPrompt() - Claude never sees it\n"
    "        | (normal prompt)\n"
    "        v\n"
    "  Claude's LLM processes prompt\n"
    "        |\n"
    "        v\n"
    "  PreToolUse hook\n"
    "        |\n"
    "   1. ArmorClaude allowlist (own MCP tools)\n"
    "   2. Path guard (block writes to policy files)\n"
    "   3. ExitPlanMode capture\n"
    "   4. Safe internal tools fast-path\n"
    "   5. MCP deny-by-default gate          [NEW]\n"
    "   6. Pending plan consumption\n"
    "   7. Crypto policy digest verification  [NEW]\n"
    "   8. Policy evaluation (local or OPA)   [NEW]\n"
    "   9. Intent token verification"
)

pdf.section("Why UserPromptSubmit Is Secure", 2)
pdf.body(
    "The UserPromptSubmit hook fires when the human presses Enter in the terminal. It "
    "receives the literal text typed. Claude cannot forge this - it fires before the LLM "
    "processes the prompt. The blockPrompt() function consumes the input entirely inside "
    "the hook's Node.js process. Claude never sees /armor-policy commands. Even if all "
    "tools are blocked by policy, /armor-policy commands still work because they run in "
    "the hook layer, not through Claude's tool pipeline."
)

# --- Phase Details ---
pdf.add_page()
pdf.section("Implementation Phases")

# Phase 1
pdf.section("Phase 1: Security Fix", 2)
pdf.section("Why", 3)
pdf.body("The policy_update MCP tool was the single biggest vulnerability. It had to go first.")
pdf.section("What Changed", 3)
pdf.bullet("Deleted policy_update tool from policy-mcp.mjs with all schemas and handlers")
pdf.bullet("Removed buildPolicyContextHints() which told Claude how to call it")
pdf.bullet("Removed the tool from the armorTools allowlist in PreToolUse")
pdf.bullet("Removed policyUpdateEnabled, policyUpdateAllowList, contextHintsEnabled from config")
pdf.bullet("Added path guard blocking Write/Edit/Bash write operations to policy and credential files")
pdf.bullet("Cleaned ~300 lines of dead code from policy.mjs")

# Phase 2A
pdf.section("Phase 2A: /armor-policy Command System", 2)
pdf.section("Why", 3)
pdf.body(
    "With Claude locked out of policy mutation, users need a secure, human-only way to "
    "manage policies. The UserPromptSubmit hook is the only provably human-only channel."
)
pdf.section("What Changed", 3)
pdf.bullet("Created armor-policy-commands.mjs - full command parser and executor")
pdf.bullet("Created policy-templates.mjs - 4 built-in templates (all-allow, strict-read-only, balanced, lockdown)")
pdf.bullet("Two-step review: mutations stage to policy-pending.json, user confirms or cancels")
pdf.bullet("Commands: list, add, remove, reset, template, confirm, cancel, export")

# Phase 2B
pdf.section("Phase 2B: Policy Profiles", 2)
pdf.section("Why", 3)
pdf.body("Users need to save and switch between policy configurations for different contexts.")
pdf.section("What Changed", 3)
pdf.bullet("Created policy-profiles.mjs - CRUD for named profiles at ~/.claude/armorclaude/profiles/")
pdf.bullet("Built-in templates auto-seed as profiles on first access")
pdf.bullet("Profile switch uses two-step confirm flow with diff display")
pdf.bullet("Commands: profile save, profile list, profile switch, profile delete")

# Phase 3
pdf.section("Phase 3: Onboarding Flow", 2)
pdf.section("Why", 3)
pdf.body("First-time users with no policy.json have zero protection and no guidance.")
pdf.section("What Changed", 3)
pdf.bullet("handleSessionStart detects first-run (no policy.json on disk)")
pdf.bullet("Displays welcome message listing available templates with exact commands")
pdf.bullet("Flag file (onboarding-shown) prevents repeat display")

pdf.add_page()

# Phase 4
pdf.section("Phase 4: MCP Auto-Detection + Deny-by-Default", 2)
pdf.section("Why", 3)
pdf.body(
    "MCP servers are arbitrary third-party code. Following the AWS IAM default-deny model, "
    "unknown MCPs should be blocked until the user explicitly approves them."
)
pdf.section("What Changed", 3)
pdf.bullet("Created tool-registry.mjs with parseToolIdentity() classifying every tool call")
pdf.bullet("Categories: builtin, armorclaude-own, external-mcp, plugin-mcp, skill, unknown")
pdf.bullet("MCP registry persisted in runtime-state.json")
pdf.bullet("Gate in PreToolUse denies external/plugin MCP tools unless approved")
pdf.bullet("First encounter auto-registers server as 'pending' with background backend notification")
pdf.bullet("Commands: mcp list, mcp approve <server>, mcp deny <server>")

pdf.section("Tool Name Taxonomy", 3)
w = [55, 45, 45, 45]
pdf.table_row(["Pattern", "Category", "Default", "Example"], w, bold=True, fill=True)
pdf.table_row(["Read, Edit, Bash", "builtin", "policy rules", "Read"], w)
pdf.table_row(["mcp__armorclaude-*__*", "armorclaude-own", "always allow", "register_intent_plan"], w)
pdf.table_row(["mcp__<server>__<tool>", "external-mcp", "DENY", "mcp__github__create_issue"], w)
pdf.table_row(["mcp__plugin_*_*__*", "plugin-mcp", "DENY", "mcp__plugin_x_slack__send"], w)
pdf.table_row(["Skill", "skill", "allow+track", "Skill"], w)

# Phase 5
pdf.ln(4)
pdf.section("Phase 5: Backend Integration", 2)
pdf.section("Why", 3)
pdf.body(
    "Enterprise teams need centralized policy management. One team member creates a policy "
    "profile, everyone else pulls it. MCP registrations need to sync across machines."
)
pdf.section("What Changed", 3)
pdf.bullet("Created backend-client.mjs - HTTP client with graceful no-apiKey degradation")
pdf.bullet("profile push <name> - upload profile to org policy library")
pdf.bullet("profile pull - fetch all org profiles and save locally")
pdf.bullet("sync - push current policy to backend for OPA compilation")
pdf.bullet("Session start fire-and-forgets MCP registry sync from backend")
pdf.bullet("PreToolUse fire-and-forgets autoRegisterMcp on first MCP encounter")

# Phase 6
pdf.add_page()
pdf.section("Phase 6: OPA Enforcement Engine", 2)
pdf.section("Why", 3)
pdf.body(
    "Local JSON is fast and offline, but enterprises need shared, centrally-managed enforcement. "
    "OPA (Open Policy Agent) is the industry standard. The existing armoriq-opa, conmap-auto, "
    "and armoriq-proxy-server infrastructure already supports this pipeline."
)
pdf.section("What Changed", 3)
pdf.bullet("Created opa-client.mjs - OPA HTTP client with response cache + circuit breaker + fail-closed")
pdf.bullet("Created policy-compiler.mjs - ArmorClaude rules to OPA input mapper")
pdf.bullet("PreToolUse dispatches to local evaluatePolicy() or evaluateOpa() based on config")
pdf.bullet("Settings command: /armor-policy settings enforcement <local|opa>")
pdf.bullet("Config: enforcementEngine, opaPdpUrl, opaCacheTtlMs, opaTimeoutMs, opaCircuitBreakerThreshold")

pdf.section("OPA Client Features", 3)
pdf.bullet("Response cache with configurable TTL (default 10s) - avoids redundant calls for same tool")
pdf.bullet("Circuit breaker opens after 15 consecutive failures, resets after 10s")
pdf.bullet("Fail-closed: if OPA is unreachable, DENY (no silent fallback to permissive)")
pdf.bullet("Falls back to local JSON if opaPdpUrl is not configured even when engine is set to 'opa'")

# Phase 7
pdf.section("Phase 7: Crypto Integrity", 2)
pdf.section("Why", 3)
pdf.body(
    "Even with Claude locked out, someone (or malware) could tamper with policy.json directly "
    "on disk. Cryptographic binding detects this - every policy change gets a signed CSRG token "
    "containing a Merkle proof of the rules."
)
pdf.section("What Changed", 3)
pdf.bullet("cryptoPolicyEnabled auto-enables when API key is present")
pdf.bullet("Every /armor-policy confirm issues a signed CSRG policy token")
pdf.bullet("Every PreToolUse verifies current policy digest matches token digest")
pdf.bullet("In OPA mode, confirm also pushes compiled policy to backend")
pdf.bullet("Graceful: if CSRG unreachable, policy change still applies (defense-in-depth)")

# --- Industry Patterns ---
pdf.add_page()
pdf.section("Industry Patterns Applied")
pdf.body("This design is grounded in production patterns from leading policy-as-code systems:")

w2 = [35, 55, 100]
pdf.table_row(["Company", "Pattern", "How We Apply It"], w2, bold=True, fill=True)
pdf.table_row(["OPA/Styra", "Signed bundles, GCS distribution", "Cloud OPA mode uses the same pipeline (armoriq-opa)"], w2)
pdf.table_row(["Permit.io", "Separate authoring from enforcement", "/armor-policy (authoring) decoupled from evaluatePolicy() (enforcement)"], w2)
pdf.table_row(["Cerbos", "Policy profiles from same base", "Profile system: same rules, different profiles per context"], w2)
pdf.table_row(["Keycard", "Identity-bound, task-scoped tokens", "Intent tokens: plan-scoped, time-limited, CSRG-signed"], w2)
pdf.table_row(["Invariant Labs", "Three-layer architecture", "Guardrails (ArmorClaude) + Gateway (proxy) + Observability (audit WAL)"], w2)
pdf.table_row(["AWS IAM", "Default-deny", "MCP deny-by-default: unknown servers blocked until approved"], w2)

# --- Security Verification ---
pdf.ln(4)
pdf.section("Security Verification Matrix")
pdf.body("8 attack vectors tested. Automated tests cover code paths; manual tests verify live behavior:")

w3 = [8, 55, 65, 62]
pdf.table_row(["#", "Attack Vector", "Test", "Expected"], w3, bold=True, fill=True)
pdf.table_row(["1", "Claude calls policy_update", "Try calling in session", "Tool does not exist"], w3)
pdf.table_row(["2", "Claude Edit on policy.json", "Edit({file_path: policy.json})", "PreToolUse denies"], w3)
pdf.table_row(["3", "Claude Write on policy.json", "Write({file_path: policy.json})", "PreToolUse denies"], w3)
pdf.table_row(["4", "Claude Bash writes policy", "echo '{}' > policy.json", "PreToolUse denies"], w3)
pdf.table_row(["5", "Claude Bash reads policy", "cat policy.json", "ALLOWED (read-only)"], w3)
pdf.table_row(["6", "Claude reads credentials", "cat credentials.json", "ALLOWED (read)"], w3)
pdf.table_row(["7", "Prompt injection", "/armor-policy in tool output", "No effect (hook-only)"], w3)
pdf.table_row(["8", "Response text", "Claude outputs /armor-policy", "Display-only, no mutation"], w3)

# --- Test Coverage ---
pdf.add_page()
pdf.section("Test Coverage")

w4 = [70, 15, 105]
pdf.table_row(["Test Suite", "Tests", "What It Covers"], w4, bold=True, fill=True)
pdf.table_row(["armor-policy-commands.test.mjs", "23", "Command parsing, staging, confirm/cancel, engine wiring"], w4)
pdf.table_row(["policy-profiles.test.mjs", "18", "Profile CRUD, save/switch/delete, round-trip"], w4)
pdf.table_row(["onboarding.test.mjs", "3", "First-run detection, flag file, skip-when-exists"], w4)
pdf.table_row(["mcp-gate.test.mjs", "20", "Tool identity, registry, deny/approve flows, end-to-end"], w4)
pdf.table_row(["backend-client.test.mjs", "14", "No-apiKey fallback, mock server calls, command wiring"], w4)
pdf.table_row(["opa-enforcement.test.mjs", "18", "Compiler, OPA client, cache, circuit breaker, dispatch"], w4)
pdf.table_row(["crypto-integrity.test.mjs", "6", "Auto-enable, token issuance, graceful failure"], w4)
pdf.table_row(["Existing suites (11 files)", "93", "All pre-existing tests (zero regressions)"], w4)
pdf.ln(2)
pdf.set_font("Helvetica", "B", 11)
pdf.set_text_color(30, 100, 30)
pdf.cell(0, 8, "Total: 195 tests | 0 failures | 0 regressions")
pdf.ln(10)

# --- Files Changed ---
pdf.section("Files Changed")
pdf.section("New Files (8)", 2)
pdf.bullet("scripts/lib/armor-policy-commands.mjs - Command system (parser, staging, confirm/cancel)")
pdf.bullet("scripts/lib/policy-templates.mjs - 4 built-in template definitions")
pdf.bullet("scripts/lib/policy-profiles.mjs - Profile CRUD (save, load, list, delete)")
pdf.bullet("scripts/lib/tool-registry.mjs - Tool identity parser + MCP registry helpers")
pdf.bullet("scripts/lib/backend-client.mjs - Backend HTTP client (sync, push, pull, auto-register)")
pdf.bullet("scripts/lib/opa-client.mjs - OPA evaluation client (cache + circuit breaker)")
pdf.bullet("scripts/lib/policy-compiler.mjs - ArmorClaude rules to OPA input compiler")
pdf.bullet("test-claude-policy.md - Manual security test matrix (8 attack vectors)")

pdf.section("Modified Files (5)", 2)
pdf.bullet("scripts/lib/engine.mjs - Path guard, /armor-policy wiring, MCP gate, onboarding, OPA dispatch")
pdf.bullet("scripts/lib/config.mjs - Removed dead keys, added mcpDenyByDefault, OPA config, crypto auto-enable")
pdf.bullet("scripts/lib/runtime-state.mjs - mcpRegistry persistence alongside sessions")
pdf.bullet("scripts/lib/policy.mjs - Removed ~300 lines of dead code")
pdf.bullet("scripts/policy-mcp.mjs - Removed policy_update tool registration")

# --- Remaining Work ---
pdf.add_page()
pdf.section("Remaining Work")
pdf.section("Manual Security Tests", 2)
pdf.body(
    "The 8 attack vectors in test-claude-policy.md must be run by a human in a live Claude "
    "Code session with ArmorClaude enabled. Automated tests verify the code paths, but live "
    "session testing confirms the hook architecture works end-to-end."
)
pdf.section("Backend Endpoints (conmap-auto)", 2)
pdf.body(
    "The ArmorClaude client calls are built, tested, and gracefully degrade without a backend. "
    "The following server-side endpoints need to be added in the conmap-auto repository:"
)
pdf.bullet("POST /mcp/auto-register - Register MCP server from ArmorClaude auto-detection")
pdf.bullet("GET /policies/profiles - List org profiles (ApiKeyGuard)")
pdf.bullet("POST /policies/profiles - Create/update org profile (ApiKeyGuard)")
pdf.bullet("POST /policies/sync - Receive policy state for OPA bundle compilation")

# --- Command Reference ---
pdf.section("Command Reference")
pdf.code_block(
    "/armor-policy list                        - Show current rules\n"
    "/armor-policy add <allow|deny|hold> <tool> - Propose a new rule\n"
    "/armor-policy remove <rule-id>             - Propose removing a rule\n"
    "/armor-policy reset                        - Propose clearing all rules\n"
    "/armor-policy template <name>              - Propose applying a template\n"
    "/armor-policy confirm                      - Apply staged change\n"
    "/armor-policy cancel                       - Discard staged change\n"
    "/armor-policy export                       - Dump policy as JSON\n"
    "\n"
    "/armor-policy mcp list                     - Show detected MCPs\n"
    "/armor-policy mcp approve <server>         - Approve an MCP server\n"
    "/armor-policy mcp deny <server>            - Deny an MCP server\n"
    "\n"
    "/armor-policy profile save <name>          - Save current policy as profile\n"
    "/armor-policy profile list                 - Show saved profiles\n"
    "/armor-policy profile switch <name>        - Switch to a saved profile\n"
    "/armor-policy profile delete <name>        - Delete a profile\n"
    "/armor-policy profile push <name>          - Upload profile to org\n"
    "/armor-policy profile pull                 - Download org profiles\n"
    "\n"
    "/armor-policy settings                     - Show enforcement settings\n"
    "/armor-policy settings enforcement <local|opa> - Switch engine\n"
    "/armor-policy sync                         - Push policy to backend\n"
    "\n"
    "Templates: all-allow, strict-read-only, balanced, lockdown"
)

out = "/Users/aniket/work/armoriq/armorclaude/ArmorClaude-Policy-Redesign-Report.pdf"
pdf.output(out)
print(f"PDF generated: {out}")
