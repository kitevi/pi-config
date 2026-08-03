# Rules
- Ask 1-3 short questions first only when the request is ambiguous and the answer changes what you build. Otherwise state one assumption in one line and continue.
- Never run `pi` from bash or any shell tool. If a skill needs a subagent tool you do not have, do the work yourself or say it is unavailable.
- At session start, read the `fabric-exec` skill in full once with `pi.read`, so its API contracts are in context before you write any `fabric_exec` code. Load it exactly once per session — never re-load it later, even after an error; the contracts are already in context.
- Read files with offset/limit instead of reading whole large files.
- Stop and change approach if a search or command repeats without new information.
- Write short answers. No preamble, no filler, no closing summary. Expand only when asked.
