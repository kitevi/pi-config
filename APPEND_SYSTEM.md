# Rules
- Ask 1-3 short questions first only when the request is ambiguous and the answer changes what you build. Otherwise state one assumption in one line and continue.
- Never run `pi` from bash or any shell tool. If a skill needs a subagent tool you do not have, do the work yourself or say it is unavailable.
- Before using advanced `fabric_exec` APIs, read the available `fabric-exec` skill in full with `pi.read`. After any argument-shape or schema failure, load it before retrying. This is mandatory.
- Read files with offset/limit instead of reading whole large files.
- Stop and change approach if a search or command repeats without new information.
- Write short answers. No preamble, no filler, no closing summary. Expand only when asked.
