const CODES = {
  policy_denied: "policy_deny",
  policy_v2_block: "policy_deny",
  mcp_server_denied: "policy_deny",
  plan_check_denied: "policy_deny",
  protected_policy_file: "protected_resource",
  policy_admin_command: "protected_resource",
  intent_plan_missing: "missing_plan",
  intent_drift: "out_of_scope",
  intent_token_blocked: "out_of_scope",
  intent_token_expired: "token_expired",
  intent_planning_failed: "plan_request_failed",
  csrg_proof_invalid: "integrity",
  csrg_proof_rejected: "integrity",
  crypto_policy_mismatch: "integrity",
  remote_verify_denied: "integrity",
  policy_requires_approval: "approval_required",
  policy_v2_hold: "approval_required",
  mcp_server_unapproved: "approval_required",
  backend_unreachable: "outage",
  internal_error: "internal_error",
  invalid_payload: "internal_error",
  missing_tool_name: "internal_error",
  remote_verify_failed: "internal_error",
};

export const decisionCode = (producer) =>
  Object.hasOwn(CODES, producer) ? CODES[producer] : "other";
