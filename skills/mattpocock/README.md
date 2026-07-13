# Vendored Matt Pocock skills

These skills are local adaptations of [`mattpocock/skills`](https://github.com/mattpocock/skills). They retain their upstream skill names so skills that invoke `/code-review`, `/codebase-design`, or `/improve-codebase-architecture` continue to work unchanged.

The locally copied skill files started from commit [`66898f60e8c744e269f8ce06c2b2b99ce7660d5f`](https://github.com/mattpocock/skills/commit/66898f60e8c744e269f8ce06c2b2b99ce7660d5f) under the included MIT license.

## Upstream links

| Local skill | Current upstream original | Upstream history | Vendored baseline |
| --- | --- | --- | --- |
| [`code-review`](./code-review/SKILL.md) | [Original](https://github.com/mattpocock/skills/tree/main/skills/engineering/code-review) | [History](https://github.com/mattpocock/skills/commits/main/skills/engineering/code-review/SKILL.md) | [Baseline](https://github.com/mattpocock/skills/tree/66898f60e8c744e269f8ce06c2b2b99ce7660d5f/skills/engineering/code-review) |
| [`codebase-design`](./codebase-design/SKILL.md) | [Original](https://github.com/mattpocock/skills/tree/main/skills/engineering/codebase-design) | [History](https://github.com/mattpocock/skills/commits/main/skills/engineering/codebase-design/SKILL.md) | [Baseline](https://github.com/mattpocock/skills/tree/66898f60e8c744e269f8ce06c2b2b99ce7660d5f/skills/engineering/codebase-design) |
| [`improve-codebase-architecture`](./improve-codebase-architecture/SKILL.md) | [Original](https://github.com/mattpocock/skills/tree/main/skills/engineering/improve-codebase-architecture) | [History](https://github.com/mattpocock/skills/commits/main/skills/engineering/improve-codebase-architecture/SKILL.md) | [Baseline](https://github.com/mattpocock/skills/tree/66898f60e8c744e269f8ce06c2b2b99ce7660d5f/skills/engineering/improve-codebase-architecture) |

[Compare all upstream repository changes since the vendored baseline.](https://github.com/mattpocock/skills/compare/66898f60e8c744e269f8ce06c2b2b99ce7660d5f...main)

## Live upstream cache dependencies

The unchanged companion documents below are intentionally not vendored. The local skills read Pi's installed Matt Pocock package so these documents follow upstream package updates.

| Document | Package-cache path | Current upstream | Upstream history |
| --- | --- | --- | --- |
| `DEEPENING.md` | `~/.pi/agent/git/github.com/mattpocock/skills/skills/engineering/codebase-design/DEEPENING.md` | [Original](https://github.com/mattpocock/skills/blob/main/skills/engineering/codebase-design/DEEPENING.md) | [History](https://github.com/mattpocock/skills/commits/main/skills/engineering/codebase-design/DEEPENING.md) |
| `HTML-REPORT.md` | `~/.pi/agent/git/github.com/mattpocock/skills/skills/engineering/improve-codebase-architecture/HTML-REPORT.md` | [Original](https://github.com/mattpocock/skills/blob/main/skills/engineering/improve-codebase-architecture/HTML-REPORT.md) | [History](https://github.com/mattpocock/skills/commits/main/skills/engineering/improve-codebase-architecture/HTML-REPORT.md) |

This relies on the Matt Pocock package remaining in `settings.json`; the other imported skills already keep that package installed.

## Local changes

- Replaced unavailable delegated parallel workflows with explicit sequential passes in the current context.
- Replaced delegated codebase exploration with direct, bounded exploration using the available repository tools.
- Removed `code-review`'s dependency on the unimported `/setup-matt-pocock-skills` skill.
- Left unchanged companion documents in Pi's package cache so they follow upstream updates.
