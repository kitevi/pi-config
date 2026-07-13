# Design It Twice

When the user wants to explore alternative interfaces for a chosen deepening candidate, use this contrasting-pass pattern. Based on "Design It Twice" (Ousterhout) — your first idea is unlikely to be the best.

Uses the vocabulary in [SKILL.md](SKILL.md) — **module**, **interface**, **seam**, **adapter**, **leverage**.

The dependency guide is intentionally not vendored. Before using this workflow, read `~/.pi/agent/git/github.com/mattpocock/skills/skills/engineering/codebase-design/DEEPENING.md`, expanding `~` to the user's home.

## Process

### 1. Frame the problem space

Before generating designs, write a user-facing explanation of the problem space for the chosen candidate:

- The constraints any new interface would need to satisfy
- The dependencies it would rely on, and which category they fall into according to the upstream dependency guide
- A rough illustrative code sketch to ground the constraints — not a proposal, just a way to make the constraints concrete

Show this to the user, then proceed to Step 2.

### 2. Generate contrasting designs

Produce at least three complete designs, one at a time, in separate passes. Start every pass from the same technical brief: file paths, coupling details, the dependency category from the upstream dependency guide, and what sits behind the seam.

Before each pass, restate only its constraint. Do not compare, merge, or revise the designs until every pass is complete:

- Pass 1: "Minimize the interface — aim for 1–3 entry points max. Maximise leverage per entry point."
- Pass 2: "Maximise flexibility — support many use cases and extension."
- Pass 3: "Optimise for the most common caller — make the default case trivial."
- Pass 4 (if applicable): "Design around ports & adapters for cross-seam dependencies."

Use both [SKILL.md](SKILL.md) vocabulary and `CONTEXT.md` vocabulary in every pass so each design uses the architecture language and the project's domain language consistently.

Each pass outputs:

1. Interface (types, methods, params — plus invariants, ordering, error modes)
2. Usage example showing how callers use it
3. What the implementation hides behind the seam
4. Dependency strategy and adapters, using the upstream dependency guide
5. Trade-offs — where leverage is high, where it's thin

### 3. Present and compare

Present designs sequentially so the user can absorb each one, then compare them in prose. Contrast by **depth** (leverage at the interface), **locality** (where change concentrates), and **seam placement**.

After comparing, give your own recommendation: which design you think is strongest and why. If elements from different designs would combine well, propose a hybrid. Be opinionated — the user wants a strong read, not a menu.
