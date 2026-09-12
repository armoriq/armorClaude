# Security Policy

## Supported Versions

Only the latest released version receives security fixes. Whenever a critical issue is
resolved we publish a patched build under a new `vX.Y.Z` tag. Users should upgrade to the most
recent release before deploying to production environments.

| Version | Supported |
|---------|-----------|
| latest  | ✅        |
| older   | ❌        |

## Reporting a Vulnerability

We take the protection of customer environments seriously. If you discover a security issue:

1. **Do not** open a public GitHub issue.
2. Email `security@armoriq.io` with the following details:
   - A clear description of the vulnerability and impact.
   - Steps to reproduce, including payloads if applicable.
   - Any supporting logs, screenshots, or proof-of-concept code.
3. Optionally encrypt the report with our PGP key (fingerprint available upon request).

We aim to acknowledge new reports within **2 business days** and to provide a status update within
**7 business days**. Where remediation requires code changes, you will receive a disclosure
timeline and release plan. We request a **30-day** embargo before public disclosure so fixes can be
verified and deployed.

## Scope and Expectations

- Vulnerabilities must be demonstrated against the latest release.
- Findings limited to debug configurations or non-default settings may be deprioritized unless they
  pose high risk.
- We appreciate defensive proof-of-concepts; please avoid destructive testing in shared
  infrastructure.

Thank you for helping keep ArmorIQ secure.
