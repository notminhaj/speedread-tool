# speedread — RSVP speed reading for Claude Code

Read Claude's responses at 300–1000+ words per minute. A companion pane flashes each finished response **one word at a time** (RSVP — Rapid Serial Visual Presentation), with the optimal-recognition-point letter highlighted in red and pinned to a fixed pivot so your eyes never move. A **green marker `▶`** appears at the start of every finished response; press `p` to speed-read from it, `o` to pause (the marker lands wherever you stopped), `p` again to resume or go faster.

Zero dependencies — needs only [Node.js](https://nodejs.org).

## Quick start

```bash
# try the demo in any terminal
node speedread.mjs --demo

# the Claude Code companion: run this in a SECOND terminal/pane,
# in the same folder where you're running Claude Code
node speedread.mjs --follow
```

When Claude finishes a response, the companion shows `▶ response ready — press p`. Regular output stays regular; speed reading is opt-in per response, exactly one keypress away.

Opening the pane late is fine: it loads the **whole session behind the marker**, so the long response you just scrolled past — and every response before it — is still there to read.

## Keys

Keys are pressed **in the companion pane** (they only apply when it's focused — typing in Claude Code is never affected):

| Key | Action |
|---|---|
| `p` | play from the green marker; **while playing: speed up** (+25 wpm) |
| `o` | pause — the green marker lands where you stopped |
| `i` | slow down (−25 wpm) |
| `←` / `→` | jump the marker back / forward a whole response — mid-response, `←` lands at the top of the one you're in first, then keeps going back into earlier ones |
| `↑` / `↓` | move the marker by sentence |
| `r` | restart the current response |
| `q` / `Esc` | quit |

## Reading back through the session

The companion doesn't hold just the latest response — in `--follow` mode it holds **every response of the session as one document**, newest last, with the marker parked at the start of the newest one. So the default flow is unchanged (open the pane, press `p`, read what Claude just said), but the backlog is always right behind you:

- `←` jumps back one whole response, `→` forward — the fast way to reach something from ten minutes ago.
- `↑` walks back sentence by sentence and simply keeps going past the top of a response into the one before it, for when you want to land mid-response rather than at its start.
- Playback runs *forward through everything*, so parking the marker four responses back and pressing `p` reads you back up to the present. Responses get an extra beat of dwell at the seam so they don't blur together.
- The header tells you where you are (`▶ response 11 of 14`), and the footer counts both the response and the session.

While you're reading back there, a new response from Claude **does not move your marker** — it's appended and waits. The marker only follows new arrivals when it was already sitting in the newest response, which is where it starts.

## Install as a Claude Code plugin

You need **Node.js 16 or newer on your PATH** — the plugin runs the companion with `node`, and Claude Code's native installer doesn't include Node. Check with `node --version`.

From GitHub:

```bash
claude plugin marketplace add notminhaj/speedread-tool
# then inside Claude Code:
/plugin install speedread@speedread-marketplace
```

From a local checkout (for hacking on it):

```bash
claude --plugin-dir path/to/speedread-tool
```

The plugin adds a command inside Claude Code — plugin commands are namespaced, so its full name is `/speedread:speedread`, but just type `/speedread` and autocomplete resolves it:

| Command | Effect |
|---|---|
| `/speedread:speedread` | **open the companion pane** (where it opens depends on your terminal — see below) |
| `/speedread:speedread status` | show current settings and keys |
| `/speedread:speedread 400` | set reading speed to 400 wpm — **the running companion picks it up live** |
| `/speedread:speedread step 50` | change how much each speed keypress adjusts |
| `/speedread:speedread auto on` | autoplay each new response (default off: press `p` yourself) |
| `/speedread:speedread off` | how to close it (press `q` in the pane) |

Where the companion opens:

| You're running Claude Code in… | `/speedread` does |
|---|---|
| Windows Terminal | splits the current window, companion on the side |
| another Windows console | opens the companion in a new window |
| tmux (macOS/Linux) | splits the current tmux window |
| any other terminal | prints the `node … --follow --session <id>` command — run it in a second terminal, in the same folder |

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

Claude Code writes session transcripts to `~/.claude/projects/<project>/`. The companion polls a transcript for the current working directory (~every 0.6s), and re-reads it only when its size or mtime actually changed. It groups the assistant's text into one entry per response — turns that were pure tool work produce no prose and are dropped — strips markdown, and replaces code blocks with `[code block]` (code isn't meant to be read one word at a time). A response is adopted only once the file has then held still for a poll, so reading never starts mid-sentence while Claude is still writing. Multi-step turns continue from where the previous block ended instead of replaying.

Those responses are tokenized individually and concatenated into a single word stream, which is what makes the backlog navigable: a response boundary is always a sentence boundary too, and appending a new response never shifts the indices of the older ones, so your marker survives whatever Claude does next.

Which transcript: `--session <id>` pins the companion to one session's file (`/speedread` passes this automatically, so the pane stays glued to the conversation that opened it). Without a pin, it latches onto the newest transcript at startup and only ever switches to a session *created afterwards* — it never jumps between two already-running sessions.

Why a companion pane instead of keys inside Claude Code itself: Claude Code's keybindings can only map keys to its built-in actions — plugins can't add new interactive UI or key handlers, and every letter you press there is typing. The companion pane has no text input, so plain `p`, `o`, and `i` are free, with zero conflicts.

## Known limitations

- History covers the one transcript being followed: responses from another session — or from before a resume that started a new transcript file — aren't in it.
- The whole session is re-read and re-tokenized each time the transcript changes — about 12 ms for a 2.2 MB transcript, and only between responses, never during playback.
- Timing accuracy is bounded by your terminal's redraw; at very high wpm (>900) some terminals may drop a beat.

## The science, briefly

RSVP eliminates the two main speed limits of normal reading: eye movements (saccades) and the tendency to subvocalize. With words arriving at a fixed point, most people comfortably read 2–3× faster after a few sessions. Comprehension holds best when punctuation gets extra dwell time — speedread lingers ~2.3× on sentence ends and ~1.5× on commas and standalone dashes (which attach to the previous word's frame), and slightly longer on long or numeric words.

## License

MIT
