# Users Clean Up Legacy Pi Paths

`bootstrap.mjs` reconciles only paths represented by the current repository. It does not carry migrations or deletion rules for paths left behind by removed packages, renamed configuration, or earlier bootstrap versions.

Legacy cleanup is the user's responsibility. For large configuration changes, the user deletes `~/.pi` before rerunning setup and reloading Pi. Stale files may otherwise remain by design; this keeps bootstrap declarative and avoids accumulating one-off cleanup code that could delete user-managed state.
