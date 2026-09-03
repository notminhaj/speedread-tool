# speedread — RSVP speed reading for Claude Code

Read Claude's responses at 300–1000+ words per minute. A companion pane flashes each finished response **one word at a time** (RSVP — Rapid Serial Visual Presentation), drawn in **big block letters** with the optimal-recognition-point letter highlighted in red and pinned to a fixed pivot so your eyes never move. A **green marker `▶`** appears at the start of every finished response; press `Ctrl+P` to speed-read from it, `Ctrl+O` to pause (the marker lands wherever you stopped), `Ctrl+P` again to resume or go faster.

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

Opening the pane late is fine: it loads the **whole session behind the marker**, so the long response you just scrolled past — and every response before it — is still there to read.

## Keys

Keys are pressed **in the companion pane** (they only apply when it's focused — typing in Claude Code is never affected):

| Key | Action |
|---|---|
| `Ctrl+P` | play from the green marker; **while playing: speed up** (+25 wpm) |
| `Ctrl+O` | pause — the green marker lands where you stopped |
| `Ctrl+I` | slow down (−25 wpm) |
| `←` / `→` | jump the marker back / forward a whole response — mid-response, `←` lands at the top of the one you're in first, then keeps going back into earlier ones |
| `↑` / `↓` | move the marker by sentence |
| `r` | restart the current response |
| `q` / `Esc` | quit |

Plain `p`, `o`, and `i` work as aliases — the pane has no text input, so single letters are free there. That's the fallback for terminals that swallow Ctrl combos (VS Code's integrated terminal takes `Ctrl+P` for Quick Open). `Ctrl+I` is byte-identical to `Tab` in every terminal — a terminal fact, not a choice — so `Tab` also slows down.

## Text size

The flashed word is drawn in block letters — a 5x10 pixel grid per character, painted with half-block characters so the letters keep a typeface's proportions — because one row of terminal text is a small target for the eye to sit on. `size` picks how big:

| `size` | What you get |
|---|---|
| `1` | plain terminal text (the old look) |
| `2` | block letters — **the default** |
| `3` | double-size block letters; wants a wide pane |

Set it with `/speedread size 3`, or `--size 3` on the command line. A word too wide to fit beside the pivot steps down a size and only then falls back to plain text, so a URL or a long path still shows up, just smaller — the same fallback covers a pane too short for block letters, and the rare character the font has no glyph for.

## Reading back through the session

The companion doesn't hold just the latest response — in `--follow` mode it holds **every response of the session as one document**, newest last, with the marker parked at the start of the newest one. So the default flow is unchanged (open the pane, press `Ctrl+P`, read what Claude just said), but the backlog is always right behind you:

- `←` jumps back one whole response, `→` forward — the fast way to reach something from ten minutes ago.
- `↑` walks back sentence by sentence and simply keeps going past the top of a response into the one before it, for when you want to land mid-response rather than at its start.
- Playback runs *forward through everything*, so parking the marker four responses back and pressing `Ctrl+P` reads you back up to the present. Responses get an extra beat of dwell at the seam so they don't blur together.
- The header tells you where you are (`▶ response 11 of 14`), and the footer counts both the response and the session.

While you're reading back there, a new response from Claude **does not move your marker** — it's appended and waits. The marker only follows new arrivals when it was already sitting in the newest response, which is where it starts.

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
| `/speedread:speedread` | **open the companion pane** — splits Windows Terminal, or tells you the command |
| `/speedread:speedread status` | show current settings and keys |
| `/speedread:speedread 400` | set reading speed to 400 wpm — **the running companion picks it up live** |
| `/speedread:speedread step 50` | change how much each speed keypress adjusts |
| `/speedread:speedread auto on` | autoplay each new response (default off: press `p` yourself) |
| `/speedread:speedread size 3` | how big the flashed word is drawn (1 plain text, 2 block letters, 3 double-size) |
| `/speedread:speedread off` | how to close it (press `q` in the pane) |

Settings live in `~/.speedread.json`:

```json
{ "wpm": 300, "step": 25, "autoplay": false, "size": 2 }
```

The companion re-reads this file every second, so changes apply without restarting.

## Other input sources

It's also a general-purpose RSVP reader:

```bash
node speedread.mjs notes.txt --wpm 450   # a file
git log | node speedread.mjs             # any piped output
node speedread.mjs --clip                # the clipboard
node speedread.mjs --claude              # one-shot: Claude's last response
node speedread.mjs notes.txt --size 3    # bigger block letters
```

On Windows, `speedread.cmd` lets you run `.\speedread` (add the folder to PATH to use it anywhere).

## How the companion finds Claude's responses

Claude Code writes session transcripts to `~/.claude/projects/<project>/`. The companion polls a transcript for the current working directory (~every 0.6s), and re-reads it only when its size or mtime actually changed. It groups the assistant's text into one entry per response — turns that were pure tool work produce no prose and are dropped — strips markdown, and replaces code blocks with `[code block]` (code isn't meant to be read one word at a time). A response is adopted only once the file has then held still for a poll, so reading never starts mid-sentence while Claude is still writing. Multi-step turns continue from where the previous block ended instead of replaying.

Those responses are tokenized individually and concatenated into a single word stream, which is what makes the backlog navigable: a response boundary is always a sentence boundary too, and appending a new response never shifts the indices of the older ones, so your marker survives whatever Claude does next.

Which transcript: `--session <id>` pins the companion to one session's file (`/speedread` passes this automatically, so the pane stays glued to the conversation that opened it). Without a pin, it latches onto the newest transcript at startup and only ever switches to a session *created afterwards* — it never jumps between two already-running sessions.

Why a companion pane instead of keys inside Claude Code itself: Claude Code's keybindings can only map keys to its built-in actions — plugins can't add new interactive UI or key handlers, `Ctrl+O` is already its transcript toggle, and `Ctrl+I` is indistinguishable from `Tab` at the byte level. The companion pane gets you the exact interaction model with zero conflicts.

## Known limitations (v1)

- History covers the one transcript being followed: responses from another session — or from before a resume that started a new transcript file — aren't in it.
- The whole session is re-read and re-tokenized each time the transcript changes — about 12 ms for a 2.2 MB transcript, and only between responses, never during playback.
- Timing accuracy is bounded by your terminal's redraw; at very high wpm (>900) some terminals may drop a beat.

## The science, briefly

RSVP eliminates the two main speed limits of normal reading: eye movements (saccades) and the tendency to subvocalize. With words arriving at a fixed point, most people comfortably read 2–3× faster after a few sessions. Comprehension holds best when punctuation gets extra dwell time — speedread lingers ~2.3× on sentence ends and ~1.5× on commas and standalone dashes (which attach to the previous word's frame), and slightly longer on long or numeric words.

## License

MIT
