export const POLICY_TEMPLATES = {
  "all-allow": {
    name: "All Allow",
    description: "Everything permitted — intent planning still enforced",
    rules: [
      { id: "allow-all", action: "allow", tool: "*" }
    ]
  },
  "strict-read-only": {
    name: "Strict Read-Only",
    description: "Only Read/Grep/Glob allowed. Bash/Write/Edit denied.",
    rules: [
      { id: "allow-read", action: "allow", tool: "Read" },
      { id: "allow-grep", action: "allow", tool: "Grep" },
      { id: "allow-glob", action: "allow", tool: "Glob" },
      { id: "deny-all", action: "deny", tool: "*" }
    ]
  },
  "balanced": {
    name: "Balanced",
    description: "Read allowed. Bash/Write/Edit require approval.",
    rules: [
      { id: "allow-read", action: "allow", tool: "Read" },
      { id: "allow-grep", action: "allow", tool: "Grep" },
      { id: "allow-glob", action: "allow", tool: "Glob" },
      { id: "hold-bash", action: "require_approval", tool: "Bash" },
      { id: "hold-write", action: "require_approval", tool: "Write" },
      { id: "hold-edit", action: "require_approval", tool: "Edit" },
      { id: "allow-rest", action: "allow", tool: "*" }
    ]
  },
  "lockdown": {
    name: "Lockdown",
    description: "All tools require approval. Nothing auto-allowed.",
    rules: [
      { id: "hold-all", action: "require_approval", tool: "*" }
    ]
  }
};

export function getTemplateNames() {
  return Object.keys(POLICY_TEMPLATES);
}

export function getTemplate(name) {
  return POLICY_TEMPLATES[name] || null;
}
