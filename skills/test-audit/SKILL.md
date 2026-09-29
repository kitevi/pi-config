---
name: test-audit
description: Audit tests for low-value, implementation-coupled, or duplicative coverage. Use when reviewing, sweeping, or pruning tests, or when asked which tests to cut. Produces a report only; does not edit code.
---

# Test audit

The audit is read-only: it reviews existing tests and reports candidates
with evidence. Never edit, delete, or move tests while applying this skill;
report them instead. One value bar governs every verdict; optimize for
confidence, not deletion count.

## Value bar

A contract is the promise a unit makes to its consumers: its API, format, or
invariant. A boundary is the interface production callers actually use; the
owning boundary of a behavior is the module that owns it. A test justifies its
maintenance cost when it protects observable behavior, catches a credible
regression (a realistic future defect), or independently enforces a contract.
A test that must change under behavior-preserving refactoring asserts
implementation, not behavior; treat it as suspect, not automatically
removable.

## Audit method

1. Read the repository's own agent and contributing instructions first, then the
   complete test, its production owner, entry points, callers, callee
   implementations, overlapping tests, and relevant history. When a test asserts
   behavior that a dependency provides, inspect that dependency's source or
   types directly.
   Judge a test by its assertions, not by its name.
2. Stay read-only. Prefer a few high-confidence candidates over a large
   speculative inventory. Look for:
   - coverage probes: tests that only execute code to raise a coverage number
     and whose only implicit assertion is that no exception is thrown;
   - self-comparisons and identity copiers: assertions that compare a value to
     itself or to a copy of itself, so they always pass;
   - copied inventories: tests that re-assert a duplicated fixture, manifest,
     or export list and pass only while both copies are updated in lockstep;
   - source greps: assertions that check source text, imports, or strings
     instead of exercising behavior, unless the text is itself the contract,
     such as a pinned version or a committed generated file;
   - boundary duplicates: tests that exercise private predicates or call shapes
     already proven at a real boundary;
   - contract duplicates: repeated invocations of the same shared contract
     through a different wrapper or provider;
   - seam preservers: tests whose only purpose is keeping a production seam -
     a test-only export, global, or wrapper - alive;
   - cannot-fail assertions: assertions that the production code can never
     reach or that hold regardless of the outcome, such as a rejection row the
     production owner never reaches or a negative that passes when only one of
     several items is missing;
   - test-only code paths: production code whose only callers are tests.
3. Cheap read-only checks are fine: read files, grep, or run one focused test.
   Do not run the full suite, do not kill or interfere with test processes
   owned by the user or another agent, and do not mutate source or tests to
   prove a point.

## Retention bar

Keep a test when it independently enforces a public API, SDK, protocol, config,
migration, storage, security, platform, default, or architecture contract.
Also keep:

- call-ordering tests when the order is observable behavior;
- regressions with a credible failure mode;
- source-inspection tests when the text is the contract and reading it is the
  cheapest independent guard.

Being static or slow is not a removal reason. A test that resembles
implementation may still enforce an independent contract; the report must
prove that it does not before recommending removal.

## Report

Give every candidate one verdict - retain, repair the assertion, consolidate
into a named absorbing test, or remove - and record all fields. If a field is
missing, mark the candidate uncertain instead of guessing:

- exact test name and location;
- the failure it can actually detect; for a retained test, name the production
  change that would make it fail, because an assertion that no plausible change
  can break cannot fail;
- non-test callers of any production seam it preserves;
- the stronger proof that remains at the owning boundary, or why none is
  needed;
- relevant history and why the test or seam exists;
- risk, and the focused validation command to run before anyone acts on the
  recommendation.

End the report with the low-value categories found, the retained borderline
cases and why they stay, and named follow-ups. State explicitly that nothing
was edited. For a broad sweep, structure the report along production owners,
not file prefixes, and recommend at most one coherent batch per owner; never
recommend replacement tests that restate the same implementation.
