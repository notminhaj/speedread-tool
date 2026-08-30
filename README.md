# speedread — RSVP speed reading for Claude Code

Read Claude's responses at 300–1000+ words per minute. A companion pane flashes each finished response **one word at a time** (RSVP — Rapid Serial Visual Presentation), with the optimal-recognition-point letter highlighted in red and pinned to a fixed pivot so your eyes never move. A **green marker `▶`** appears at the start of every finished response; press `Ctrl+P` to speed-read from it, `Ctrl+O` to pause (the marker lands wherever you stopped), `Ctrl+P` again to resume or go faster.

Zero dependencies — needs only [Node.js](https://nodejs.org).

## Quick start

```bash
# try the demo in any terminal
node speedread.mjs --demo

# the Claude Code companion: run this in a SECOND terminal/pane,
# in the same folder where you're running Claude Code
node speedread.mjs --follow
```

When Claude finishes a response, the companion shows `▶ response ready — press Ctrl+P`. Regular output stays regular; speed reading is opt-in per response, exactly one keypress away.

## Keys

Keys are pressed **in the companion pane** (they only apply when it's focused — typing in Claude Code is never affected):

| Key | Action |
|---|---|
| `Ctrl+P` | play from the green marker; **while playing: speed up** (+25 wpm) |
| `Ctrl+O` | pause — the green marker lands where you stopped |
| `Ctrl+I` | slow down (−25 wpm) |
| `←` / `→` | move by sentence (moves the marker while paused) |
| `r` | restart from the top |
| `q` / `Esc` | quit |

Plain `p`, `o`, and `i` work as aliases — the pane has no text input, so single letters are free there. That's the fallback for terminals that swallow Ctrl combos (VS Code's integrated terminal takes `Ctrl+P` for Quick Open). `Ctrl+I` is byte-identical to `Tab` in every terminal — a terminal fact, not a choice — so `Tab` also slows down.

## Install as a Claude Code plugin

From a local checkout (for trying it out):

```bash
claude --plugin-dir path/to/fast-reading-tool
```

Once published to GitHub:

```bash
claude plugin marketplace add notminhaj/speedread-cli
# then inside Claude Code:
/plugin install speedread@speedread-marketplace
```

The plugin adds a command inside Claude Code — plugin commands are namespaced, so its full name is `/speedread:speedread`, but just type `/speedread` and autocomplete resolves it:

| Command | Effect |
|---|---|
| `/speedread:speedread` | show current settings and keys |
| `/speedread:speedread 400` | set reading speed to 400 wpm — **the running companion picks it up live** |
| `/speedread:speedread step 50` | change how much each speed keypress adjusts |
| `/speedread:speedread auto on` | autoplay each new response (default off: press `p` yourself) |
| `/speedread:speedread on` | open the companion pane (splits Windows Terminal, or tells you the command) |
| `/speedread:speedread off` | how to close it (press `q` in the pane) |

Settings live in `~/.speedread.json`:

```json
{ "wpm": 300, "step": 25, "autoplay": false }
```

The companion re-reads this file every second, so changes apply without restarting.

## Other input sources

It's also a general-purpose RSVP reader:

```bash
node speedread.mjs notes.txt --wpm 450   # a file
git log | node speedread.mjs             # any piped output
node speedread.mjs --clip                # the clipboard
node speedread.mjs --claude              # one-shot: Claude's last response
```

On Windows, `speedread.cmd` lets you run `.\speedread` (add the folder to PATH to use it anywhere).

## How the companion finds Claude's responses

Claude Code writes session transcripts to `~/.claude/projects/<project>/`. The companion polls a transcript for the current working directory (~every 0.6s), extracts the text of the latest finished turn, strips markdown, and replaces code blocks with `[code block]` (code isn't meant to be read one word at a time). Words appear only after the text has been stable for two polls, so it never starts mid-sentence while Claude is still writing. Multi-step turns continue from where the previous block ended instead of replaying.

Which transcript: `--session <id>` pins the companion to one session's file (`/speedread on` passes this automatically, so it stays glued to the conversation that opened it). Without a pin, it latches onto the newest transcript at startup and only ever switches to a session *created afterwards* — it never jumps between two already-running sessions.

Why a companion pane instead of keys inside Claude Code itself: Claude Code's keybindings can only map keys to its built-in actions — plugins can't add new interactive UI or key handlers, `Ctrl+O` is already its transcript toggle, and `Ctrl+I` is indistinguishable from `Tab` at the byte level. The companion pane gets you the exact interaction model with zero conflicts.

## Known limitations (v1)

- If a brand-new response arrives while you're paused partway through the previous one, the marker moves to the new response (live companionship wins over history).
- The transcript is re-read on each poll; fine in practice, unoptimized by design.
- Timing accuracy is bounded by your terminal's redraw; at very high wpm (>900) some terminals may drop a beat.

## The science, briefly

RSVP eliminates the two main speed limits of normal reading: eye movements (saccades) and the tendency to subvocalize. With words arriving at a fixed point, most people comfortably read 2–3× faster after a few sessions. Comprehension holds best when punctuation gets extra dwell time — speedread lingers ~2.3× on sentence ends and ~1.5× on commas, and slightly longer on long or numeric words.

## License

MIT
