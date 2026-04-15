#!/usr/bin/env bash
set -euo pipefail

# ArmorClaude installer for Claude Code
# Usage: curl -fsSL https://armoriq.ai/install-armorclaude.sh | bash
#    or: curl -fsSL https://raw.githubusercontent.com/armoriq/armorClaude/main/install.sh | bash

R=$'\033[1;31m'
G=$'\033[32m'
Y=$'\033[33m'
C=$'\033[38;2;0;229;204m'
B=$'\033[1m'
D=$'\033[0;90m'
N=$'\033[0m'

MARKETPLACE_REPO="${ARMORCLAUDE_MARKETPLACE_REPO:-armoriq/armorClaude}"
PLUGIN_REF="armorclaude@armoriq"

banner() {
  printf "\n${C}${B}     ArmorClaude${N} ${D}— intent-based security for Claude Code${N}\n\n"
}

ok()    { printf "${G}✔${N} %s\n" "$*"; }
warn()  { printf "${Y}!${N} %s\n" "$*"; }
err()   { printf "${R}✘${N} %s\n" "$*" 1>&2; }
info()  { printf "${D}·${N} %s\n" "$*"; }

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "missing required command: $1"
    case "$1" in
      claude)
        echo "  install Claude Code from https://claude.com/download" 1>&2
        ;;
      node)
        echo "  install Node.js >= 20 from https://nodejs.org" 1>&2
        ;;
      git)
        echo "  install git from https://git-scm.com/downloads" 1>&2
        ;;
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

main() {
  banner
  require_cmd claude
  require_cmd node
  require_cmd git
  check_node_version
  ok "prerequisites OK ($(claude --version 2>/dev/null | head -1), $(node --version))"

  info "adding marketplace ${B}${MARKETPLACE_REPO}${N}"
  if ! claude plugin marketplace add "${MARKETPLACE_REPO}" >/dev/null 2>&1; then
    # already added is fine — re-fetch in case it changed
    claude plugin marketplace update armoriq >/dev/null 2>&1 || true
  fi
  ok "marketplace ready"

  info "installing plugin ${B}${PLUGIN_REF}${N}"
  claude plugin install "${PLUGIN_REF}" >/dev/null
  ok "plugin installed"

  echo
  printf "${G}${B}ArmorClaude is installed.${N}\n\n"
  printf "${B}Next steps${N}\n"
  printf "  ${C}1.${N} Start a new Claude Code session in any project:\n"
  printf "       ${D}claude${N}\n"
  printf "  ${C}2.${N} Try a command. Claude will be told to register an intent\n"
  printf "       plan via the ${B}register_intent_plan${N} MCP tool. Tools that\n"
  printf "       are not in the plan will be blocked (intent drift).\n"
  printf "  ${C}3.${N} (Optional) Connect to ArmorIQ for full audit + crypto proofs:\n"
  printf "       ${D}/plugin${N} → configure ${B}armorclaude${N} → set your ${B}api_key${N}\n"
  printf "       Get a key at ${C}https://armoriq.ai${N}\n\n"
  printf "  Toggle on/off any time:\n"
  printf "       ${D}claude plugin disable armorclaude${N}\n"
  printf "       ${D}claude plugin enable  armorclaude${N}\n\n"
  printf "  Docs: ${C}https://github.com/${MARKETPLACE_REPO}${N}\n\n"
}

main "$@"
