import test from "node:test";
import assert from "node:assert/strict";
import { credentialFor } from "../scripts/lib/credentials-profile.mjs";

const PROD = "https://api.armoriq.ai";
const STAGING = "https://staging-api.armoriq.ai";

const v2 = {
  version: 2,
  active: "armorantigravity@staging-api.armoriq.ai",
  profiles: {
    "armorclaude@api.armoriq.ai": {
      backend: PROD,
      product: "armorclaude",
      apiKey: "ak_live_claude_prod",
      orgId: "org-prod",
    },
    "armorclaude@staging-api.armoriq.ai": {
      backend: STAGING,
      product: "armorclaude",
      apiKey: "ak_live_claude_staging",
      orgId: "org-staging",
    },
    "armorcodex@api.armoriq.ai": {
      backend: PROD,
      product: "armorcodex",
      apiKey: "ak_live_codex_prod",
      orgId: "org-codex",
    },
  },
};

test("v2: takes this product's key for this backend", () => {
  assert.deepEqual(credentialFor(v2, { backend: PROD, product: "armorclaude" }), {
    apiKey: "ak_live_claude_prod",
    orgId: "org-prod",
  });
});

test("v2: another product's key is never used", () => {
  assert.deepEqual(credentialFor(v2, { backend: PROD, product: "armoropencode" }), {
    apiKey: "",
    orgId: "",
  });
});

test("v2: a staging key is never sent to production", () => {
  assert.equal(
    credentialFor(v2, { backend: STAGING, product: "armorclaude" }).apiKey,
    "ak_live_claude_staging"
  );
});

test("v2: the active profile does not override the asked-for product", () => {
  // `active` names an armorantigravity staging profile, which must not win.
  assert.equal(
    credentialFor(v2, { backend: PROD, product: "armorclaude" }).apiKey,
    "ak_live_claude_prod"
  );
});

test("v2: a trailing slash on the backend still matches", () => {
  assert.equal(
    credentialFor(v2, { backend: `${PROD}/`, product: "armorclaude" }).apiKey,
    "ak_live_claude_prod"
  );
});

test("v1: the old single-key file still works", () => {
  assert.deepEqual(
    credentialFor(
      { apiKey: "ak_live_old", orgId: "org-old" },
      { backend: PROD, product: "armorclaude" }
    ),
    { apiKey: "ak_live_old", orgId: "org-old" }
  );
});

test("v2 with no profiles, or junk, yields no key rather than throwing", () => {
  for (const input of [{ version: 2 }, { version: 2, profiles: null }, null, "nonsense", {}]) {
    assert.deepEqual(credentialFor(input, { backend: PROD, product: "armorclaude" }), {
      apiKey: "",
      orgId: "",
    });
  }
});
