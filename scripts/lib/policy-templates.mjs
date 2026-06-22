function statement(id, effect, action, conditions = []) {
  return {
    id,
    effect,
    principal: { type: "agent", id: "claude-code" },
    action,
    resource: { type: "workspace", scope: "current" },
    conditions,
  };
}

function policy(name, description, defaults, statements) {
  return {
    schemaVersion: "armor.policy.v1",
    kind: "PolicyProfile",
    metadata: { name, description },
    defaults: { decision: defaults.decision, conflictResolution: "deny_overrides" },
    statements,
  };
}

export const POLICY_TEMPLATES = {
  "all-allow": {
    name: "All Allow",
    description: "Everything permitted — intent planning still enforced",
    policy: policy(
      "all-allow",
      "Everything permitted — intent planning still enforced",
      { decision: "allow" },
      [statement("allow-all", "permit", { type: "tool", eq: "*" })]
    ),
  },
  "strict-read-only": {
    name: "Strict Read-Only",
    description: "Only Read/Grep/Glob allowed. Bash/Write/Edit denied.",
    policy: policy(
      "strict-read-only",
      "Only Read/Grep/Glob allowed. Bash/Write/Edit denied.",
      { decision: "deny" },
      [statement("allow-read-tools", "permit", { type: "tool", in: ["Read", "Grep", "Glob"] })]
    ),
  },
  balanced: {
    name: "Balanced",
    description: "Read allowed. Bash/Write/Edit require approval.",
    policy: policy(
      "balanced",
      "Read allowed. Bash/Write/Edit require approval.",
      { decision: "allow" },
      [
        statement("allow-read-tools", "permit", { type: "tool", in: ["Read", "Grep", "Glob"] }),
        statement("hold-bash-write-edit", "require_approval", {
          type: "tool",
          in: ["Bash", "Write", "Edit", "MultiEdit"],
        }),
      ]
    ),
  },
  lockdown: {
    name: "Lockdown",
    description: "All tools require approval. Nothing auto-allowed.",
    policy: policy(
      "lockdown",
      "All tools require approval. Nothing auto-allowed.",
      { decision: "deny" },
      [statement("hold-all", "require_approval", { type: "tool", eq: "*" })]
    ),
  },
};

export function getTemplateNames() {
  return Object.keys(POLICY_TEMPLATES);
}

export function getTemplate(name) {
  return POLICY_TEMPLATES[name] || null;
}
