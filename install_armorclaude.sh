#!/usr/bin/env bash
set -euo pipefail

# ArmorClaude installer for Claude Code
#
# Usage:
#   curl -fsSL https://armoriq.ai/install-armorclaude.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/armoriq/armorClaude/main/install_armorclaude.sh | bash
#
# Non-interactive overrides:
#   ARMORIQ_API_KEY=ak_live_...           skip the API-key prompt, use this key
#   ARMORCLAUDE_SKIP_KEY=1                skip the API-key step entirely
#   ARMORCLAUDE_NO_PROMPT=1               assume defaults for every prompt
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
API_KEY_INPUT="${ARMORIQ_API_KEY:-}"

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

is_promptable() {
  [[ "${ARMORCLAUDE_NO_PROMPT:-0}" == "1" ]] && return 1
  # /dev/tty must exist AND actually be openable from this process
  # (a piped/no-controlling-tty install will fail the second check).
  [[ -e /dev/tty ]] || return 1
  (: < /dev/tty) 2>/dev/null || return 1
  return 0
}

prompt_yes_no() {
  # $1 = question, $2 = default (Y or N)
  local question="$1"
  local default="${2:-Y}"
  local hint="(Y/n)"
  [[ "$default" == "N" ]] && hint="(y/N)"
  if ! is_promptable; then
    [[ "$default" == "Y" ]]
    return $?
  fi
  local answer
  printf "${B}?${N} %s ${D}%s${N} " "$question" "$hint" >&2
  read -r answer < /dev/tty || answer=""
  if [[ -z "$answer" ]]; then
    [[ "$default" == "Y" ]]
    return $?
  fi
  [[ "$answer" =~ ^[Yy] ]]
}

prompt_secret() {
  # $1 = prompt
  local prompt_text="$1"
  if ! is_promptable; then
    echo ""
    return 0
  fi
  printf "${B}?${N} %s\n  ${D}(input hidden, paste then press Enter)${N}\n  > " "$prompt_text" >&2
  local result
  # Use stty to disable echo for the masked input
  if stty -echo < /dev/tty 2>/dev/null; then
    read -r result < /dev/tty || result=""
    stty echo < /dev/tty 2>/dev/null || true
    echo "" >&2
  else
    read -r result < /dev/tty || result=""
  fi
  echo "$result"
}

open_url() {
  local url="$1"
  if command -v open >/dev/null 2>&1; then
    open "$url" >/dev/null 2>&1 &
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url" >/dev/null 2>&1 &
  else
    return 1
  fi
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
# API key flow
# ---------------------------------------------------------------------------

valid_api_key() {
  [[ "$1" =~ ^ak_(live|test)_[a-zA-Z0-9]{32,}$ ]]
}

api_key_step() {
  if [[ -n "$API_KEY_INPUT" ]]; then
    if valid_api_key "$API_KEY_INPUT"; then
      ok "using API key from environment"
      return 0
    else
      warn "ARMORIQ_API_KEY in env doesn't look valid (expected ak_live_... or ak_test_...) — ignoring"
      API_KEY_INPUT=""
    fi
  fi

  if [[ "${ARMORCLAUDE_SKIP_KEY:-0}" == "1" ]]; then
    info "skipping API key (ARMORCLAUDE_SKIP_KEY=1) — local-only mode active"
    return 0
  fi

  section "ArmorIQ API key (optional)"
  cat <<EOF

  ArmorClaude works in two modes:

    ${G}${B}Local-only${N}  ${D}(no key)${N}      intent enforcement, policy rules, drift detection
    ${C}${B}Backend-connected${N}  ${D}(key)${N}  + signed JWT tokens, audit logs, CSRG proofs

EOF

  if ! prompt_yes_no "Do you have an ArmorIQ API key?" "Y"; then
    echo
    info "No problem. Get one any time at:"
    printf "    ${C}${B}%s${N}\n" "$DASHBOARD_URL"
    if prompt_yes_no "  Open the dashboard now?" "Y"; then
      if open_url "$DASHBOARD_URL"; then
        ok "opened $DASHBOARD_URL"
      else
        warn "couldn't auto-open browser — visit $DASHBOARD_URL manually"
      fi
      echo
      if prompt_yes_no "  Once you have a key, ready to paste it now?" "Y"; then
        :  # fall through to paste step
      else
        info "skipped — local-only mode active. You can set ARMORIQ_API_KEY later."
        return 0
      fi
    else
      info "skipped — local-only mode active. You can set ARMORIQ_API_KEY later."
      return 0
    fi
  fi

  echo
  for attempt in 1 2 3; do
    API_KEY_INPUT="$(prompt_secret "Paste your ArmorIQ API key (ak_live_... or ak_test_...)")"
    if [[ -z "$API_KEY_INPUT" ]]; then
      warn "no key entered — skipping (local-only mode active)"
      return 0
    fi
    if valid_api_key "$API_KEY_INPUT"; then
      ok "API key looks valid"
      return 0
    fi
    warn "that doesn't look like an ArmorIQ key (expected ak_live_... or ak_test_...). Try again ($attempt/3)."
  done
  warn "giving up on API key after 3 attempts — local-only mode active"
  API_KEY_INPUT=""
}

persist_api_key() {
  [[ -z "$API_KEY_INPUT" ]] && return 0

  local export_line="export ARMORIQ_API_KEY=\"$API_KEY_INPUT\"  # ArmorClaude — added by install_armorclaude.sh"
  local persisted_to=()
  local rc

  for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile"; do
    [[ -f "$rc" ]] || continue
    # Strip any prior ArmorClaude-managed line first (idempotent re-run)
    if grep -q "ArmorClaude — added by install_armorclaude.sh" "$rc" 2>/dev/null; then
      # In-place strip without sed -i portability headaches
      local tmp
      tmp="$(mktemp)"
      grep -v "ArmorClaude — added by install_armorclaude.sh" "$rc" > "$tmp" || true
      cat "$tmp" > "$rc"
      rm -f "$tmp"
    fi
    printf "\n%s\n" "$export_line" >> "$rc"
    persisted_to+=("$rc")
  done

  # Also export it for the rest of THIS process so the verify step works.
  export ARMORIQ_API_KEY="$API_KEY_INPUT"

  if [[ ${#persisted_to[@]} -gt 0 ]]; then
    ok "saved ARMORIQ_API_KEY to: ${persisted_to[*]}"
    info "open a new shell or run: ${B}source ${persisted_to[0]}${N}"
  else
    warn "no shell rc file found (~/.zshrc, ~/.bashrc, ~/.bash_profile) — set ARMORIQ_API_KEY manually"
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

finale() {
  echo
  printf "${G}${B}ArmorClaude is installed.${N}\n\n"

  section "Quick start"
  cat <<EOF

  ${C}1.${N} Start a Claude Code session in any project:
       ${D}claude${N}

  ${C}2.${N} Try a prompt — ArmorClaude will tell Claude to register an intent
     plan first. Tools not in the plan get blocked (intent drift).

  ${C}3.${N} Add policy rules from any prompt, e.g.:
       ${D}> Policy new: deny WebFetch${N}

EOF

  if [[ -z "$API_KEY_INPUT" ]]; then
    section "Optional: connect to ArmorIQ"
    printf "  Get an API key at ${C}${B}%s${N}\n" "$DASHBOARD_URL"
    printf "  Then set it once: ${D}export ARMORIQ_API_KEY=ak_live_...${N}\n\n"
    printf "  This unlocks: signed JWT tokens, audit logs to IAP, CSRG proofs.\n\n"
  else
    section "Backend connected"
    printf "  Audit logs and signed tokens are flowing to ${C}staging-api.armoriq.ai${N}\n"
    printf "  View your runs at ${C}${B}%s${N}\n\n" "$DASHBOARD_URL"
  fi

  section "Manage anytime"
  cat <<EOF

  ${D}claude plugin list${N}
  ${D}claude plugin disable armorclaude${N}
  ${D}claude plugin enable  armorclaude${N}
  ${D}claude plugin update  armorclaude${N}

EOF

  printf "  Docs: ${C}https://github.com/armoriq/armorClaude${N}\n\n"
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
  api_key_step
  persist_api_key
  verify_install
  finale
}

main "$@"
