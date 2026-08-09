# Pi IDE Selection

Minimal VS Code companion for Pi's `/ide` command. It registers a system-wide
URI handler (`vscode://ppowo.pi-ide-selection/capture`) that answers on demand
with the active file path, dirty flag, and primary selection range.

**No selected source text ever crosses the bridge.** The response contains only
the file path and selection coordinates; Pi's model reads the saved file itself.

## Usage

1. From Pi, run `/ide-install` to package this vendored source with
   `@vscode/vsce` and install it with the `code` CLI. Reload the VS Code window
   if required.
2. In VS Code, open a saved regular file and select some text.
3. In Pi, run `/ide`. Pi inserts a reference such as:

   ```text
   Read `src/auth/session.ts`, lines 10–15 (selection 10:1–16:1).
   ```

## Protocol

- The URI carries only a UUID request id: `vscode://ppowo.pi-ide-selection/capture?id=<uuid>`.
- The response is written atomically to `~/.pi/ide-capture/<uuid>.json`
  (temporary `<uuid>.<pid>.tmp`, then rename), with directory mode `0700` and
  file mode `0600` on POSIX.
- Success responses contain `filePath`, `dirty`, and zero-based,
  end-exclusive `start`/`end` positions. Failure responses contain an `error`
  message. No selected text is included in either.
- The extension does nothing until a capture URI arrives: no selection
  listeners, timers, or persistent state.

## Scope

Native desktop VS Code on macOS, Linux, and Windows. Untitled or virtual
documents, notebook cells, and multiple selections are not supported; an empty
selection is an error. If the document is dirty, Pi warns that the model will
read the saved file.

## Development

No build step. The extension is plain CommonJS JavaScript loaded via
`main: ./extension.js` with `activationEvents: ["onUri"]` and no runtime
dependencies.

```bash
npx --yes @vscode/vsce package --no-dependencies
```

## License

MIT
