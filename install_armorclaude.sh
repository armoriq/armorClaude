#!/usr/bin/env bash
set -euo pipefail

R=$'\033[1;31m'
G=$'\033[32m'
Y=$'\033[33m'
C=$'\033[38;2;0;229;204m'
M=$'\033[38;2;185;112;255m'
B=$'\033[1m'
D=$'\033[0;90m'
N=$'\033[0m'

MARKETPLACE_REPO="${ARMORCLAUDE_MARKETPLACE_REPO:-armoriq/armorClaude}"
PLUGIN_REF="armorclaude@armoriq"
DASHBOARD_URL="https://tools.armoriq.ai"

if ! pwd >/dev/null 2>&1; then
  cd "${HOME:-/}" 2>/dev/null || cd /
fi

ok()    { printf "${G}✔${N} %s\n" "$*"; }
warn()  { printf "${Y}!${N} %s\n" "$*"; }
err()   { printf "${R}✘${N} %s\n" "$*" 1>&2; }
info()  { printf "${D}·${N} %s\n" "$*"; }
section() { printf "\n${B}${M}┃ %s${N}\n" "$*"; }

banner() {
  cat <<EOF

${C}${B}     █████╗ ██████╗ ███╗   ███╗ ██████╗ ██████╗  ██████╗██╗      █████╗ ██╗   ██╗██████╗ ███████╗${N}
${C}${B}    ██╔══██╗██╔══██╗████╗ ████║██╔═══██╗██╔══██╗██╔════╝██║     ██╔══██╗██║   ██║██╔══██╗██╔════╝${N}
${C}${B}    ███████║██████╔╝██╔████╔██║██║   ██║██████╔╝██║     ██║     ███████║██║   ██║██║  ██║█████╗  ${N}
${C}${B}    ██╔══██║██╔══██╗██║╚██╔╝██║██║   ██║██╔══██╗██║     ██║     ██╔══██║██║   ██║██║  ██║██╔══╝  ${N}
${C}${B}    ██║  ██║██║  ██║██║ ╚═╝ ██║╚██████╔╝██║  ██║╚██████╗███████╗██║  ██║╚██████╔╝██████╔╝███████╗${N}
${C}${B}    ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚═╝ ╚═════╝ ╚═╝  ╚═╝ ╚═════╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚══════╝${N}

      ${D}Intent-based security enforcement for Claude Code${N}
      ${D}Policy rules · Intent verification · CSRG proofs · Audit logging${N}

EOF
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "missing required command: $1"
    case "$1" in
      claude) echo "  install Claude Code from https://claude.com/download" 1>&2 ;;
      node)   echo "  install Node.js >= 20 from https://nodejs.org" 1>&2 ;;
      git)    echo "  install git from https://git-scm.com/downloads" 1>&2 ;;
    esac
    exit 1
  fi
}

check_node_version() {
  local raw major
  raw="$(node --version 2>/dev/null || true)"
  major="$(printf '%s' "${raw#v}" | cut -d. -f1)"
  if [[ -z "${major}" || "${major}" -lt 20 ]]; then
    err "Node.js >= 20 required (found ${raw:-none})"
    exit 1
  fi
}

# A third-party marketplace defaults to no auto-update and the CLI has no flag
# for it. `claude plugin marketplace add` rewrites the entry without autoUpdate,
# so install_plugin reads the user's choice before the add and passes it here:
# an explicit false stays false and anything else becomes true.
auto_update_choice() {
  ARMORIQ_CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-${HOME}/.claude}" node -e '
    const fs = require("fs");
    const path = require("path");
    const read = (file) => {
      try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        return {};
      }
    };
    const dir = process.env.ARMORIQ_CLAUDE_DIR;
    const inSettings = read(path.join(dir, "settings.json"))?.extraKnownMarketplaces?.armoriq?.autoUpdate;
    const fromToggle = read(path.join(dir, "plugins", "known_marketplaces.json"))?.armoriq?.autoUpdate;
    const value = typeof inSettings === "boolean" ? inSettings : fromToggle;
    if (typeof value === "boolean") process.stdout.write(String(value));
  ' 2>/dev/null || true
}

enable_auto_update() {
  if [[ "${ARMORCLAUDE_NO_AUTO_UPDATE:-}" == "1" ]]; then
    info "leaving updates manual (ARMORCLAUDE_NO_AUTO_UPDATE=1)"
    return 0
  fi

  local status=0
  ARMORIQ_CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-${HOME}/.claude}" ARMORIQ_MARKETPLACE_REPO="${MARKETPLACE_REPO}" ARMORIQ_PRIOR="${1:-}" node -e '
    const fs = require("fs");
    const path = require("path");
    const dir = process.env.ARMORIQ_CLAUDE_DIR;
    const link = path.join(dir, "settings.json");
    const file = fs.existsSync(link) ? fs.realpathSync(link) : link;
    const read = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {});
    const settings = read(file);
    const known = read(path.join(dir, "plugins", "known_marketplaces.json")).armoriq;
    const places = (settings.extraKnownMarketplaces ??= {});
    const armoriq = (places.armoriq ??= {
      source: known?.source ?? { source: "github", repo: process.env.ARMORIQ_MARKETPLACE_REPO },
    });
    const prior = process.env.ARMORIQ_PRIOR;
    const choice = prior === "true" || prior === "false" ? prior === "true" : armoriq.autoUpdate;
    const wanted = choice !== false && known?.autoUpdate !== false;
    if (armoriq.autoUpdate === wanted) process.exit(wanted ? 2 : 3);
    armoriq.autoUpdate = wanted;
    const mode = fs.existsSync(file) ? fs.statSync(file).mode & 0o7777 : 0o644;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.armoriq-${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode });
    fs.chmodSync(temporary, mode);
    fs.renameSync(temporary, file);
    process.exit(wanted ? 0 : 3);
  ' 2>/dev/null || status=$?

  case "${status}" in
    0) ok "updates are automatic (Claude Code installs a new version during a session, within about 10 minutes of your first message)" ;;
    2) ok "updates are already automatic" ;;
    3) info "leaving updates manual: auto-update for armoriq is turned off on this machine" ;;
    *) warn "couldn't turn on automatic updates; run ${B}claude plugin update ${PLUGIN_REF}${N} to update" ;;
  esac
}

install_plugin() {
  section "Installing plugin"

  local auto_update_before
  auto_update_before="$(auto_update_choice)"

  info "adding marketplace ${B}${MARKETPLACE_REPO}${N}"
  claude plugin marketplace add "${MARKETPLACE_REPO}" >/dev/null 2>&1 || true
  # add succeeds without fetching when armoriq is already on disk.
  claude plugin marketplace update armoriq >/dev/null 2>&1 || true
  ok "marketplace ready"

  enable_auto_update "${auto_update_before}"

  info "installing plugin ${B}${PLUGIN_REF}${N}"
  claude plugin install "${PLUGIN_REF}" >/dev/null
  ok "plugin installed"

  # Pre-install the plugin's own node_modules. Without this the first MCP
  # connect pays for `npm install` inside the handshake and Claude Code reports
  # "Failed to connect — MCP error -32000: Connection closed".
  info "preparing plugin dependencies"
  local plugin_dir
  plugin_dir="$(ls -d "${CLAUDE_CONFIG_DIR:-${HOME}/.claude}"/plugins/cache/armoriq/armorclaude/*/ 2>/dev/null | sort -V | tail -1)"
  if [[ -n "${plugin_dir}" && -f "${plugin_dir}scripts/bootstrap.mjs" ]]; then
    if node "${plugin_dir}scripts/bootstrap.mjs" warm >/dev/null 2>&1; then
      ok "dependencies ready"
    else
      warn "couldn't pre-install dependencies — the first Claude Code start may be slow"
    fi
  else
    warn "couldn't locate the installed plugin — the first Claude Code start may be slow"
  fi

  info "installing ArmorIQ CLI ${B}(@armoriq/sdk)${N}"
  npm install -g @armoriq/sdk@latest --silent --no-audit --no-fund >/dev/null 2>&1 \
    && ok "armoriq CLI ready" \
    || warn "couldn't install globally — use ${B}npx @armoriq/sdk${N} instead"
}

verify_install() {
  section "Verifying"
  local listing status
  listing="$(claude plugin list 2>/dev/null || true)"
  status="$(printf '%s\n' "$listing" | grep -A3 "armorclaude@armoriq" | grep -m1 "Status:" || true)"
  if [[ -z "$status" ]]; then
    warn "couldn't confirm armorclaude is installed — run: ${B}claude plugin list${N}"
  elif [[ "$status" == *disabled* ]]; then
    warn "armorclaude is installed but ${B}disabled${N} — enable it with: ${B}claude plugin enable armorclaude@armoriq${N}"
  else
    ok "armorclaude is enabled"
  fi

  if claude mcp list 2>/dev/null | grep -q "armorclaude-policy.*Connected"; then
    ok "policy MCP server connected"
  else
    warn "policy MCP server not connected — run: ${B}claude mcp list${N}"
  fi
}

is_promptable() {
  [[ -e /dev/tty ]] || return 1
  (: < /dev/tty) 2>/dev/null || return 1
  return 0
}

prompt_yes_no() {
  local question="$1" default="${2:-Y}"
  local hint="(Y/n)"
  [[ "$default" == "N" ]] && hint="(y/N)"
  if ! is_promptable; then
    [[ "$default" == "Y" ]]; return $?
  fi
  printf "${B}?${N} %s ${D}%s${N} " "$question" "$hint" >&2
  local answer
  read -r answer < /dev/tty || answer=""
  [[ -z "$answer" ]] && { [[ "$default" == "Y" ]]; return $?; }
  [[ "$answer" =~ ^[Yy] ]]
}

connect_to_armoriq() {
  section "Connect to ArmorIQ"
  cat <<EOF

  Unlocks: signed JWT intent tokens, audit logs, CSRG proofs,
  and dashboard visibility for all intent plans.

EOF

  if ! is_promptable; then
    printf "  Run ${G}${B}armoriq login --product armorclaude${N} to connect later.\n\n"
    return 0
  fi

  if ! prompt_yes_no "Connect your ArmorIQ account now?" "Y"; then
    echo
    printf "  No problem. Run ${G}${B}armoriq login --product armorclaude${N} anytime to connect.\n\n"
    return 0
  fi

  echo
  if command -v armoriq >/dev/null 2>&1; then
    armoriq login --product armorclaude
  elif command -v npx >/dev/null 2>&1; then
    npx @armoriq/sdk login --product armorclaude
  else
    warn "armoriq CLI not found. Run ${B}npx @armoriq/sdk login --product armorclaude${N} manually."
    return 0
  fi

  local login_status=$?
  if [[ $login_status -eq 0 ]] && [[ -f "$HOME/.armoriq/credentials.json" ]]; then
    echo
    ok "ArmorIQ connected. Claude Code will auto-load the key."
  fi
}

finale() {
  echo
  printf "${G}${B}ArmorClaude is installed.${N}\n"

  section "Quick start"
  cat <<EOF

  Start a Claude Code session in any project:

    ${G}${B}claude${N}

  Try a prompt — ArmorClaude will tell Claude to register an intent
  plan first. Tools not in the plan get blocked (intent drift).

  Add policy rules from any prompt:

    ${D}> Policy new: deny WebFetch${N}

EOF

  section "Policy bundles (optional)"
  cat <<EOF

  Bundles are opt-in — nothing is applied until you pick one and
  confirm it. Apply one, or merge several (most-restrictive-wins):

    ${D}> /armorclaude:armor template balanced${N}
    ${D}> /armorclaude:armor template quality-guardian,architect${N}

  Available: all-allow, strict-read-only, balanced, lockdown,
             architect, quality-guardian, velocity-machine, night-owl

EOF

  section "Manage anytime"
  cat <<EOF

  ${D}claude plugin list${N}
  ${D}claude plugin disable armorclaude${N}
  ${D}claude plugin enable  armorclaude${N}
  ${D}claude plugin update  armorclaude${N}

  Docs: ${C}https://github.com/armoriq/armorClaude${N}

EOF
}

main() {
  banner
  section "Checking prerequisites"
  require_cmd claude
  require_cmd node
  require_cmd git
  check_node_version
  ok "prerequisites OK ($(claude --version 2>/dev/null | head -1), $(node --version))"

  install_plugin
  verify_install
  connect_to_armoriq
  finale
}

main "$@"
