---
name: wording-pass
description: Wording pass that makes Markdown unambiguous. Use when asked to improve, clarify, or review the wording or readability of a Markdown file or passage.
license: MIT
---

# Wording pass

Edit for unambiguous interpretation, not maximum brevity. Apply to the requested Markdown file or passage, including descriptive documentation and agent instructions.

## Preserve

- The document's language, purpose, headings, section order, links, and technical detail.
- Identifiers, literal values, code blocks, examples, dates, evidence, exceptions, and uncertainty. A suspected factual error gets flagged separately, never silently corrected.
- Requirement strength: `may`, `should`, and `must` are not interchangeable.
- The distance between historical behavior, current behavior, and proposed changes.
- Already-clear passages, which stay untouched. No length target applies.

## Wording rules

- Name the actor and action where the source establishes them. Take the active voice when it clarifies who does what, and keep the passive where the actor is unknown or irrelevant.
- Replace ambiguous pronouns and references with the intended subject, but only where the document itself makes that subject clear.
- Make existing conditions, sequence, exceptions, and causal relationships explicit, keeping distinctions such as `and` versus `or`, `before` versus `after`, and `only if` versus `if`.
- Use one consistent term per concept. Preserve distinct domain terms and exact API names rather than introducing shorthand or metaphors that require guessing.
- Prefer concrete verbs where the source supplies the action. Precision invented to replace vagueness is a different act, and it stays out of a wording pass.
- State the intended behavior directly where that preserves meaning. Keep a prohibition and its scope whole where it carries a real constraint, rather than weakening it into a preference.
- Split overloaded sentences locally where that clarifies the relationships inside them, and keep each qualification attached to the claim it qualifies.
- Remove filler and verbal repetition. Keep rationale, technical facts, warnings, and useful local context.

## Method

1. Read the requested document or passage completely, with enough surrounding context to resolve references. An unspecified target is a question, so ask for it.
2. A review request reports the issues and proposed replacements without editing. An improvement request, or a bare invocation with a file, applies the edits. Pasted text alone returns the revised text.
3. Resolve ambiguity from the supplied document rather than speculation. Leave an unresolved passage intact, flag it, and ask before editing anything whose meaning depends on the answer; carry on with the independent, unambiguous improvements.
4. Re-read each changed passage against `Preserve` and against its original. Facts, actors, conditions, negations, modality, chronology, and uncertainty all have to survive the edit, so revert anything that moves them.
5. Report the edited file and any unresolved ambiguities in a few lines. This is a wording pass, not a correctness audit, so claim no technical verification. If nothing needed changing, say so.

## Scope

Wording inside the requested scope, and nothing else. Splitting files, generating AGENTS.md, introducing templates, auditing the repository, running examples, and adding requirements are separate acts that each need their own request.
