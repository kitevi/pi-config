---
name: agent-wording
description: Wording pass that makes Markdown unambiguous for agent readers. Use when asked to improve, clarify, or review wording, phrasing, or readability of a Markdown file or passage.
---

# Agent wording

Edit for unambiguous interpretation, not maximum brevity. Apply to the requested Markdown file or passage, including descriptive documentation and agent instructions.

## Scope

- Preserve the original language, document purpose, headings, section order, links, and technical detail.
- Preserve identifiers, literal values, code blocks, examples, dates, evidence, exceptions, and uncertainty. Flag suspected factual errors separately rather than silently correcting them.
- Keep descriptions descriptive and instructions instructive. Preserve requirement strength: `may`, `should`, and `must` are not interchangeable. Keep historical behavior distinct from current behavior and proposed changes.
- Work only on wording in the requested scope. Do not split files, generate AGENTS.md, introduce templates, audit the repository, execute examples, or add new requirements. Broader work requires an explicit request.

## Wording rules

- Name the actor and action when the source establishes them. Prefer active voice when it clarifies who does what; retain passive voice when the actor is unknown or irrelevant.
- Replace ambiguous pronouns and references with the intended subject only when the document makes that subject clear.
- Make existing conditions, sequence, exceptions, and causal relationships explicit. Preserve distinctions such as `and` versus `or`, `before` versus `after`, and `only if` versus `if`.
- Use one consistent term for each concept. Preserve distinct domain terms and exact API names; avoid introducing shorthand or metaphors that require guessing.
- Prefer concrete verbs over vague wording when the source supplies the action. Do not invent acceptance criteria to make a vague instruction sound precise.
- State the intended behavior directly where this preserves meaning. Keep explicit prohibitions and their scope when they carry a real constraint; do not weaken them into preferences.
- Split overloaded sentences locally when doing so clarifies relationships. Keep qualifications attached to the claims they qualify.
- Remove filler and verbal repetition, not rationale, technical facts, warnings, or useful local context. Leave already-clear passages unchanged; no length target applies.

## Method

1. Read the requested document or passage completely, including enough surrounding context to resolve references. If the target is unspecified, ask for it.
2. For a review request, report wording issues and proposed replacements without editing. For an improvement request or a bare invocation with a file, apply wording edits. If only pasted text is supplied, return the revised text.
3. Resolve ambiguity from the supplied document, not speculation. Leave unresolved wording intact and flag the ambiguity; ask before editing any passage whose meaning depends on the answer. Continue with independent, unambiguous improvements.
4. Compare each changed passage with its original. Confirm that facts, actors, conditions, negations, modality, chronology, and uncertainty are preserved. Revert changes that alter meaning or exceed the wording scope.
5. Briefly report the edited file and any unresolved ambiguities. Do not claim technical verification: this is a wording pass, not a correctness audit. If no changes are warranted, say so.

## Examples

These replacements rely only on information present in each original.

**Clarify a description without turning it into a command**

Before: “The booking is placed in the session map by the manager and is not yet persisted.”

After: “The manager places the booking in the session map. At this stage, the booking is not persisted.”

**Expose a condition without strengthening it**

Before: “If coordinates are absent, the importer may use the city fallback, which can still fail.”

After: “When coordinates are absent, the importer may use the city fallback. The fallback can still fail.”

**Keep an instruction and its prohibition**

Before: “Grouping must be done using reference, not technicalReference, because the latter differs per leg.”

After: “Group by `reference`, not `technicalReference`: `technicalReference` differs per leg.”

**Flag missing meaning instead of inventing it**

Original: “After processing, mark it complete.”

If the document does not identify “it” or define “processing,” leave the sentence unchanged and ask which entity is marked complete and what event permits that transition.
