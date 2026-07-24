---
name: shipyard-security-review
description: Review code changes for concrete authentication, authorization, injection, secret, privacy, trust-boundary, and unsafe-default failures. Use when changes touch identity, input boundaries, commands, network/data exposure, credentials, or privileged operations.
---

# Shipyard security review

Build a small threat model for the changed path: attacker/control source, trusted boundary, sensitive asset, privileged action, and observable consequence.

Inspect:

- authentication state and identity binding;
- authorization at the operation boundary, not only in UI/routing code;
- tenant/user/resource ownership checks;
- command, query, path, template, URL, and header injection;
- unsafe parsing, deserialization, and content-type assumptions;
- secrets in source, logs, errors, artifacts, or client responses;
- privacy exposure through telemetry, caching, exports, and debugging;
- SSRF, open redirects, path traversal, symlink escape, and archive extraction;
- replay, CSRF, nonce/state validation, and idempotency where relevant;
- unsafe defaults, fail-open behavior, and overly broad fallback access;
- dependency or configuration changes that widen execution authority.

Do not report a generic security concern without a realistic attacker-controlled input path and an impact. Verify upstream sanitization and framework guarantees before claiming a missing check.

For every security finding, include the trust boundary crossed, attacker prerequisite, affected asset, and smallest fix at the correct boundary.
