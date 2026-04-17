#!/usr/bin/env bash
set -euo pipefail

# ArmorClaude installer for Claude Code
#
# Usage:
#   curl -fsSL https://armoriq.ai/install_armorclaude.sh | bash
#
# Non-interactive overrides:
#   ARMORCLAUDE_MARKETPLACE_REPO=<path>   override marketplace source (testing)

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
DASHBOARD_URL="https://dev.armoriq.ai"

# Recover if the caller launched the installer from a directory that was deleted.
if ! pwd >/dev/null 2>&1; then
  cd "${HOME:-/}" 2>/dev/null || cd /
fi

# ---------------------------------------------------------------------------
# UI helpers
# ---------------------------------------------------------------------------

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

# ---------------------------------------------------------------------------
# Prereq checks
# ---------------------------------------------------------------------------

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

# ---------------------------------------------------------------------------
# Plugin install
# ---------------------------------------------------------------------------

install_plugin() {
  section "Installing plugin"

  info "adding marketplace ${B}${MARKETPLACE_REPO}${N}"
  if ! claude plugin marketplace add "${MARKETPLACE_REPO}" >/dev/null 2>&1; then
    # already added is fine — re-fetch in case the source moved
    claude plugin marketplace update armoriq >/dev/null 2>&1 || true
  fi
  ok "marketplace ready"

  info "installing plugin ${B}${PLUGIN_REF}${N}"
  claude plugin install "${PLUGIN_REF}" >/dev/null
  ok "plugin installed"

  info "installing ArmorIQ CLI ${B}(@armoriq/sdk-dev)${N}"
  npm install -g @armoriq/sdk-dev@latest --silent --no-audit --no-fund >/dev/null 2>&1 \
    && ok "armoriq CLI ready" \
    || warn "couldn't install globally — use ${B}npx @armoriq/sdk-dev${N} instead"
}

# ---------------------------------------------------------------------------
# Verification + finale
# ---------------------------------------------------------------------------

verify_install() {
  section "Verifying"
  local listed
  listed="$(claude plugin list 2>/dev/null | grep -E "armorclaude" || true)"
  if [[ -n "$listed" ]]; then
    ok "armorclaude is enabled"
  else
    warn "couldn't confirm armorclaude is enabled — run: ${B}claude plugin list${N}"
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
    printf "  Run ${G}${B}armoriq login${N} to connect later.\n\n"
    return 0
  fi

  if ! prompt_yes_no "Connect your ArmorIQ account now?" "Y"; then
    echo
    printf "  No problem. Run ${G}${B}armoriq login${N} anytime to connect.\n\n"
    return 0
  fi

  echo
  # Run armoriq login inline — uses the globally installed CLI or npx fallback
  if command -v armoriq >/dev/null 2>&1; then
    armoriq login
  elif command -v npx >/dev/null 2>&1; then
    npx @armoriq/sdk-dev login
  else
    warn "armoriq CLI not found. Run ${B}npx @armoriq/sdk-dev login${N} manually."
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

  section "Manage anytime"
  cat <<EOF

  ${D}claude plugin list${N}
  ${D}claude plugin disable armorclaude${N}
  ${D}claude plugin enable  armorclaude${N}
  ${D}claude plugin update  armorclaude${N}

  Docs: ${C}https://armorclaude-docs.armoriq.ai${N}

EOF
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

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
