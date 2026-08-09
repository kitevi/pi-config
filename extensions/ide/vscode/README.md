# Pi IDE Selection

A minimal companion for the Pi coding agent's `/ide` command. It stays dormant
until VS Code routes a `vscode://ppowo.pi-ide-selection/capture?id=<uuid>` URI
to the topmost window, then responds with only the active file path, the dirty
flag, and the primary selection range — never the selected text.

Pi reads the response from `~/.pi/ide-capture/` and removes it afterwards.

- Native desktop VS Code on macOS, Linux, and Windows only.
- No settings, commands, or keybindings are contributed.
- Install it from Pi with `/ide-install`, which packages this source into a
  temporary VSIX on demand. The old `xl0.pi-lovely-ide` extension can be
  uninstalled manually; it is not removed automatically.
