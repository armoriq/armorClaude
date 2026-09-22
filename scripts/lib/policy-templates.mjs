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
  architect: {
    name: "Architect",
    description: "Explore wide, write inside workspace, never destroy",
    policy: policy(
      "architect",
      "Explore wide, write inside workspace, never destroy",
      { decision: "hold" },
      [
        statement("forbid-destructive-bash", "forbid", { type: "tool", eq: "Bash" }, [
          { field: "bash.program", op: "in", value: ["rm", "sudo", "chmod"] },
        ]),
        statement("forbid-force-push", "forbid", { type: "tool", eq: "Bash" }, [
          { field: "bash.raw", op: "matches", value: "git push.*--force" },
        ]),
        statement("hold-deploy", "require_approval", { type: "tool", eq: "Bash" }, [
          { field: "bash.raw", op: "matches", value: "deploy" },
        ]),
        statement("allow-read-tools", "permit", {
          type: "tool",
          in: ["Read", "Grep", "Glob", "WebSearch"],
        }),
        statement(
          "hold-write-outside-workspace",
          "require_approval",
          { type: "tool", in: ["Write", "Edit", "MultiEdit"] },
          [{ field: "file.path", op: "within_workspace", value: false }]
        ),
        statement(
          "allow-write-inside-workspace",
          "permit",
          { type: "tool", in: ["Write", "Edit", "MultiEdit"] },
          [{ field: "file.path", op: "within_workspace", value: true }]
        ),
      ]
    ),
  },
  "quality-guardian": {
    name: "Quality Guardian",
    description: "Read and test freely, gate CI and secrets, cautious default",
    policy: policy(
      "quality-guardian",
      "Read and test freely, gate CI and secrets, cautious default",
      { decision: "hold" },
      [
        statement("forbid-read-env", "forbid", { type: "tool", eq: "Read" }, [
          { field: "file.path", op: "matches", value: "\\.env" },
        ]),
        statement(
          "hold-write-github",
          "require_approval",
          { type: "tool", in: ["Write", "Edit", "MultiEdit"] },
          [{ field: "file.path", op: "matches", value: "\\.github" }]
        ),
        statement("allow-read-tools", "permit", {
          type: "tool",
          in: ["Read", "Grep", "Glob", "WebSearch"],
        }),
        statement("allow-test-runners", "permit", { type: "tool", eq: "Bash" }, [
          {
            field: "bash.program",
            op: "in",
            value: ["pytest", "npm", "jest", "eslint", "go", "cargo", "make"],
          },
        ]),
        statement(
          "allow-write-inside-workspace",
          "permit",
          { type: "tool", in: ["Write", "Edit", "MultiEdit"] },
          [{ field: "file.path", op: "within_workspace", value: true }]
        ),
      ]
    ),
  },
  "velocity-machine": {
    name: "Velocity Machine",
    description: "Fast and low friction, hard stops on destroy, exfil and publish",
    policy: policy(
      "velocity-machine",
      "Fast and low friction, hard stops on destroy, exfil and publish",
      { decision: "allow" },
      [
        statement("forbid-destructive-bash", "forbid", { type: "tool", eq: "Bash" }, [
          { field: "bash.program", op: "in", value: ["rm", "sudo", "chmod"] },
        ]),
        statement("forbid-force-push", "forbid", { type: "tool", eq: "Bash" }, [
          { field: "bash.raw", op: "matches", value: "git push.*--force" },
        ]),
        statement("forbid-publish", "forbid", { type: "tool", eq: "Bash" }, [
          { field: "bash.raw", op: "matches", value: "publish" },
        ]),
        statement("forbid-read-env", "forbid", { type: "tool", eq: "Read" }, [
          { field: "file.path", op: "matches", value: "\\.env" },
        ]),
        statement("allow-read-tools", "permit", {
          type: "tool",
          in: ["Read", "Grep", "Glob", "WebSearch"],
        }),
        statement(
          "allow-write-inside-workspace",
          "permit",
          { type: "tool", in: ["Write", "Edit", "MultiEdit"] },
          [{ field: "file.path", op: "within_workspace", value: true }]
        ),
        statement(
          "forbid-write-outside-workspace",
          "forbid",
          { type: "tool", in: ["Write", "Edit", "MultiEdit"] },
          [{ field: "file.path", op: "within_workspace", value: false }]
        ),
      ]
    ),
  },
  "night-owl": {
    name: "Night Owl",
    description: "Solo off-hours, confirm writes and bash, deny by default",
    policy: policy(
      "night-owl",
      "Solo off-hours, confirm writes and bash, deny by default",
      { decision: "deny" },
      [
        statement("forbid-destructive-bash", "forbid", { type: "tool", eq: "Bash" }, [
          { field: "bash.program", op: "in", value: ["rm", "sudo", "chmod"] },
        ]),
        statement("forbid-force-push", "forbid", { type: "tool", eq: "Bash" }, [
          { field: "bash.raw", op: "matches", value: "git push.*--force" },
        ]),
        statement("hold-all-bash", "require_approval", { type: "tool", eq: "Bash" }),
        statement("hold-all-writes", "require_approval", {
          type: "tool",
          in: ["Write", "Edit", "MultiEdit"],
        }),
        statement("allow-read-tools", "permit", {
          type: "tool",
          in: ["Read", "Grep", "Glob", "WebSearch"],
        }),
        statement("forbid-read-env", "forbid", { type: "tool", eq: "Read" }, [
          { field: "file.path", op: "matches", value: "\\.env" },
        ]),
      ]
    ),
  },
};

export function getTemplateNames() {
  return Object.keys(POLICY_TEMPLATES);
}

export function getTemplate(name) {
  return POLICY_TEMPLATES[name] || null;
}
