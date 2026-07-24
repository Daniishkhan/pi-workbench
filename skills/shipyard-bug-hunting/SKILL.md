---
name: shipyard-bug-hunting
description: Find concrete software bugs by tracing contracts, state transitions, error paths, integrations, and adversarial counterexamples. Use for correctness, runtime, integration, and blind-spot review rather than style cleanup.
---

# Shipyard bug hunting

Optimize for defects that change behavior, lose information, violate an invariant, or make validation lie. Do not spend a primary bug-review slot on cosmetic cleanup.

## Start from contracts

Identify the load-bearing contract before judging code:

- user request and acceptance behavior;
- public API, CLI, persistence, protocol, or file-format contract;
- repository rules and architecture boundaries;
- caller expectations and existing tests;
- error, cleanup, retry, cancellation, and durability semantics.

If the contract is ambiguous, report the ambiguity as a coverage gap rather than inventing a requirement.

## Trace behavior end to end

For changed paths, follow:

1. entry point and input boundary;
2. validation and normalization;
3. state mutations and persistence;
4. downstream calls and return values;
5. error propagation, retry, cancellation, and cleanup;
6. caller handling and user-visible result.

Inspect adjacent unchanged callers and tests when the change can invalidate their assumptions.

## Construct counterexamples

Probe boundaries instead of only reading the happy path:

- empty, missing, duplicate, stale, malformed, and oversized inputs;
- partial success and mid-operation failure;
- retries, repeated execution, idempotency, and reentrancy;
- ordering, concurrency, cancellation, and timeout behavior;
- compatibility with prior data/config/API versions;
- permission, authentication, and ownership boundaries;
- cleanup after exceptions and early returns.

Run a focused test or reproduction when safe and practical. A passing broad suite does not prove the changed branch executed.

## Search for sibling defects

When one bug class is found:

- search for the same helper, pattern, or invariant elsewhere;
- inspect parallel branches and alternative entry points;
- determine whether the proposed fix belongs at a shared boundary;
- record separate findings only when the triggers or fixes are materially distinct.

## Avoid false positives

Before recording a finding, search for:

- validation earlier in the call chain;
- framework/runtime guarantees;
- tests proving the allegedly missing behavior;
- deliberate compatibility constraints;
- repository instructions that explain the choice.

Prefer one verified finding over five plausible-sounding concerns.
