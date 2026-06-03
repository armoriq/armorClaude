#!/usr/bin/env python3
"""Generate PDF of the ArmorIQ Policy Isolation Research & Strategy Report."""

from fpdf import FPDF
import re
import textwrap

class ReportPDF(FPDF):
    def __init__(self):
        super().__init__()
        self.set_auto_page_break(auto=True, margin=20)

    def header(self):
        if self.page_no() > 1:
            self.set_font("Helvetica", "I", 8)
            self.set_text_color(120, 120, 120)
            self.cell(0, 8, "ArmorIQ Policy Isolation: Research & Strategy Report", align="R")
            self.ln(4)

    def footer(self):
        self.set_y(-15)
        self.set_font("Helvetica", "I", 8)
        self.set_text_color(120, 120, 120)
        self.cell(0, 10, f"Page {self.page_no()}/{{nb}}", align="C")

    def title_page(self):
        self.add_page()
        self.ln(50)
        self.set_font("Helvetica", "B", 28)
        self.set_text_color(20, 60, 120)
        self.cell(0, 14, "ArmorIQ Policy Isolation")
        self.ln(16)
        self.set_font("Helvetica", "", 20)
        self.set_text_color(60, 60, 60)
        self.cell(0, 10, "Research & Strategy Report")
        self.ln(10)
        self.set_draw_color(20, 60, 120)
        self.set_line_width(0.8)
        self.line(10, self.get_y(), 200, self.get_y())
        self.ln(10)
        self.set_font("Helvetica", "", 11)
        self.set_text_color(80, 80, 80)
        self.multi_cell(0, 7, "Moving ArmorIQ's policy enforcement to a trust boundary\nthat no AI agent can breach.")
        self.ln(15)
        self.set_font("Helvetica", "", 10)
        self.set_text_color(100, 100, 100)
        self.cell(0, 7, "Covers: problem analysis, competitive landscape, architecture,")
        self.ln(6)
        self.cell(0, 7, "security deep dive, implementation strategy, and next steps.")
        self.ln(20)
        self.set_font("Helvetica", "B", 10)
        self.set_text_color(20, 60, 120)
        self.cell(30, 7, "Prepared by:")
        self.set_font("Helvetica", "", 10)
        self.set_text_color(60, 60, 60)
        self.cell(0, 7, "ArmorIQ Engineering")
        self.ln(6)
        self.set_font("Helvetica", "B", 10)
        self.set_text_color(20, 60, 120)
        self.cell(30, 7, "Date:")
        self.set_font("Helvetica", "", 10)
        self.set_text_color(60, 60, 60)
        self.cell(0, 7, "May 2025")
        self.ln(6)
        self.set_font("Helvetica", "B", 10)
        self.set_text_color(20, 60, 120)
        self.cell(30, 7, "Status:")
        self.set_font("Helvetica", "", 10)
        self.set_text_color(60, 60, 60)
        self.cell(0, 7, "Brainstorming / Internal Review")
        self.ln(6)
        self.set_font("Helvetica", "B", 10)
        self.set_text_color(20, 60, 120)
        self.cell(30, 7, "Version:")
        self.set_font("Helvetica", "", 10)
        self.set_text_color(60, 60, 60)
        self.cell(0, 7, "1.0")

    def toc_page(self):
        self.add_page()
        self.set_font("Helvetica", "B", 18)
        self.set_text_color(20, 60, 120)
        self.cell(0, 12, "Table of Contents")
        self.ln(12)
        self.set_draw_color(20, 60, 120)
        self.set_line_width(0.4)
        self.line(10, self.get_y(), 200, self.get_y())
        self.ln(8)

        toc = [
            ("Part 1", "Why We Need This", "3"),
            ("  1.1", "The Fundamental Security Problem", "3"),
            ("  1.2", "What We've Built So Far (Current State)", "3"),
            ("  1.3", "What's Actually Secure vs Security Theater", "3"),
            ("  1.4", "Why This Matters Beyond ArmorClaude", "4"),
            ("Part 2", "What the Industry Does", "5"),
            ("  2.1", "Competitive Architecture Comparison", "5"),
            ("  2.2", "Industry Patterns That Work", "5"),
            ("  2.3", "The Key Insight From Industry", "6"),
            ("Part 3", "What Will Work, What Won't", "7"),
            ("  3.1", "Approaches That WILL Work", "7"),
            ("  3.2", "Approaches That WON'T Work", "8"),
            ("Part 4", "Detailed Architecture", "9"),
            ("  4.1", "The ArmorIQ Policy Daemon", "9"),
            ("  4.2", "How Policy Mutation Works (Secure Flow)", "10"),
            ("  4.3", "How Enforcement Works (Fast Path)", "11"),
            ("  4.4", "ArmorClaude After Migration", "11"),
            ("  4.5", "Cross-Product Architecture", "12"),
            ("Part 5", "Security Deep Dive", "13"),
            ("  5.1", "Attack Vector Analysis (Current vs Daemon)", "13"),
            ("  5.2", "The Socket Authentication Model", "14"),
            ("  5.3", "Failure Modes", "15"),
            ("  5.4", "Comparison: ArmorIQ vs Industry", "15"),
            ("Part 6", "Implementation Strategy", "16"),
            ("  6.1", "Phase Overview", "16"),
            ("  6.2", "What Goes Where", "16"),
            ("  6.3", "Installer Experience", "17"),
            ("Part 7", "Open Questions for Brainstorming", "18"),
            ("Part 8", "Risk Assessment", "19"),
        ]

        for num, title, page in toc:
            is_part = num.startswith("Part")
            if is_part:
                self.set_font("Helvetica", "B", 11)
                self.set_text_color(20, 60, 120)
            else:
                self.set_font("Helvetica", "", 10)
                self.set_text_color(60, 60, 60)
            self.cell(20, 6, num)
            self.cell(145, 6, title)
            self.cell(0, 6, page, align="R")
            self.ln(6)

    def section_header(self, text, level=1):
        self.ln(4)
        if level == 1:
            if self.get_y() > 40:
                self.add_page()
            self.set_font("Helvetica", "B", 18)
            self.set_text_color(20, 60, 120)
            self.multi_cell(0, 10, clean(text))
            self.set_draw_color(20, 60, 120)
            self.set_line_width(0.4)
            self.line(10, self.get_y(), 200, self.get_y())
            self.ln(6)
        elif level == 2:
            self.set_font("Helvetica", "B", 14)
            self.set_text_color(40, 80, 140)
            self.multi_cell(0, 8, clean(text))
            self.ln(3)
        elif level == 3:
            self.set_font("Helvetica", "B", 12)
            self.set_text_color(60, 60, 60)
            self.multi_cell(0, 7, clean(text))
            self.ln(2)

    def body_text(self, text):
        self.set_font("Helvetica", "", 10)
        self.set_text_color(40, 40, 40)
        self.multi_cell(0, 5.5, clean(text))
        self.ln(2)

    def bold_text(self, text):
        self.set_font("Helvetica", "B", 10)
        self.set_text_color(40, 40, 40)
        self.multi_cell(0, 5.5, clean(text))
        self.ln(2)

    def bullet(self, text, indent=0):
        self.set_font("Helvetica", "", 10)
        self.set_text_color(40, 40, 40)
        x = 14 + indent
        self.set_x(x)
        self.cell(5, 5.5, "-")
        self.multi_cell(0, 5.5, clean(text))
        self.ln(1)

    def numbered_item(self, num, text):
        self.set_font("Helvetica", "", 10)
        self.set_text_color(40, 40, 40)
        self.set_x(14)
        self.cell(8, 5.5, f"{num}.")
        self.multi_cell(0, 5.5, clean(text))
        self.ln(1)

    def code_block(self, text):
        self.ln(2)
        self.set_fill_color(240, 240, 245)
        self.set_font("Courier", "", 7.5)
        self.set_text_color(30, 30, 30)
        lines = text.split("\n")
        x_start = 12
        block_w = 186
        for line in lines:
            if self.get_y() > 270:
                self.add_page()
            self.set_x(x_start)
            self.cell(block_w, 4.2, clean(line), fill=True)
            self.ln(4.2)
        self.ln(3)

    def table(self, headers, rows):
        self.ln(2)
        n_cols = len(headers)
        avail = 190
        col_w = avail / n_cols
        col_widths = [col_w] * n_cols

        if n_cols >= 4:
            col_widths = self._auto_col_widths(headers, rows, avail)

        self.set_font("Helvetica", "B", 8)
        self.set_fill_color(20, 60, 120)
        self.set_text_color(255, 255, 255)
        for i, h in enumerate(headers):
            self.cell(col_widths[i], 7, clean(h)[:int(col_widths[i]/1.8)], border=1, fill=True, align="C")
        self.ln(7)

        self.set_font("Helvetica", "", 7.5)
        self.set_text_color(40, 40, 40)
        fill = False
        for row in rows:
            if self.get_y() > 265:
                self.add_page()
                self.set_font("Helvetica", "B", 8)
                self.set_fill_color(20, 60, 120)
                self.set_text_color(255, 255, 255)
                for i, h in enumerate(headers):
                    self.cell(col_widths[i], 7, clean(h)[:int(col_widths[i]/1.8)], border=1, fill=True, align="C")
                self.ln(7)
                self.set_font("Helvetica", "", 7.5)
                self.set_text_color(40, 40, 40)
                fill = False

            max_lines = 1
            cell_texts = []
            for i, cell in enumerate(row):
                t = clean(cell)
                wrapped = textwrap.wrap(t, width=max(10, int(col_widths[i] / 2)))
                if not wrapped:
                    wrapped = [""]
                cell_texts.append(wrapped)
                max_lines = max(max_lines, len(wrapped))

            row_h = max_lines * 4.5
            if fill:
                self.set_fill_color(245, 245, 250)
            else:
                self.set_fill_color(255, 255, 255)

            y_start = self.get_y()
            for i, lines in enumerate(cell_texts):
                x = 10 + sum(col_widths[:i])
                self.set_xy(x, y_start)
                self.cell(col_widths[i], row_h, "", border=1, fill=True)
                for j, line in enumerate(lines):
                    self.set_xy(x + 1, y_start + j * 4.5 + 0.5)
                    self.cell(col_widths[i] - 2, 4.5, line[:int(col_widths[i]/1.6)])

            self.set_y(y_start + row_h)
            fill = not fill
        self.ln(4)

    def _auto_col_widths(self, headers, rows, avail):
        n = len(headers)
        max_lens = [len(clean(h)) for h in headers]
        for row in rows:
            for i, cell in enumerate(row):
                if i < n:
                    max_lens[i] = max(max_lens[i], len(clean(cell)))
        total = sum(max_lens) or 1
        widths = [(l / total) * avail for l in max_lens]
        min_w = 15
        for i in range(n):
            if widths[i] < min_w:
                widths[i] = min_w
        s = sum(widths)
        return [w * avail / s for w in widths]

    def highlight_box(self, text, color="blue"):
        self.ln(2)
        if color == "blue":
            self.set_fill_color(230, 240, 255)
            self.set_draw_color(20, 60, 120)
        elif color == "green":
            self.set_fill_color(230, 250, 235)
            self.set_draw_color(30, 120, 60)
        elif color == "red":
            self.set_fill_color(255, 235, 235)
            self.set_draw_color(180, 40, 40)
        self.set_line_width(0.5)
        self.set_font("Helvetica", "B", 10)
        self.set_text_color(40, 40, 40)
        y = self.get_y()
        self.rect(12, y, 186, 10, "DF")
        self.set_xy(16, y + 2)
        self.multi_cell(178, 5.5, clean(text))
        self.set_y(y + 12)
        self.ln(2)


def clean(text):
    if not text:
        return ""
    t = str(text)
    t = t.replace("—", "--")
    t = t.replace("–", "-")
    t = t.replace("’", "'")
    t = t.replace("‘", "'")
    t = t.replace("“", '"')
    t = t.replace("”", '"')
    t = t.replace("…", "...")
    t = t.replace("•", "-")
    t = t.replace("→", "->")
    t = t.replace("←", "<-")
    t = t.replace("≤", "<=")
    t = t.replace("≥", ">=")
    t = t.replace("×", "x")
    t = t.replace("│", "|")
    t = t.replace("┌", "+")
    t = t.replace("┐", "+")
    t = t.replace("└", "+")
    t = t.replace("┘", "+")
    t = t.replace("─", "-")
    t = t.replace("├", "|")
    t = t.replace("┤", "|")
    t = t.replace("┬", "+")
    t = t.replace("┴", "+")
    t = t.replace("┼", "+")
    t = t.replace("▼", "v")
    t = t.replace("▶", ">")
    t = t.replace("█", "#")
    t = re.sub(r'[^\x00-\x7F]', '', t)
    t = t.replace("**", "")
    t = t.replace("`", "'")
    return t


def parse_table(lines):
    headers = []
    rows = []
    for i, line in enumerate(lines):
        line = line.strip()
        if not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.split("|")[1:-1]]
        if all(re.match(r'^[-:]+$', c) for c in cells):
            continue
        if not headers:
            headers = cells
        else:
            rows.append(cells)
    return headers, rows


def build_report():
    pdf = ReportPDF()
    pdf.alias_nb_pages()

    # Title page
    pdf.title_page()

    # TOC
    pdf.toc_page()

    # ===== PART 1 =====
    pdf.section_header("Part 1: Why We Need This", 1)

    pdf.section_header("1.1 The Fundamental Security Problem", 2)
    pdf.body_text(
        "ArmorClaude enforces policies on AI tool usage inside Claude Code. Today, the enforcement "
        "layer and the AI agent run as the same OS user on the same machine. This means:"
    )
    pdf.bullet("Every file ArmorClaude can read/write, Claude can too")
    pdf.bullet("Every process ArmorClaude can spawn, Claude can too")
    pdf.bullet("Every socket ArmorClaude can connect to, Claude can too")
    pdf.bullet("Every credential ArmorClaude can access, Claude can too")
    pdf.ln(3)
    pdf.highlight_box(
        "Analogy: It's like hiring a security guard who shares the same keycard as the people "
        "they're guarding. The guard can check badges, but anyone being checked can also grab "
        "the guard's clipboard and rewrite the access list.",
        "red"
    )

    pdf.section_header("1.2 What We've Built So Far (Current State)", 2)
    pdf.body_text("Over 7 phases, we built a comprehensive policy system with 195 automated tests:")
    pdf.table(
        ["Layer", "What it does", "Security strength"],
        [
            ["UserPromptSubmit hook + blockPrompt()", "Human-only policy commands (/armor-policy)", "Strong -- architectural guarantee from Claude Code. LLM cannot forge this event."],
            ["Path guard (PreToolUse)", "Blocks Write/Edit/Bash writes to policy files", "Medium -- catches obvious attempts, bypassable with obfuscation"],
            ["Handler name guard", "Blocks Bash commands referencing handleArmorPolicyCommand etc.", "Medium -- catches direct invocation, bypassable with encoding"],
            ["Crypto digest (CSRG)", "Detects policy.json tampering after the fact", "Strong -- cryptographic, but reactive not preventive"],
            ["MCP deny-by-default", "Unknown MCP servers blocked until approved", "Strong -- gate in PreToolUse, human approval via hook"],
            ["OPA enforcement mode", "Cloud policy evaluation with circuit breaker", "Strong -- but only when cloud is reachable"],
        ]
    )

    pdf.section_header("1.3 What's Actually Secure vs What's Security Theater", 2)
    pdf.bold_text("Actually secure (architectural/cryptographic guarantees):")
    pdf.bullet("UserPromptSubmit hook -- Claude Code guarantees this fires only on human input")
    pdf.bullet("blockPrompt() -- consumes input before LLM sees it")
    pdf.bullet("CSRG crypto digest -- detects tampering mathematically")
    pdf.bullet("policy_update MCP tool deletion -- tool literally doesn't exist")
    pdf.ln(2)
    pdf.bold_text("Security theater (best-effort, bypassable by determined LLM):")
    pdf.bullet("Path guard regex -- Claude can obfuscate (base64 -d | node, string concatenation)")
    pdf.bullet("Handler name blocking -- Claude can import via dynamic import() with constructed string")
    pdf.bullet("File permission checks -- same OS user, Claude can chmod")
    pdf.bullet("Any in-process guard -- Claude has the same capabilities as the guard")

    pdf.section_header("1.4 Why This Matters Beyond ArmorClaude", 2)
    pdf.body_text("ArmorIQ has multiple AI tool products:")
    pdf.bullet("ArmorClaude -- Claude Code enforcement")
    pdf.bullet("ArmorCopilot -- GitHub Copilot enforcement (planned)")
    pdf.bullet("ArmorCodex -- OpenAI Codex enforcement (planned)")
    pdf.bullet("Custom agents -- via ArmorIQ SDK")
    pdf.ln(2)
    pdf.body_text("A shared, isolated enforcement layer would:")
    pdf.numbered_item(1, "Eliminate duplicate enforcement code across products")
    pdf.numbered_item(2, "Provide consistent policy across all AI tools a developer uses")
    pdf.numbered_item(3, "Centralize credential management (one API key location, protected)")
    pdf.numbered_item(4, "Enable org-wide policy management from a single control plane")

    # ===== PART 2 =====
    pdf.section_header("Part 2: What the Industry Does", 1)

    pdf.section_header("2.1 Competitive Architecture Comparison", 2)
    pdf.table(
        ["Product", "Enforcement Location", "How Agent Can't Modify Policy", "Latency", "License"],
        [
            ["Invariant Guardrails", "Gateway proxy (separate process)", "Agent's URLs rewrite to proxy; policies in gateway", "Near-zero (pipelined)", "Open source"],
            ["Lasso Security", "MCP Gateway proxy", "External gateway intercepts all MCP tool calls", "Real-time per tool call", "Commercial (gateway OSS)"],
            ["Lakera Guard", "Cloud API / self-hosted", "API-based; agent sends payloads to external service", "Sub-50ms API call", "Commercial (Cisco)"],
            ["Arthur AI Shield", "Federated control/data plane", "Control plane in cloud; data plane in VPC", "p95 <200ms", "Commercial (engine OSS)"],
            ["OPA / Styra", "Sidecar PDP", "Sidecar has own filesystem; policies from bundle server", "Sub-millisecond", "Open source (Apache 2.0)"],
            ["Permit.io / OPAL", "Sidecar PDP (OPA + OPAL)", "OPAL server pushes diffs via pub/sub", "1-5ms local eval", "OPAL OSS; Permit.io commercial"],
            ["Cerbos", "Sidecar / service / Lambda", "Stateless PDP loads from git/S3", "Sub-millisecond", "Open source (Apache 2.0)"],
            ["Anthropic built-in", "In-model (training-time)", "Weights are immutable at inference", "Zero", "Built into Claude"],
            ["ArmorClaude (current)", "Same-process hooks", "Best-effort guards + crypto detection", "<5ms (daemon)", "Proprietary"],
        ]
    )

    pdf.section_header("2.2 Industry Patterns That Work", 2)

    pdf.section_header("Pattern 1: Gateway/Proxy (Invariant, Lasso)", 3)
    pdf.bullet("Agent literally cannot reach tools without passing through the enforcement layer")
    pdf.bullet("URLs are rewritten, agent never has direct access")
    pdf.bullet("Why it works: Physical interposition. Agent can't skip what it can't see around.")
    pdf.bullet("Relevance to us: Claude Code's hook system IS a form of interposition -- PreToolUse fires before every tool call. But the hooks run as the same user, so the isolation is logical, not physical.")

    pdf.section_header("Pattern 2: Sidecar PDP (OPA, Cerbos, Permit.io)", 3)
    pdf.bullet("Separate process, separate filesystem, policies pushed from external authority")
    pdf.bullet("Application calls check(action, resource), PDP returns allow/deny")
    pdf.bullet("Why it works: Policy authoring and policy evaluation are in separate trust domains. App can query but never modify.")
    pdf.bullet("Relevance to us: This is exactly what the ArmorIQ daemon should be -- a local PDP that the AI agent can query but not control.")

    pdf.section_header("Pattern 3: Cloud API (Lakera, Arthur)", 3)
    pdf.bullet("External service makes decisions, agent has no local state to tamper with")
    pdf.bullet("Why it works: Nothing local to attack.")
    pdf.bullet("Why it DOESN'T fully work for us: 50-200ms latency per decision is too slow for CLI tools. Also requires internet.")

    pdf.section_header("Pattern 4: In-model alignment (Anthropic)", 3)
    pdf.bullet("Safety baked into weights at training time")
    pdf.bullet("Why it works for general safety: Prevents the worst harms at the model level")
    pdf.bullet("Why it DOESN'T work for policy enforcement: Red team tests show model-level safety is a layer, not a boundary. Production systems need external enforcement.")

    pdf.section_header("2.3 The Key Insight From Industry", 2)
    pdf.body_text("Every production-grade enforcement system separates into two components:")
    pdf.code_block(
        "+-------------------------+     +-----------------------------+\n"
        "| Policy Decision Point   |     | Policy Administration Point |\n"
        "| (PDP)                   |     | (PAP)                       |\n"
        "|                         |     |                             |\n"
        "| - Evaluates allow/deny  |     | - CRUD on policy rules      |\n"
        "| - Local, fast (<5ms)    |     | - Human-only access         |\n"
        "| - Read-only policy view |     | - Pushes updates to PDP     |\n"
        "| - Different trust domain|     | - Audit trail               |\n"
        "|   from the agent        |     | - Credential management     |\n"
        "+-------------------------+     +-----------------------------+"
    )
    pdf.highlight_box("The agent can call the PDP (get decisions) but never the PAP (change policy).", "blue")
    pdf.body_text("This is the OPAL/Cerbos/OPA model. And it's exactly what we need.")

    # ===== PART 3 =====
    pdf.section_header("Part 3: What Will Work, What Won't", 1)

    pdf.section_header("3.1 Approaches That WILL Work", 2)

    pdf.section_header("A. System Daemon as Separate OS User (RECOMMENDED)", 3)
    pdf.body_text(
        "Run the policy daemon as a dedicated system user (_armoriq). Policy files, credentials, "
        "and daemon code are owned by this user. The AI agent's user cannot read/write them."
    )
    pdf.code_block(
        "Claude Code (user: aniket)               Any AI Tool\n"
        "    |                                        |\n"
        "    |  Unix socket (group: staff, 0660)      |\n"
        "    +-------------------+--------------------+\n"
        "                        |\n"
        "                        v\n"
        "    +-----------------------------------------+\n"
        "    | ArmorIQ Policy Daemon (user: _armoriq)   |\n"
        "    |                                          |\n"
        "    | /var/lib/armoriq/policy.json      (0600) |\n"
        "    | /var/lib/armoriq/credentials.json (0600) |\n"
        "    | /var/lib/armoriq/profiles/        (0700) |\n"
        "    | /var/run/armoriq/policyd.sock     (0660) |\n"
        "    | /usr/local/lib/armoriq/           (0755) |\n"
        "    |                                          |\n"
        "    | Managed by launchd (macOS)               |\n"
        "    |          or systemd (Linux)              |\n"
        "    +-----------------------------------------+"
    )

    pdf.bold_text("Why this works:")
    pdf.table(
        ["Security property", "Mechanism", "Bypassable?"],
        [
            ["LLM can't write policy files", "Unix file permissions (owner _armoriq, mode 0600)", "No -- requires root or _armoriq user"],
            ["LLM can't read credentials", "Same -- owned by _armoriq, mode 0600", "No"],
            ["LLM can't kill daemon", "kill requires same user or root", "No -- different user, launchd restarts it"],
            ["LLM can't modify daemon code", "Code owned by _armoriq under /usr/local/lib/", "No"],
            ["LLM can't send fake mutations via socket", "Mutations require auth: 'user-session' tag only set by UserPromptSubmit hook", "No -- LLM can't trigger UserPromptSubmit"],
            ["LLM can't escalate to root", "Standard non-root user", "No -- unless kernel exploit (out of scope)"],
        ]
    )

    pdf.bold_text("Why this is the right model:")
    pdf.bullet("Same pattern as OPA sidecar, Cerbos PDP, Permit.io OPAL")
    pdf.bullet("Uses OS-level primitives that are battle-tested for decades")
    pdf.bullet("Sub-5ms latency (Unix socket, local evaluation)")
    pdf.bullet("Works offline (no cloud dependency)")
    pdf.bullet("Daemon already exists (daemon.mjs) -- 80% of code is written")
    pdf.bullet("One daemon serves all ArmorIQ products")

    pdf.section_header("B. Cloud-Only Enforcement (enterprise add-on, not primary)", 3)
    pdf.body_text("All policy decisions come from the ArmorIQ cloud backend. No local policy state.")
    pdf.bold_text("Why this can't be the primary mode:")
    pdf.bullet("50-200ms per decision -- unacceptable for CLI tools")
    pdf.bullet("No offline mode")
    pdf.bullet("LLM could read the API key and make its own API calls")
    pdf.bullet("Single point of failure")
    pdf.body_text("Verdict: Good as an enterprise add-on (org-wide policy sync, audit), bad as primary path.")

    pdf.section_header("3.2 Approaches That WON'T Work", 2)

    pdf.section_header("C. More In-Process Guards (DOESN'T WORK)", 3)
    pdf.body_text(
        "Adding more regex checks, handler name blocking, or file monitoring within the same "
        "OS user is an arms race we can't win:"
    )
    pdf.bullet("Regex guards: Claude can base64-encode, use string concatenation, eval, or dynamic imports")
    pdf.bullet("File watchers: Claude can kill the watcher (same user) or modify faster than watcher reacts")
    pdf.bullet("Environment variable hiding: Claude has env, printenv, /proc/self/environ")
    pdf.bullet("In-memory-only state: Claude can gcore the process or read /proc/<pid>/mem")
    pdf.bullet("Encryption at rest: The decryption key must be accessible to the same process")
    pdf.highlight_box("Every guard you can build, the LLM can theoretically unbuild. It's the same trust domain.", "red")

    pdf.section_header("D. Docker/Container Isolation (OVERKILL for CLI)", 3)
    pdf.bullet("Requires Docker installed -- heavyweight for a CLI plugin")
    pdf.bullet("macOS Docker runs in a Linux VM (network bridging, volume mount complexity)")
    pdf.bullet("Latency overhead from container networking")
    pdf.body_text("Verdict: Overkill. A system user + Unix socket achieves the same isolation with zero overhead.")

    pdf.section_header("E. Kernel-Level Enforcement (LSM, eBPF) (TOO COMPLEX)", 3)
    pdf.bullet("macOS doesn't have LSM/eBPF")
    pdf.bullet("Requires root and kernel knowledge")
    pdf.bullet("Extremely complex to configure correctly; fragile across OS updates")
    pdf.body_text("Verdict: Theoretically strongest, practically impossible for cross-platform CLI tool.")

    pdf.section_header("F. Trusted Execution Environment / Secure Enclave (OVERKILL)", 3)
    pdf.bullet("Enclave development is extremely complex; platform-specific")
    pdf.bullet("Designed for protecting cryptographic keys, not for policy evaluation")
    pdf.body_text("Verdict: Interesting for future credential storage, not for policy enforcement.")

    # ===== PART 4 =====
    pdf.section_header("Part 4: Detailed Architecture", 1)

    pdf.section_header("4.1 The ArmorIQ Policy Daemon (armoriq-policyd)", 2)
    pdf.code_block(
        "+-------------------------------------------------------------------+\n"
        "| armoriq-policyd (runs as _armoriq system user)                     |\n"
        "|                                                                    |\n"
        "|  +------------------------------------------------------------+   |\n"
        "|  | Socket Server (Unix domain socket)                          |   |\n"
        "|  | /var/run/armoriq/policyd.sock                               |   |\n"
        "|  | Protocol: Newline-delimited JSON (NDJSON)                   |   |\n"
        "|  | Permissions: group staff, mode 0660                         |   |\n"
        "|  +------------+----------------------------+------------------+   |\n"
        "|               |                            |                      |\n"
        "|    +----------v--------+        +----------v----------+           |\n"
        "|    | Enforcement API   |        | Policy Mgmt API     |           |\n"
        "|    | (no auth needed)  |        | (auth required)     |           |\n"
        "|    |                   |        |                     |           |\n"
        "|    | type: 'hook'      |        | type: 'policy_cmd'  |           |\n"
        "|    | -> PreToolUse     |        | -> add/remove/conf  |           |\n"
        "|    | -> PostToolUse    |        | -> template/profile |           |\n"
        "|    | -> SessionStart   |        | -> mcp approve/deny |           |\n"
        "|    | -> UserPromptSub  |        | -> settings/sync    |           |\n"
        "|    |                   |        |                     |           |\n"
        "|    | Returns:          |        | Auth: 'user-session' |           |\n"
        "|    |  allow/deny/block |        | (only from hook)    |           |\n"
        "|    +--------+----------+        +----------+----------+           |\n"
        "|             |                              |                      |\n"
        "|    +--------v------------------------------v-----------+          |\n"
        "|    | Enforcement Engine                                 |          |\n"
        "|    |  1. ArmorClaude/Copilot/Codex tool allowlist       |          |\n"
        "|    |  2. Policy evaluation (local JSON, <1ms)           |          |\n"
        "|    |  3. OPA PDP client (cloud, cached, optional)       |          |\n"
        "|    |  4. Crypto digest verification (CSRG)              |          |\n"
        "|    |  5. MCP registry + deny-by-default                 |          |\n"
        "|    |  6. Intent token verification                      |          |\n"
        "|    +--------+-----------------------------------------+          |\n"
        "|             |                                                     |\n"
        "|    +--------v----------------------------------------------+     |\n"
        "|    | State Management (owned by _armoriq, not readable by   |     |\n"
        "|    | AI agent user)                                         |     |\n"
        "|    |  /var/lib/armoriq/policy.json          (0600)         |     |\n"
        "|    |  /var/lib/armoriq/policy-pending.json  (0600)         |     |\n"
        "|    |  /var/lib/armoriq/runtime.json         (0600)         |     |\n"
        "|    |  /var/lib/armoriq/crypto-state.json    (0600)         |     |\n"
        "|    |  /var/lib/armoriq/credentials.json     (0600)         |     |\n"
        "|    |  /var/lib/armoriq/profiles/            (0700)         |     |\n"
        "|    |  /var/lib/armoriq/audit-wal/           (0700)         |     |\n"
        "|    +-------------------------------------------------------+     |\n"
        "+-------------------------------------------------------------------+"
    )

    pdf.section_header("4.2 How Policy Mutation Works (Secure Flow)", 2)
    pdf.code_block(
        "Human types /armor-policy add deny Bash\n"
        "        |\n"
        "        v\n"
        "Claude Code: registered skill? -> YES (stub)\n"
        "        |\n"
        "        v\n"
        "UserPromptSubmit hook fires (Claude Code guarantee: human-only)\n"
        "        |\n"
        "        v\n"
        "Hook process (runs as aniket user):\n"
        "  1. Connects to /var/run/armoriq/policyd.sock\n"
        "  2. Sends: {type:'policy_cmd', command:'/armor-policy add deny Bash',\n"
        "             auth:'user-session', reqId:'r-1'}\n"
        "  3. Daemon validates auth tag (only UserPromptSubmit sets this)\n"
        "  4. Daemon stages change to policy-pending.json (it owns the file)\n"
        "  5. Returns proposal text\n"
        "  6. Hook calls blockPrompt(output) -> Claude LLM never sees this"
    )
    pdf.bold_text("Why Claude can NEVER do this:")
    pdf.numbered_item(1, "Claude can't type in the terminal -> can't trigger UserPromptSubmit")
    pdf.numbered_item(2, "Claude can't set auth: 'user-session' -> daemon rejects mutation without it")
    pdf.numbered_item(3, "Even if Claude connects to socket directly, it can only send enforcement queries (no auth)")
    pdf.numbered_item(4, "Claude can't write to /var/lib/armoriq/policy.json -> wrong user, permission denied")
    pdf.numbered_item(5, "Claude can't kill the daemon -> wrong user, kill fails")
    pdf.numbered_item(6, "Claude can't modify daemon code -> wrong user, files are read-only")

    pdf.section_header("4.3 How Enforcement Works (Fast Path)", 2)
    pdf.code_block(
        "Claude wants to call Bash('rm -rf /')\n"
        "        |\n"
        "        v\n"
        "Claude Code fires PreToolUse hook\n"
        "        |\n"
        "        v\n"
        "Hook process (runs as aniket user):\n"
        "  1. Connects to /var/run/armoriq/policyd.sock\n"
        "  2. Sends: {type:'hook', event:'PreToolUse', product:'armorclaude',\n"
        "             input:{tool_name:'Bash', tool_input:{command:'rm -rf /'}}}\n"
        "  3. Daemon evaluates policy (local JSON, <1ms)\n"
        "  4. Returns: {permissionDecision:'deny',\n"
        "              reason:'ArmorClaude: Bash is denied by policy'}\n"
        "  5. Hook relays to Claude Code -> tool call blocked\n"
        "\n"
        "Latency: <5ms total (socket connect + JSON + eval + response)"
    )

    pdf.section_header("4.4 What ArmorClaude Looks Like After Migration", 2)
    pdf.body_text("ArmorClaude shrinks from ~2000 lines of enforcement logic to ~200 lines of client code:")
    pdf.code_block(
        "armorclaude/\n"
        "+-- hooks/hooks.json              # Hook declarations (unchanged)\n"
        "+-- skills/armor-policy/SKILL.md  # Stub for /armor-policy routing\n"
        "+-- .claude-plugin/plugin.json    # Plugin metadata\n"
        "+-- scripts/\n"
        "|   +-- bootstrap.mjs             # Dep installer + dispatcher\n"
        "|   +-- hook-router.mjs           # THIN CLIENT: socket -> daemon\n"
        "|   +-- policy-mcp.mjs            # MCP server (reads via daemon)\n"
        "|   +-- lib/\n"
        "|       +-- daemon-client.mjs     # Socket connect + NDJSON\n"
        "+-- package.json"
    )
    pdf.body_text(
        "Everything else (engine, policy eval, templates, profiles, OPA, crypto, backend sync, audit) "
        "moves to armoriq-policyd."
    )

    pdf.section_header("4.5 Cross-Product Architecture", 2)
    pdf.code_block(
        "+---------------------+  +----------------------+  +------------------+\n"
        "| ArmorClaude         |  | ArmorCopilot         |  | ArmorCodex       |\n"
        "| (Claude Code plugin)|  | (VS Code extension)  |  | (Codex plugin)   |\n"
        "|                     |  |                      |  |                  |\n"
        "| hooks -> daemon-cli |  | inline completion    |  | agent hooks      |\n"
        "| ~200 lines          |  | filter -> daemon-cli |  | -> daemon-cli    |\n"
        "|                     |  | ~150 lines           |  | ~150 lines       |\n"
        "+----------+----------+  +----------+-----------+  +--------+---------+\n"
        "           |                        |                       |\n"
        "           |    All connect to same Unix socket             |\n"
        "           +-------------------+---------------------------+\n"
        "                               |\n"
        "                               v\n"
        "             +--------------------------------------+\n"
        "             | armoriq-policyd                       |\n"
        "             | (single daemon, all products)         |\n"
        "             |                                       |\n"
        "             | Policy rules can be:                  |\n"
        "             |  - Global (apply to all products)     |\n"
        "             |  - Product-specific (armorclaude only)|\n"
        "             |  - Tool-specific (Bash, Edit, etc.)   |\n"
        "             +--------------------------------------+"
    )

    # ===== PART 5 =====
    pdf.section_header("Part 5: Security Deep Dive", 1)

    pdf.section_header("5.1 Attack Vector Analysis (Current vs Daemon)", 2)
    pdf.table(
        ["#", "Attack", "Current (same user)", "With daemon (separate user)"],
        [
            ["1", "Claude writes to policy.json via Edit/Write", "Path guard blocks (regex, bypassable)", "Unix permissions block. Period."],
            ["2", "Claude writes to policy.json via Bash redirect", "WRITE_OPS regex blocks (bypassable)", "Unix permissions block. Period."],
            ["3", "Claude imports handler via Bash", "Handler name regex (bypassable)", "Handler code owned by _armoriq, can't import"],
            ["4", "Claude base64-encodes policy-modifying script", "No guard catches this", "Decoded script still can't write to _armoriq files"],
            ["5", "Claude kills the enforcement daemon", "Same user, kill works", "Different user, kill returns EPERM"],
            ["6", "Claude reads API key from credentials", "Same user, cat works", "File owned by _armoriq (0600), permission denied"],
            ["7", "Claude modifies daemon code/config", "Same user, write works", "Code owned by _armoriq, write denied"],
            ["8", "Claude sends policy mutation via socket", "Can connect and send anything", "Mutation requires auth: 'user-session' (can't set)"],
            ["9", "Claude chmod policy files", "Same user, chmod works", "Can't chmod files owned by different user"],
            ["10", "Claude uses sudo to escalate", "Not available without password", "Same -- not available without password"],
            ["11", "Prompt injection in tool output", "/armor-policy text has no effect", "Same -- still no effect"],
            ["12", "Claude social-engineers user", "Human makes conscious decision", "Same -- unavoidable"],
        ]
    )
    pdf.highlight_box("Score: Current = 4/12 blocked. Daemon = 11/12 blocked (only social engineering remains).", "green")

    pdf.section_header("5.2 The Socket Authentication Model", 2)
    pdf.body_text(
        "The daemon socket is accessible to any user in the staff group (mode 0660). "
        "This means Claude CAN connect and send messages. Here's why that's still secure:"
    )
    pdf.bold_text("Read operations (no auth needed):")
    pdf.bullet("type: 'hook' -> PreToolUse enforcement queries")
    pdf.bullet("type: 'policy_read' -> list policies")
    pdf.bullet("type: 'ping' -> health check")
    pdf.body_text("These are fine for Claude to call. Getting policy decisions is the whole point.")
    pdf.ln(2)
    pdf.bold_text("Write operations (auth required):")
    pdf.body_text(
        "The auth: 'user-session' tag is set by the UserPromptSubmit hook handler. "
        "This hook only fires on human terminal input. Claude's process can connect to the socket, "
        "but it can't set auth: 'user-session' because:"
    )
    pdf.numbered_item(1, "The tag is hardcoded in hook-router.mjs inside the UserPromptSubmit handler")
    pdf.numbered_item(2, "Claude can't modify hook-router.mjs (owned by plugin / _armoriq)")
    pdf.numbered_item(3, "Even if Claude sends the tag directly, the daemon can verify via peer credentials")
    pdf.ln(2)
    pdf.bold_text("Defense in depth for socket auth:")
    pdf.bullet("Level 1: auth tag presence (filters casual attempts)")
    pdf.bullet("Level 2: Peer credential check (SO_PEERCRED on Linux / LOCAL_PEERCRED on macOS)")
    pdf.bullet("Level 3: Verify PID is a child of Claude Code's hook spawn (process tree check)")

    pdf.section_header("5.3 Failure Modes", 2)
    pdf.table(
        ["Scenario", "Behavior", "Why this is correct"],
        [
            ["Daemon not installed", "ArmorClaude enters observe-only mode (audit, no enforcement)", "User chose not to install; docs explain the trade-off"],
            ["Daemon crashes", "launchd/systemd restarts it; hooks fail-closed (deny-all) during gap", "Better to block briefly than allow everything"],
            ["Socket file deleted", "Daemon recreates on restart; hooks fail-closed until socket exists", "Same as crash -- transient, auto-recovers"],
            ["Backend unreachable", "Local enforcement continues; audit WAL queues until backend returns", "Offline-first design"],
            ["Policy file corrupted", "Crypto digest mismatch -> daemon refuses to load -> deny-all + alert", "Tamper detection at daemon level"],
            ["OPA unreachable", "Circuit breaker opens -> falls back to local JSON evaluation", "Graceful degradation"],
        ]
    )

    pdf.section_header("5.4 Comparison: ArmorIQ vs Industry", 2)
    pdf.table(
        ["Capability", "OPA/Styra", "Cerbos", "Permit.io", "Invariant", "ArmorIQ (proposed)"],
        [
            ["Separate trust domain", "Sidecar container", "Sidecar/service", "Sidecar PDP", "Gateway proxy", "System user daemon"],
            ["Policy push mechanism", "GCS bundles", "Git/S3 sync", "OPAL pub/sub", "Gateway config", "Backend sync + local CRUD"],
            ["Evaluation latency", "Sub-ms (local)", "Sub-ms (local)", "1-5ms (local)", "Near-zero", "<5ms (Unix socket)"],
            ["Offline support", "Yes (cached bundles)", "Yes (local policy)", "Partial (cached)", "No (needs proxy)", "Yes (local JSON)"],
            ["AI agent awareness", "No", "No", "No", "Yes (built for AI)", "Yes (built for AI)"],
            ["Multi-product", "Generic", "Generic", "Generic", "AI agents only", "AI tools specific"],
            ["Human-only mutation", "N/A (ops workflow)", "N/A (git PR)", "N/A (dashboard)", "N/A", "UserPromptSubmit hook"],
            ["Crypto tamper detection", "Bundle signing", "No", "No", "No", "CSRG Merkle proofs"],
        ]
    )
    pdf.bold_text("ArmorIQ's unique differentiators:")
    pdf.numbered_item(1, "Purpose-built for AI tool enforcement (not generic authz)")
    pdf.numbered_item(2, "Human-only policy mutation via Claude Code's UserPromptSubmit architectural guarantee")
    pdf.numbered_item(3, "Cryptographic tamper detection via CSRG tokens with Merkle proofs")
    pdf.numbered_item(4, "Multi-AI-tool support from a single daemon (Claude, Copilot, Codex)")
    pdf.numbered_item(5, "Offline-first with optional cloud sync (vs cloud-dependent competitors)")

    # ===== PART 6 =====
    pdf.section_header("Part 6: Implementation Strategy", 1)

    pdf.section_header("6.1 Phase Overview", 2)
    pdf.table(
        ["Phase", "What", "Effort", "Delivers"],
        [
            ["Phase 0", "Ship current architecture (same-user) as v0.3", "1 week", "Working policy system, 195 tests, immediate value"],
            ["Phase 1", "Create armoriq-policyd repo, extract daemon", "2 weeks", "Standalone daemon with socket API"],
            ["Phase 2", "System service installer (launchd + systemd)", "2 weeks", "OS-level isolation, _armoriq user"],
            ["Phase 3", "ArmorClaude thin client migration", "1 week", "ArmorClaude becomes ~200 lines"],
            ["Phase 4", "Socket authentication hardening", "1 week", "Peer credential checks, nonce verification"],
            ["Phase 5", "Cross-product client library", "2 weeks", "@armoriq/policy-client npm + Python packages"],
        ]
    )

    pdf.section_header("6.2 What Goes Where", 2)
    pdf.bold_text("armoriq-policyd (new repo) -- the daemon and all enforcement logic:")
    pdf.bullet("daemon.mjs (socket server, message routing)")
    pdf.bullet("engine.mjs (enforcement handlers)")
    pdf.bullet("armor-policy-commands.mjs (policy CRUD)")
    pdf.bullet("policy.mjs, policy-templates.mjs, policy-profiles.mjs")
    pdf.bullet("tool-registry.mjs, opa-client.mjs, policy-compiler.mjs")
    pdf.bullet("crypto-policy.mjs, backend-client.mjs")
    pdf.bullet("runtime-state.mjs, audit-wal.mjs, fs-store.mjs")
    pdf.bullet("config.mjs (daemon-specific, reads from /var/lib/armoriq/)")
    pdf.bullet("install/ (installer scripts, launchd plist, systemd unit)")
    pdf.ln(3)
    pdf.bold_text("armorclaude (existing repo) -- thin client only:")
    pdf.bullet("hook-router.mjs (connect to daemon, relay events)")
    pdf.bullet("daemon-client.mjs (socket connect + NDJSON)")
    pdf.bullet("policy-mcp.mjs (MCP server, reads via daemon)")
    pdf.bullet("skills/armor-policy/SKILL.md (routing stub)")

    pdf.section_header("6.3 Installer Experience", 2)
    pdf.code_block(
        "# Developer runs:\n"
        "curl -fsSL https://install.armoriq.ai/policyd | sudo bash\n"
        "\n"
        "# What happens:\n"
        "# 1. Creates _armoriq system user (if not exists)\n"
        "# 2. Creates /var/lib/armoriq/ with correct ownership\n"
        "# 3. Installs daemon to /usr/local/lib/armoriq/\n"
        "# 4. Installs launchd plist (macOS) or systemd unit (Linux)\n"
        "# 5. Starts the daemon\n"
        "# 6. Adds current user to staff group (for socket access)\n"
        "# 7. Prints: 'ArmorIQ Policy Daemon installed.'\n"
        "\n"
        "# Verify:\n"
        "armoriq-policyd status\n"
        "# -> ArmorIQ Policy Daemon v1.0.0 | running | uptime: 5s"
    )

    # ===== PART 7 =====
    pdf.section_header("Part 7: Open Questions for Brainstorming", 1)

    questions = [
        ("Should the daemon support Windows?", "Named pipes instead of Unix sockets, Windows service instead of launchd/systemd"),
        ("Should we build an admin dashboard?", "Web UI for policy management, complementing /armor-policy CLI commands"),
        ("Should the daemon expose metrics?", "Prometheus endpoint for decision counts, latency percentiles, deny rates"),
        ("How should org-wide policy distribution work?", "Backend pushes to all daemons? Daemons poll? Git-based like Cerbos?"),
        ("Should we support 'break glass'?", "Emergency override that bypasses all policy -- requires physical MFA token?"),
        ("Homebrew formula?", "brew install armoriq-policyd for easier macOS installation, avoids curl-pipe-sudo"),
        ("How does this interact with Claude Code's own permission system?", "Claude Code has its own allow/deny for tools -- should ArmorIQ layer on top, or replace it?"),
    ]
    for i, (q, detail) in enumerate(questions, 1):
        pdf.set_font("Helvetica", "B", 10)
        pdf.set_text_color(20, 60, 120)
        pdf.cell(0, 6, f"{i}. {clean(q)}")
        pdf.ln(6)
        pdf.set_font("Helvetica", "", 10)
        pdf.set_text_color(80, 80, 80)
        pdf.set_x(18)
        pdf.multi_cell(0, 5.5, clean(detail))
        pdf.ln(3)

    # ===== PART 8 =====
    pdf.section_header("Part 8: Risk Assessment", 1)

    pdf.table(
        ["Risk", "Impact", "Likelihood", "Mitigation"],
        [
            ["sudo installation friction reduces adoption", "High", "Medium", "Homebrew formula; clear docs; observe-only mode without daemon"],
            ["macOS Gatekeeper blocks unsigned daemon", "Medium", "High", "Sign with Apple Developer ID or distribute via Homebrew"],
            ["Socket permission misconfiguration", "High", "Low", "Installer validates; daemon refuses to start if insecure"],
            ["Users lose policy when daemon crashes", "Medium", "Low", "launchd/systemd auto-restart; WAL for audit durability"],
            ["Version mismatch (client vs daemon)", "Medium", "Medium", "Version handshake in ping; client warns on mismatch"],
            ["Breaking change in Claude Code hook system", "High", "Low", "Hooks are Claude Code's documented public API; unlikely to break"],
            ["Competitor ships similar product faster", "Medium", "Medium", "Ship v0.3 (current) immediately; daemon is the v1.0 upgrade"],
        ]
    )

    return pdf


if __name__ == "__main__":
    pdf = build_report()
    out = "ArmorIQ-Policy-Isolation-Report.pdf"
    pdf.output(out)
    print(f"Generated: {out}")
