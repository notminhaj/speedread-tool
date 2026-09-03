---
description: Configure and control the speedread RSVP companion — set reading speed (WPM), open the companion pane, toggle autoplay, or check status
disable-model-invocation: true
allowed-tools: Bash, PowerShell, Read, Write, Edit
---

# /speedread — control the RSVP speed-reading companion

The speedread CLI lives at the plugin root: `$CLAUDE_PLUGIN_ROOT/speedread.mjs` (PowerShell: `$env:CLAUDE_PLUGIN_ROOT\speedread.mjs`). If `CLAUDE_PLUGIN_ROOT` is not set (running from a repo checkout), it is `speedread.mjs` in this repository's root. Verify the file exists before launching anything; if missing, tell the user the plugin isn't installed correctly.

Its config file is `~/.speedread.json`. The schema is exactly:

```json
{ "wpm": 300, "step": 25, "autoplay": false }
```

- `wpm`: reading speed, 60–1500 (default 300)
- `step`: how much each speed-up/slow-down keypress changes wpm, 5–200 (default 25)
- `autoplay`: when true the companion plays each new response immediately instead of waiting for `p` (default false)

Do not invent other fields. The running companion live-reloads this file within ~1 second, so config edits take effect immediately — no restart needed.

Handle `$ARGUMENTS` as follows:

**A number (e.g. `/speedread 400`)**: set `wpm` in `~/.speedread.json` (create the file if missing, merge with existing fields — never drop fields the user has set). Clamp to 60–1500. Confirm in one line, e.g. "Reading speed set to 400 wpm — the companion picks it up live."

**`step <n>`**: set `step` the same way.

**`auto on` / `auto off`**: set `autoplay` true/false the same way.

**`on` or `open`**: launch the companion pane running `node <plugin-root>/speedread.mjs --follow --session <id>` **in the project directory the user is working in**.

First resolve `<id>`: the transcript folder is `~/.claude/projects/<munged>/` where `<munged>` is the current working directory with every character that is not a letter or digit replaced by `-` (PowerShell: `($pwd.Path -replace '[^A-Za-z0-9]', '-')`). Take the basename (without `.jsonl`) of the **most recently modified** `.jsonl` file there — that is the current session, because invoking this very command just wrote to it. Pass it as `--session <id>` so the companion stays pinned to this conversation.

On Windows, launch via the **PowerShell tool, never the Bash tool** — Git Bash mangles Windows-style `/x` switches (MSYS path conversion), which breaks these commands. Try in order:
1. `wt -w 0 sp -d "<cwd>" node "<plugin-root>\speedread.mjs" --follow --session <id>` (splits the current Windows Terminal window; run node directly — no `cmd /k` wrapper)
2. If `wt` is unavailable: `Start-Process node -ArgumentList '"<plugin-root>\speedread.mjs"','--follow','--session','<id>' -WorkingDirectory "<cwd>"` (new window)
3. If both fail: print the exact command for the user to run in a second terminal themselves.

On macOS/Linux: if `$TMUX` is set use `tmux split-window -h -c "<cwd>" node "<plugin-root>/speedread.mjs" --follow --session <id>`; otherwise print the command for the user to run in a second terminal.

After launching, confirm in one line and remind the keys: Ctrl+P play, Ctrl+O pause, Ctrl+I slower, ←/→ jump a response back/forward — pressed **in the companion pane** (keys only apply when that pane is focused; typing in Claude Code is unaffected). Worth saying once: the pane loads the whole session, so responses from earlier in the conversation are reachable with ←, not just the latest one.

**`off`**: tell the user to press `q` in the companion pane (there is no remote kill by design).

**No arguments or `status`**: read `~/.speedread.json` (report defaults if missing) and print a short status: current wpm/step/autoplay, how to open the companion (`/speedread on`), and the keys, pressed in the companion pane: **Ctrl+P** play from the green marker / speed up while playing, **Ctrl+O** pause (marker lands there), **Ctrl+I** slow down, **←/→** jump back/forward a whole response, **↑/↓** by sentence, `q` quit. Plain `p`/`o`/`i` also work there (the pane has no text input), which matters in terminals that swallow Ctrl combos (VS Code takes Ctrl+P for Quick Open).

**`demo`**: print the command `node <plugin-root>/speedread.mjs --demo` for the user to run in a regular terminal (it's interactive, so it cannot run through the shell tool).

Keep responses to one or two lines — this is a settings command, not an essay.
