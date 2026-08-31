# GitHub Colorblind Theme Sources

These light and dark variants adapt GitHub's Primer colorblind themes for Pi's TUI tokens. GitHub calls these the protanopia/deuteranopia variants; success and additions use blue while errors and removals use orange.

## Pinned sources

- Primer Primitives: [`@primer/primitives` 11.9.0](https://www.npmjs.com/package/@primer/primitives/v/11.9.0), git commit [`875bb3a2b45715287322d608ae371d60a69c7b2b`](https://github.com/primer/primitives/commit/875bb3a2b45715287322d608ae371d60a69c7b2b)
  - [Light colorblind CSS](https://unpkg.com/@primer/primitives@11.9.0/dist/css/functional/themes/light-colorblind.css)
  - [Dark colorblind CSS](https://unpkg.com/@primer/primitives@11.9.0/dist/css/functional/themes/dark-colorblind.css)
- Pi theme contract: [`@earendil-works/pi-coding-agent` 0.74.0](https://www.npmjs.com/package/@earendil-works/pi-coding-agent/v/0.74.0), git commit [`1eee081e29c1323c40b98db11d0a62b919831881`](https://github.com/earendil-works/pi/commit/1eee081e29c1323c40b98db11d0a62b919831881)
  - [Immutable theme schema](https://raw.githubusercontent.com/earendil-works/pi/1eee081e29c1323c40b98db11d0a62b919831881/packages/coding-agent/src/modes/interactive/theme/theme-schema.json)

The Pi version above matches the version pinned in `package-lock.json`. Update the schema URI and this provenance record deliberately when upgrading that dependency.

## Mapping policy

Primer functional roles are mapped to the nearest Pi role. Theme variables therefore use semantic names such as `fgMuted`, `successFg`, and `syntaxConstant`; they do not claim to be Primer base-scale positions.

Pi only accepts documented six-digit RGB values, while several Primer functional backgrounds and borders use alpha. Those colors are pre-blended over the corresponding Primer page background:

| Role | Primer value | Base | Pi RGB |
| --- | --- | --- | --- |
| Light muted border | `#d1d9e0b3` | `#ffffff` | `#dfe4e9` |
| Dark muted border | `#3d444db3` | `#0d1117` | `#2f353d` |
| Dark muted accent background | `#388bfd1a` | `#0d1117` | `#111d2e` |
| Dark muted success background | `#388bfd33` | `#0d1117` | `#162945` |
| Dark muted danger background | `#db6d281a` | `#0d1117` | `#221a19` |

Pi-specific adaptations without a direct Primer equivalent are intentional:

- Diff lines are foreground-only in Pi, so they use Primer success and danger foreground colors.
- Markdown link URLs and punctuation use muted foreground colors.
- Thinking borders use a monotonic blue contrast scale from subtle to prominent.
- `thinkingMax` is explicit instead of relying on Pi's fallback to `thinkingXhigh`.
- The fullscreen scrollbar thumb uses the dim foreground gray; Primer defines no scrollbar token, and Pi's default fallback to `selectedBg` is too subtle against the page background.

`tests/github-colorblind-theme.test.ts` locks the resolved token mapping, schema provenance, thinking hierarchy, and tool-text contrast.
