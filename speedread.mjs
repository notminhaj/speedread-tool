#!/usr/bin/env node
// speedread — an RSVP (Rapid Serial Visual Presentation) speed reader for the terminal,
// with a companion mode for Claude Code: it watches the project transcript, drops a green
// marker at the start of each finished response, and speed-reads on demand.
// Zero dependencies.
//
// Usage:
//   speedread --follow                companion mode: marker appears when Claude finishes;
//                                     press p to speed-read from the marker
//   speedread --claude                one-shot: play Claude Code's last response
//   speedread <file> [--wpm 300]      read a text file
//   <cmd> | speedread                 read piped output
//   speedread --clip                  read the clipboard
//   speedread --demo                  built-in demo text
//
// Keys:
//   Ctrl+P (or p)      play from the green marker; while playing: speed up
//   Ctrl+O (or o)      pause — the marker lands where you stopped
//   Ctrl+I / Tab (or i)  slow down
//   left/right  jump by response      up/down  jump by sentence
//               (in follow mode both walk the whole session, oldest response on)
//   r restart this response      q / Esc  quit
//
// Config (~/.speedread.json, live-reloaded):
//   { "wpm": 300, "step": 25, "autoplay": false, "size": 2 }

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tty from 'node:tty';
import { spawnSync } from 'node:child_process';

const CSI = '\x1b[';
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RED = '\x1b[91m';
const GREEN = '\x1b[92m';

const CONFIG_PATH = path.join(os.homedir(), '.speedread.json');

const DEMO_TEXT = `Most people read at around 200-300 words per minute, but usually a person wastes so much time on unnecessary habits. When you read, two things slow you down: subvocalization (that voice in your head reading every word out loud internally) and slow eye movements across the page. Here's the thing - you don't actually need to "speak" words in your head to understand them. If you stop the internal voice and let your eyes move faster, you can easily read 500-1,000 words per minute or more. That's the secret behind speed reading apps where words flash on screen one at a time. When words appear rapidly, your brain naturally stops the internal voice and just processes what it sees. Your eyes can actually move much faster than they do now - most people just train them to go slowly because they're stuck in the subvocalization habit. The good news? You can retrain yourself. Practice reading without speaking words in your head, push your eyes to move faster across lines, and within a few weeks you'll double your reading speed. It's not magic - it's simply breaking old habits and building new ones. Speed reading isn't talent - it's trained focus plus discipline.`;

// ---------------------------------------------------------------- config

function loadConfigFile() {
  // strip a UTF-8 BOM: PowerShell-written files often have one
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '')); } catch { return {}; }
}
function normalizeConfig(raw) {
  const c = { wpm: 300, step: 25, autoplay: false, size: 2, ...raw };
  c.wpm = Number.isFinite(c.wpm) ? Math.min(1500, Math.max(60, c.wpm)) : 300;
  c.step = Number.isFinite(c.step) ? Math.min(200, Math.max(5, c.step)) : 25;
  c.autoplay = !!c.autoplay;
  // 1 plain terminal text, 2 block letters, 3 double-size block letters
  c.size = Number.isFinite(c.size) ? Math.min(3, Math.max(1, Math.round(c.size))) : 2;
  return c;
}
let lastCfg = normalizeConfig(loadConfigFile());
let cfgMtime = 0;
try { cfgMtime = fs.statSync(CONFIG_PATH).mtimeMs; } catch { }

// ---------------------------------------------------------------- args

const argv = process.argv.slice(2);
const opts = { wpm: null, size: null, file: null, clip: false, claude: false, follow: false, demo: false, help: false, session: null };
for (let a = 0; a < argv.length; a++) {
  const arg = argv[a];
  if (arg === '--wpm') { opts.wpm = parseInt(argv[++a], 10); }
  else if (arg.startsWith('--wpm=')) { opts.wpm = parseInt(arg.slice(6), 10); }
  else if (arg === '--size') { opts.size = parseInt(argv[++a], 10); }
  else if (arg.startsWith('--size=')) { opts.size = parseInt(arg.slice(7), 10); }
  else if (arg === '--session') { opts.session = argv[++a]; }
  else if (arg.startsWith('--session=')) { opts.session = arg.slice(10); }
  else if (arg === '--clip') { opts.clip = true; }
  else if (arg === '--claude') { opts.claude = true; }
  else if (arg === '--follow') { opts.follow = true; }
  else if (arg === '--demo') { opts.demo = true; }
  else if (arg === '--help' || arg === '-h') { opts.help = true; }
  else if (!arg.startsWith('-')) { opts.file = arg; }
  else { console.error(`unknown option: ${arg}`); process.exit(2); }
}

if (opts.help) {
  console.log(`speedread — RSVP speed reader for the terminal + Claude Code companion

  speedread --follow             companion mode: green marker on each finished
                                 Claude response; p plays from the marker,
                                 ← walks back through the whole session
  speedread --claude             one-shot: play Claude Code's last response
  speedread <file> [--wpm 300]   read a text file
  <cmd> | speedread              read piped output
  speedread --clip               read the clipboard
  speedread --demo               built-in demo text

keys: Ctrl+P play/faster · Ctrl+O pause (marker lands there) · Ctrl+I slower
      left/right response · up/down sentence · r restart · q quit
      (plain p/o/i also work — the pane has no text input, so they're free)
--size 1|2|3: how big the flashed word is drawn — 1 plain terminal text,
      2 block letters (default), 3 double-size block letters (wants a wide pane)
config: ~/.speedread.json  { "wpm": 300, "step": 25, "autoplay": false, "size": 2 }
--session <id>: pin to one Claude session's transcript (prefix of its filename)`);
  process.exit(0);
}

let wpm = lastCfg.wpm;
let step = lastCfg.step;
let autoplay = lastCfg.autoplay;
let size = lastCfg.size;
if (Number.isFinite(opts.wpm)) wpm = Math.min(1500, Math.max(60, opts.wpm));
if (Number.isFinite(opts.size)) size = Math.min(3, Math.max(1, opts.size));

// ---------------------------------------------------------------- text sources

function stripMarkdown(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' [code block] ')
    .replace(/```[\s\S]*$/g, ' [code block] ')
    .replace(/`([^`\n]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/\*\*|__|\*/g, '')
    .replace(/\|/g, ' ');
}

function claudeProjectDir() {
  const munged = process.cwd().replace(/[^A-Za-z0-9]/g, '-');
  return path.join(os.homedir(), '.claude', 'projects', munged);
}

function listTranscripts(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => path.join(dir, f))
    .map(p => { const s = fs.statSync(p); return { p, m: s.mtimeMs, b: s.birthtimeMs }; })
    .sort((x, y) => y.m - x.m);
}

function newestTranscript(dir) {
  const files = listTranscripts(dir);
  return files.length ? files[0].p : null;
}

// Resolve a --session pin: a session id prefix or transcript filename.
function transcriptForSession(dir, pin) {
  const base = pin.replace(/\.jsonl$/, '');
  const hit = listTranscripts(dir).find(f => path.basename(f.p, '.jsonl').startsWith(base));
  return hit ? hit.p : null;
}

// Pick which transcript to read: an explicit --session pin wins; otherwise
// the most recently modified one in this project's transcript folder.
function resolveTranscript() {
  const dir = claudeProjectDir();
  if (opts.session) {
    const f = transcriptForSession(dir, opts.session);
    if (!f) throw new Error(`no transcript matching session "${opts.session}" in ${dir}`);
    return f;
  }
  const f = newestTranscript(dir);
  if (!f) {
    throw new Error(`no Claude Code transcript found for this project\n  expected: ${dir}\n  run speedread from the folder where you use Claude Code`);
  }
  return f;
}

// Every one of Claude's turns in a transcript, oldest first: assistant text
// blocks grouped by the real user messages that separate them (tool results
// also arrive as "user" entries, so a user entry only ends a turn when it
// carries actual text). Turns that produced no prose — tool-only work — are
// dropped, so every entry here is something you can actually read.
function extractClaudeTurns(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const turns = [];
  let parts = [];
  const endTurn = () => {
    if (!parts.length) return;
    const text = stripMarkdown(parts.join('\n\n')).trim();
    parts = [];
    if (text) turns.push(text);
  };
  for (const raw of lines) {
    if (!raw.trim()) continue;
    let e;
    try { e = JSON.parse(raw); } catch { continue; } // trailing line may be mid-write
    if (e.isSidechain) continue;                     // subagent chatter isn't this conversation
    const c = e.message && e.message.content;
    if (e.type === 'user') {
      if (e.isMeta) continue;
      const isReal = typeof c === 'string'
        || (Array.isArray(c) && c.some(x => x && x.type === 'text'));
      if (isReal) endTurn();
      continue;
    }
    if (e.type !== 'assistant' || !Array.isArray(c)) continue;
    for (const item of c) {
      if (item && item.type === 'text' && item.text) parts.push(item.text);
    }
  }
  endTurn();
  return turns;
}

// The text of Claude's latest turn.
function extractLastClaudeResponse(file) {
  const turns = extractClaudeTurns(file);
  return turns.length ? turns[turns.length - 1] : '';
}

function readClipboard() {
  let r;
  if (process.platform === 'win32') {
    r = spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Get-Clipboard -Raw'], { encoding: 'utf8' });
  } else if (process.platform === 'darwin') {
    r = spawnSync('pbpaste', [], { encoding: 'utf8' });
  } else {
    r = spawnSync('xclip', ['-o', '-selection', 'clipboard'], { encoding: 'utf8' });
    if (r.error || r.status !== 0) r = spawnSync('wl-paste', [], { encoding: 'utf8' });
  }
  if (r.error || r.status !== 0) throw new Error('could not read clipboard');
  return r.stdout || '';
}

function resolveText() {
  if (opts.demo) return { text: DEMO_TEXT, label: 'demo' };
  if (opts.claude || opts.follow) return { text: extractLastClaudeResponse(resolveTranscript()), label: 'claude' };
  if (opts.clip) return { text: readClipboard(), label: 'clipboard' };
  if (opts.file) return { text: fs.readFileSync(opts.file, 'utf8'), label: path.basename(opts.file) };
  if (!process.stdin.isTTY) return { text: fs.readFileSync(0, 'utf8'), label: 'stdin' };
  console.error('nothing to read — pass a file, pipe text in, or use --clip / --claude / --follow / --demo\n(speedread --help for usage)');
  process.exit(2);
}

// ---------------------------------------------------------------- tokenizing & timing

// Optimal recognition point: the letter your eye should land on.
function orpIndex(len) {
  if (len <= 1) return 0;
  if (len <= 5) return 1;
  if (len <= 9) return 2;
  if (len <= 13) return 3;
  return 4;
}

// A token that ends a sentence, allowing trailing closers ("done.", 'end."').
// Shared by sentenceStarts detection and the dash-merge skip rule so they never drift.
const SENTENCE_END = /[.!?…]["')\]}»”’]*$/;

// Per-word display-time multiplier: longer words and clause/sentence ends linger.
function multiplierFor(word) {
  let m = 1;
  const bare = word.replace(/["')\]}»”’]+$/, '');
  if (/[.!?…]$/.test(bare)) m += 1.3;
  else if (/[,;:—–]$/.test(bare)) m += 0.5;
  if (word.length > 8) m += 0.3;
  if (word.length > 12) m += 0.4;
  if (/\d/.test(word)) m += 0.3;
  return m;
}

// A whitespace-delimited token that is nothing but dashes ("-", "--", "–", "—").
const DASH_RUN = /^[-–—]+$/;
// word/word compound: both sides letters only (Unicode), each >= 2 chars — which
// structurally guarantees exactly one slash — plus optional TRAILING punctuation.
// Leaves whole: URLs, paths, dates, digits ("x2/x4"), "I/O", "w/", "(and/or".
const SLASH_COMPOUND = /^(\p{L}{2,})\/(\p{L}{2,})([.,;:!?…"')\]}»”’]*)$/u;

// Refine the raw whitespace split: standalone dashes attach to the previous
// word's frame (as " —", so multiplierFor's clause class gives it the pause),
// and word/word compounds split into two frames ("speed/" then "step").
// Left-to-right; each decision depends only on the current raw token and the
// last OUTPUT token — never on lookahead — so when a follow-mode turn grows,
// the refined stream of the old text stays a positional prefix of the new one.
function refineTokens(raw) {
  const out = [];
  for (const w of raw) {
    if (DASH_RUN.test(w)) {
      const prev = out[out.length - 1];
      // Drop the dash when there is no previous word, when the previous word
      // ends a sentence (merging would lose the sentence boundary and its
      // longer dwell), or when a dash is already attached (collapse runs).
      if (prev !== undefined && !SENTENCE_END.test(prev) && !prev.endsWith('—')) {
        out[out.length - 1] = prev + ' —';
      }
      continue;
    }
    const m = SLASH_COMPOUND.exec(w);
    if (m) { out.push(m[1] + '/', m[2] + m[3]); continue; }
    out.push(w);
  }
  // Text that was ONLY dashes: keep the "non-empty text => at least one frame"
  // invariant that follow mode's turnStarts indexing relies on.
  if (!out.length && raw.length) out.push('—');
  return out;
}

function tokenize(text) {
  const raw = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const words = refineTokens(raw);
  const mults = words.map(multiplierFor);
  const cum = [0];
  for (let i = 0; i < mults.length; i++) cum.push(cum[i] + mults[i]);
  const sentenceStarts = [0];
  for (let i = 0; i < words.length - 1; i++) {
    if (SENTENCE_END.test(words[i])) sentenceStarts.push(i + 1);
  }
  return { words, mults, cum, sentenceStarts };
}

// Tokenize a whole session as ONE document: every turn's words concatenated,
// with `turnStarts` marking where each response begins. Tokenizing per turn and
// concatenating (rather than joining the text first) means a turn boundary is
// always a sentence boundary too, so a sentence step walks cleanly from one
// response back into the previous one. The last word of a turn gets extra dwell,
// so responses don't blur together when playback runs across the seam.
function tokenizeTurns(turnTexts) {
  const words = [], mults = [], sentenceStarts = [], turnStarts = [];
  for (const text of turnTexts) {
    const t = tokenize(text);
    if (!t.words.length) continue;
    const off = words.length;
    if (off) mults[off - 1] += 1;              // linger on the previous turn's last word
    turnStarts.push(off);
    for (const s of t.sentenceStarts) sentenceStarts.push(off + s);
    for (const w of t.words) words.push(w);    // push in a loop: spread blows the stack on long sessions
    for (const m of t.mults) mults.push(m);
  }
  const cum = [0];
  for (let i = 0; i < mults.length; i++) cum.push(cum[i] + mults[i]);
  return { words, mults, cum, sentenceStarts, turnStarts };
}

// ---------------------------------------------------------------- non-interactive fallback

// When stdout isn't a terminal there is nothing to animate: print the resolved
// text and its stats instead (this is also the scriptable/smoke-test mode).
if (!process.stdout.isTTY) {
  try {
    const { text, label } = resolveText();
    const { words, cum } = tokenize(text);
    const secs = (cum[words.length] * 60000 / wpm) / 1000;
    // In follow mode, also report the backlog the pane would load behind the marker.
    let backlog = '';
    if (opts.follow) {
      try {
        const all = extractClaudeTurns(resolveTranscript());
        backlog = ` responses=${all.length} session-words=${tokenizeTurns(all).words.length}`;
      } catch { }
    }
    process.stdout.write(text + '\n');
    process.stdout.write(`\n[speedread] source=${label} words=${words.length}${backlog} wpm=${wpm} step=${step} autoplay=${autoplay} est=${Math.round(secs)}s\n`);
  } catch (e) {
    console.error('speedread: ' + e.message);
    process.exit(1);
  }
  process.exit(0);
}

// ---------------------------------------------------------------- terminal setup

let inStream = null;
let rawEnabled = false;
let cleanedUp = false;

function setupInput() {
  if (process.stdin.isTTY) { inStream = process.stdin; }
  else {
    try {
      const dev = process.platform === 'win32' ? 'CONIN$' : '/dev/tty';
      const fd = fs.openSync(dev, 'r+');
      inStream = new tty.ReadStream(fd);
    } catch { inStream = null; }
  }
  if (inStream && inStream.isTTY) {
    try { inStream.setRawMode(true); rawEnabled = true; } catch { inStream = null; }
  } else { inStream = null; }
  if (inStream) { inStream.resume(); inStream.on('data', onKey); }
}

function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  try { if (inStream && rawEnabled) inStream.setRawMode(false); } catch { }
  process.stdout.write(CSI + '?25h' + CSI + '?1049l' + RESET);
}

process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('uncaughtException', (e) => { cleanup(); console.error('speedread: ' + (e && e.message)); process.exit(1); });

// ---------------------------------------------------------------- player state
//
// Modes: waiting (follow: no response yet) -> ready (green marker set, not playing)
//        -> playing <-> paused (marker lands at pause point) -> done (marker back
//        at the start of the response just read)
// `idx` is both the playhead and the marker: when not playing, idx IS the marker.
//
// In follow mode `doc` is the WHOLE session — every response Claude has given in
// this conversation, concatenated — and `turnStarts` says where each one begins.
// The marker sits at the latest response, so nothing about the default flow
// changes; ← simply keeps walking back past the top of it into everything older.

let doc = null;
let idx = 0;
let mode = 'idle';
let timer = null;
let turns = [];          // follow: text of every response in the session, oldest first
let turnStarts = [];     // follow: doc word index where each of those responses begins
let readCount = 0;       // words covered by the run that just finished (for the done screen)

// Where the response containing word `i` starts, and which response that is (1-based).
// Both degrade to the single-document case when there are no turns (file/clip/demo).
function turnStartAt(i) {
  let start = 0;
  for (const v of turnStarts) { if (v <= i) start = v; else break; }
  return start;
}
function turnIndexAt(i) {
  let k = 0;
  for (const v of turnStarts) { if (v <= i) k++; else break; }
  return k;
}

function baseDelay() { return 60000 / wpm; }
function delayFor(i) { return Math.max(20, doc.mults[i] * baseDelay()); }

function fmtTime(secs) {
  secs = Math.max(0, Math.round(secs));
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- big text
//
// The flashed word is the whole point of RSVP, and one row of terminal text is
// a small target for it. FONT draws the word in block letters instead: every
// character is a 5x10 grid of pixels — cap height on rows 0-6, baseline row 6,
// descenders on rows 7-8 — painted with half-block characters so two pixel rows
// share one terminal row and the letters keep roughly a typeface's proportions.
//
// Each entry is `<top>|<row>|<row>…`: the pixel row the pattern starts on, then
// its rows with `#` for ink. Capitals and ascenders start at 0 and x-height
// letters at 2, which is what lines the baselines up across a word.

const GW = 5, GH = 10, GAP = 1;

const FONT = {
  A: '0|.###.|#...#|#...#|#####|#...#|#...#|#...#',
  B: '0|####.|#...#|#...#|####.|#...#|#...#|####.',
  C: '0|.###.|#...#|#....|#....|#....|#...#|.###.',
  D: '0|####.|#...#|#...#|#...#|#...#|#...#|####.',
  E: '0|#####|#....|#....|####.|#....|#....|#####',
  F: '0|#####|#....|#....|####.|#....|#....|#....',
  G: '0|.###.|#...#|#....|#.###|#...#|#...#|.###.',
  H: '0|#...#|#...#|#...#|#####|#...#|#...#|#...#',
  I: '0|#####|..#..|..#..|..#..|..#..|..#..|#####',
  J: '0|..###|...#.|...#.|...#.|...#.|#..#.|.##..',
  K: '0|#...#|#..#.|#.#..|##...|#.#..|#..#.|#...#',
  L: '0|#....|#....|#....|#....|#....|#....|#####',
  M: '0|#...#|##.##|#.#.#|#.#.#|#...#|#...#|#...#',
  N: '0|#...#|##..#|#.#.#|#.#.#|#..##|#...#|#...#',
  O: '0|.###.|#...#|#...#|#...#|#...#|#...#|.###.',
  P: '0|####.|#...#|#...#|####.|#....|#....|#....',
  Q: '0|.###.|#...#|#...#|#...#|#.#.#|#..#.|.##.#',
  R: '0|####.|#...#|#...#|####.|#.#..|#..#.|#...#',
  S: '0|.####|#....|#....|.###.|....#|....#|####.',
  T: '0|#####|..#..|..#..|..#..|..#..|..#..|..#..',
  U: '0|#...#|#...#|#...#|#...#|#...#|#...#|.###.',
  V: '0|#...#|#...#|#...#|#...#|#...#|.#.#.|..#..',
  W: '0|#...#|#...#|#...#|#.#.#|#.#.#|##.##|#...#',
  X: '0|#...#|#...#|.#.#.|..#..|.#.#.|#...#|#...#',
  Y: '0|#...#|#...#|.#.#.|..#..|..#..|..#..|..#..',
  Z: '0|#####|....#|...#.|..#..|.#...|#....|#####',

  a: '2|.###.|....#|.####|#...#|.####',
  b: '0|#....|#....|####.|#...#|#...#|#...#|####.',
  c: '2|.###.|#...#|#....|#...#|.###.',
  d: '0|....#|....#|.####|#...#|#...#|#...#|.####',
  e: '2|.###.|#...#|#####|#....|.###.',
  f: '0|..##.|.#...|####.|.#...|.#...|.#...|.#...',
  g: '2|.####|#...#|#...#|#...#|.####|....#|.###.',
  h: '0|#....|#....|####.|#...#|#...#|#...#|#...#',
  i: '0|..#..|.....|.##..|..#..|..#..|..#..|.###.',
  j: '0|...#.|.....|..##.|...#.|...#.|...#.|...#.|#..#.|.##..',
  k: '0|#....|#....|#..#.|#.#..|##...|#.#..|#..#.',
  l: '0|.##..|..#..|..#..|..#..|..#..|..#..|.###.',
  m: '2|##.#.|#.#.#|#.#.#|#.#.#|#.#.#',
  n: '2|####.|#...#|#...#|#...#|#...#',
  o: '2|.###.|#...#|#...#|#...#|.###.',
  p: '2|####.|#...#|#...#|#...#|####.|#....|#....',
  q: '2|.####|#...#|#...#|#...#|.####|....#|....#',
  r: '2|#.##.|##..#|#....|#....|#....',
  s: '2|.####|#....|.###.|....#|####.',
  t: '0|.....|.#...|####.|.#...|.#...|.#..#|..##.',
  u: '2|#...#|#...#|#...#|#...#|.####',
  v: '2|#...#|#...#|#...#|.#.#.|..#..',
  w: '2|#...#|#.#.#|#.#.#|#.#.#|.#.#.',
  x: '2|#...#|.#.#.|..#..|.#.#.|#...#',
  y: '2|#...#|#...#|#...#|#...#|.####|....#|.###.',
  z: '2|#####|...#.|..#..|.#...|#####',

  0: '0|.###.|#...#|#..##|#.#.#|##..#|#...#|.###.',
  1: '0|..#..|.##..|..#..|..#..|..#..|..#..|.###.',
  2: '0|.###.|#...#|....#|...#.|..#..|.#...|#####',
  3: '0|#####|...#.|..##.|....#|....#|#...#|.###.',
  4: '0|...#.|..##.|.#.#.|#..#.|#####|...#.|...#.',
  5: '0|#####|#....|####.|....#|....#|#...#|.###.',
  6: '0|..##.|.#...|#....|####.|#...#|#...#|.###.',
  7: '0|#####|....#|...#.|..#..|.#...|.#...|.#...',
  8: '0|.###.|#...#|#...#|.###.|#...#|#...#|.###.',
  9: '0|.###.|#...#|#...#|.####|....#|...#.|.##..',

  '.': '2|.....|.....|.....|.##..|.##..',
  ',': '2|.....|.....|.....|.##..|.##..|..#..|.#...',
  ':': '2|.##..|.##..|.....|.##..|.##..',
  ';': '2|.##..|.##..|.....|.##..|.##..|..#..|.#...',
  '!': '0|..#..|..#..|..#..|..#..|..#..|.....|..#..',
  '?': '0|.###.|#...#|....#|...#.|..#..|.....|..#..',
  "'": '0|..#..|..#..',
  '"': '0|.#.#.|.#.#.',
  '-': '2|.....|.....|#####|.....|.....',
  '_': '2|.....|.....|.....|.....|.....|#####',
  '/': '0|....#|....#|...#.|..#..|.#...|#....|#....',
  '\\': '0|#....|#....|.#...|..#..|...#.|....#|....#',
  '(': '0|...#.|..#..|.#...|.#...|.#...|..#..|...#.',
  ')': '0|.#...|..#..|...#.|...#.|...#.|..#..|.#...',
  '[': '0|.###.|.#...|.#...|.#...|.#...|.#...|.###.',
  ']': '0|.###.|...#.|...#.|...#.|...#.|...#.|.###.',
  '{': '0|..##.|.#...|.#...|##...|.#...|.#...|..##.',
  '}': '0|.##..|...#.|...#.|..###|...#.|...#.|.##..',
  '+': '2|..#..|..#..|#####|..#..|..#..',
  '=': '2|.....|#####|.....|#####|.....',
  '<': '2|...#.|..#..|.#...|..#..|...#.',
  '>': '2|.#...|..#..|...#.|..#..|.#...',
  '*': '0|.....|#.#.#|.###.|#####|.###.|#.#.#',
  '#': '0|.#.#.|.#.#.|#####|.#.#.|#####|.#.#.|.#.#.',
  '%': '0|##..#|##.#.|...#.|..#..|.#...|#.##.|#..##',
  '&': '0|.##..|#..#.|#..#.|.##..|#.#.#|#..#.|.##.#',
  '@': '0|.###.|#...#|#.###|#.#.#|#.###|#....|.###.',
  '$': '0|..#..|.####|#.#..|.###.|..#.#|####.|..#..',
  '|': '0|..#..|..#..|..#..|..#..|..#..|..#..|..#..',
  '…': '2|.....|.....|.....|.....|#.#.#',
  ' ': '0|.....',
};

// Characters that stand in for others: Claude's prose is full of curly quotes
// and dashes, and there is no reason to drop to plain text over one of them.
const FONT_ALIAS = {
  '’': "'", '‘': "'", '“': '"', '”': '"',
  '—': '-', '–': '-', '−': '-', '·': '.', '•': '.',
  ' ': ' ',
};

// A glyph as GH rows of GW characters, blank-padded to its top offset, or null
// for a character the font has no pattern for.
const glyphCache = new Map();
function glyph(ch) {
  if (glyphCache.has(ch)) return glyphCache.get(ch);
  const spec = FONT[FONT_ALIAS[ch] || ch];
  let rows = null;
  if (spec) {
    const parts = spec.split('|');
    const top = parseInt(parts[0], 10);
    rows = new Array(GH).fill('.'.repeat(GW));
    for (let i = 1; i < parts.length && top + i - 1 < GH; i++) {
      rows[top + i - 1] = (parts[i] + '.....').slice(0, GW);
    }
  }
  glyphCache.set(ch, rows);
  return rows;
}

// Draw `word` in block letters with its ORP letter red and that letter's centre
// column sitting exactly on `pivot`, so the eye never moves. Returns the
// terminal rows to print, or null when it can't be drawn at scale `s` — an
// unknown character, or a word too wide to fit beside the pivot — which is the
// caller's cue to try a smaller scale, or plain text.
function bigWordRows(word, orpChar, pivot, cols, s) {
  const gs = [];
  for (const ch of word) {
    const g = glyph(ch);
    if (!g) return null;
    gs.push(g);
  }
  if (!gs.length) return null;

  const pxW = gs.length * (GW + GAP) - GAP;
  const width = pxW * s;
  // Centre column of the ORP letter, in cells, measured from the word's left edge.
  const orpCell = (orpChar * (GW + GAP) + Math.floor(GW / 2)) * s + Math.floor(s / 2);
  const left = pivot - orpCell;
  if (left < 0 || left + width > cols) return null;

  const out = [];
  for (let t = 0; t < (GH * s) / 2; t++) {
    let row = '';
    let colour = '';
    for (let c = 0; c < width; c++) {
      const px = Math.floor(c / s);
      const ci = Math.floor(px / (GW + GAP));
      const gx = px % (GW + GAP);
      const up = gx < GW && gs[ci][Math.floor((2 * t) / s)][gx] === '#';
      const dn = gx < GW && gs[ci][Math.floor((2 * t + 1) / s)][gx] === '#';
      const ink = up && dn ? '█' : up ? '▀' : dn ? '▄' : ' ';
      // The gap column between letters is always blank, so no cell ever has to
      // carry two colours at once.
      const want = ink === ' ' ? colour : (ci === orpChar ? RED + BOLD : RESET);
      if (want !== colour) { row += want; colour = want; }
      row += ink;
    }
    out.push(' '.repeat(left) + row + RESET);
  }
  return out;
}

// ---------------------------------------------------------------- rendering

function line(row, content) {
  return CSI + row + ';1H' + CSI + '2K' + content;
}
function visibleLen(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, '').length;
}
function centered(str, cols) {
  const pad = Math.max(0, Math.floor((cols - visibleLen(str)) / 2));
  return ' '.repeat(pad) + str;
}

const HINTS = `${DIM}^P play/faster · ^O pause · ^I slower · ←/→ response · ↑↓ sentence · q quit${RESET}`;

function screenBase() {
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  return { cols, rows, mid: Math.floor(rows / 2) };
}

function statusFooter(cols, rows, extra) {
  let out = '';
  out += line(rows - 2, centered(`${BOLD}${wpm}${RESET}${DIM} wpm${extra ? '  ·  ' + extra : ''}${RESET}`, cols));
  out += line(rows - 1, centered(HINTS, cols));
  return out;
}

// A few words of context around the marker, marker drawn as a green ▶.
function markerContext(cols) {
  if (!doc || !doc.words.length) return '';
  const before = doc.words.slice(Math.max(0, idx - 4), idx).join(' ');
  const after = doc.words.slice(idx, idx + 9).join(' ');
  const lead = idx > 4 ? '…' : '';
  const trail = idx + 9 < doc.words.length ? '…' : '';
  const s = `${DIM}${lead}${before}${RESET} ${GREEN}${BOLD}▶${RESET} ${after}${DIM}${trail}${RESET}`;
  return visibleLen(s) <= cols - 2 ? s : `${GREEN}${BOLD}▶${RESET} ` + after.slice(0, Math.max(0, cols - 8)) + '…';
}

function drawWaiting() {
  const { cols, rows, mid } = screenBase();
  let out = CSI + '2J';
  out += line(mid - 1, centered(`⏳ waiting for Claude's next response…`, cols));
  out += line(mid + 1, centered(`${DIM}watching this project's transcript${RESET}`, cols));
  out += statusFooter(cols, rows);
  process.stdout.write(out);
}

// Where the marker sits, for the footer: which response, and how far into the session.
function positionExtra() {
  const total = doc ? doc.words.length : 0;
  const pos = `${Math.min(idx + 1, total)}/${total}`;
  return turnStarts.length > 1 ? `response ${turnIndexAt(idx)}/${turnStarts.length}  ·  ${pos}` : pos;
}

// Once there's a backlog to walk, say so — the arrows are the only way to reach
// it, and nothing else on screen hints that older responses are still there.
function historyHint(cols, rows, mid) {
  if (turnStarts.length < 2 || mid + 3 >= rows - 2) return '';
  return line(mid + 3, centered(`${DIM}←/→ jump between the ${turnStarts.length} responses in this session · ↑↓ by sentence${RESET}`, cols));
}

function drawReady(label) {
  const { cols, rows, mid } = screenBase();
  const total = doc.words.length;
  const remaining = (doc.cum[total] - doc.cum[idx]) * baseDelay() / 1000;
  const k = turnIndexAt(idx);
  // Back in the backlog, say which response you're on instead of "ready".
  const where = label || (turnStarts.length > 1 && k < turnStarts.length
    ? `response ${k} of ${turnStarts.length}` : 'response ready');
  let out = CSI + '2J';
  out += line(mid - 2, centered(`${GREEN}${BOLD}▶ ${where}${RESET}`, cols));
  out += line(mid, centered(markerContext(cols), cols));
  out += line(mid + 2, centered(`${DIM}${total - idx} words from the marker · ~${fmtTime(remaining)} at ${wpm} wpm · press Ctrl+P${RESET}`, cols));
  out += historyHint(cols, rows, mid);
  out += statusFooter(cols, rows, positionExtra());
  process.stdout.write(out);
}

function drawPaused() {
  const { cols, rows, mid } = screenBase();
  let out = CSI + '2J';
  out += line(mid - 2, centered(`${BOLD}⏸ paused${RESET} ${DIM}— the marker landed here${RESET}`, cols));
  out += line(mid, centered(markerContext(cols), cols));
  out += line(mid + 2, centered(`${DIM}Ctrl+P resumes from the ${RESET}${GREEN}▶${RESET}${DIM} · ←/→ move it by response${RESET}`, cols));
  out += historyHint(cols, rows, mid);
  out += statusFooter(cols, rows, positionExtra());
  process.stdout.write(out);
}

function drawDone() {
  const { cols, rows, mid } = screenBase();
  const total = readCount || (doc ? doc.words.length : 0);
  let out = CSI + '2J';
  out += line(mid - 1, centered(`${GREEN}✓${RESET} ${BOLD}finished${RESET} — ${total} words`, cols));
  out += line(mid + 1, centered(`${DIM}${opts.follow ? 'Ctrl+P replay · waiting for the next response' : 'Ctrl+P replay · q quit'}${RESET}`, cols));
  out += statusFooter(cols, rows);
  process.stdout.write(out);
}

// Vertical layout of the playing frame: the band of rows it owns, with the
// guides as its top and bottom row. Every frame clears the whole band before
// painting it, so a word that steps down a scale — or falls back to plain
// text — can never leave fragments of a taller one behind. `scale` 0 is plain
// text, and keeps the original one-row layout inside the same band.
function frameBand(mid, scale) {
  const block = scale ? (GH * scale) / 2 : 1;
  const half = Math.max(3, Math.floor(block / 2) + 1);
  return { top: mid - half, bot: mid + half, block };
}

// The largest scale `size` allows that still fits the terminal's height.
function fitScale(rows, mid) {
  for (let s = size - 1; s >= 1; s--) {
    const b = frameBand(mid, s);
    if (b.top >= 1 && b.bot <= rows - 3) return s;
  }
  return 0;
}

function drawFrame() {
  const { cols, rows, mid } = screenBase();
  const pivot = Math.floor(cols / 2);
  const word = doc.words[Math.min(idx, doc.words.length - 1)] || '';
  const orp = Math.min(orpIndex(word.length), Math.max(0, word.length - 1));

  const scale = fitScale(rows, mid);
  const band = frameBand(mid, scale);
  const put = (r, s) => (r >= 1 && r <= rows ? line(r, s) : '');

  const gw = Math.min(41, Math.max(11, cols - 4));
  const gLeft = pivot - Math.floor(gw / 2);
  const guide = (tick) => {
    let s = '';
    for (let c = 0; c < gw; c++) s += (gLeft + c === pivot) ? tick : '─';
    return ' '.repeat(Math.max(0, gLeft)) + DIM + s + RESET;
  };

  // Block letters whenever they fit beside the pivot. A long word steps down a
  // scale first, and only then falls back to plain text, which truncates it.
  let block = null;
  for (let s = scale; s >= 1 && !block; s--) block = bigWordRows(word, orp, pivot, cols, s);

  let out = '';
  for (let r = band.top; r <= band.bot; r++) out += put(r, '');
  if (block) {
    const top = band.top + 1 + Math.floor((band.bot - band.top - 1 - block.length) / 2);
    block.forEach((s, i) => { out += put(top + i, s); });
    out += put(band.top, guide('┬'));
    out += put(band.bot, guide('┴'));
  } else {
    // Truncate a word too wide to fit right of the pivot (URLs, long paths).
    let w = word;
    const maxw = Math.max(5, pivot - 3);
    if (w.length > maxw) w = w.slice(0, maxw - 1) + '…';
    const o = Math.min(orpIndex(w.length), Math.max(0, w.length - 1));
    out += put(mid, ' '.repeat(Math.max(1, pivot - o)) + w.slice(0, o) + RED + BOLD + (w[o] || '') + RESET + w.slice(o + 1));
    out += put(mid - 2, guide('┬'));
    out += put(mid + 2, guide('┴'));
  }

  const total = doc.words.length;
  const pct = total ? Math.round((idx / total) * 100) : 0;
  const remaining = (doc.cum[total] - doc.cum[Math.min(idx, total)]) * baseDelay() / 1000;
  out += line(rows - 2, centered(`${BOLD}${wpm}${RESET}${DIM} wpm  ·  ${Math.min(idx + 1, total)}/${total} (${pct}%)  ·  ~${fmtTime(remaining)} left${RESET}`, cols));
  out += line(rows - 1, centered(HINTS, cols));
  process.stdout.write(out);
}

function redraw() {
  if (mode === 'playing') drawFrame();
  else if (mode === 'paused') drawPaused();
  else if (mode === 'ready') drawReady();
  else if (mode === 'done') drawDone();
  else if (mode === 'waiting') drawWaiting();
}

// ---------------------------------------------------------------- playback

function startPlay() {
  if (!doc || !doc.words.length) return;
  if (idx >= doc.words.length) idx = turnStartAt(doc.words.length - 1); // past the end: newest response
  mode = 'playing';
  process.stdout.write(CSI + '2J');
  tick();
}

function tick() {
  if (mode !== 'playing') return;
  drawFrame();
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (mode !== 'playing') return;
    idx++;
    if (idx >= doc.words.length) finish();
    else tick();
  }, delayFor(idx));
}

function pause() {
  if (mode !== 'playing') return;
  clearTimeout(timer);
  mode = 'paused'; // idx stays put: that's where the marker lands
  drawPaused();
}

function finish() {
  clearTimeout(timer);
  const end = idx;                          // one past the last word played
  idx = turnStartAt(Math.max(0, end - 1));  // marker back to the top of what you just read
  readCount = end - idx;
  mode = 'done';
  drawDone();
}

function jumpSentence(dir) {
  if (!doc || mode === 'waiting') return;
  const ss = doc.sentenceStarts;
  if (dir < 0) {
    let cur = 0;
    for (const v of ss) { if (v <= idx) cur = v; else break; }
    idx = (idx - cur > 2) ? cur : (ss.filter(v => v < cur).pop() ?? 0);
  } else {
    const next = ss.find(v => v > idx);
    idx = next ?? doc.words.length - 1;
  }
  if (mode === 'playing') tick();
  else { if (mode === 'done') mode = 'paused'; redraw(); }
}

// Response-level movement. Sentence steps alone would mean hundreds of presses
// to cross a long session, so ←/→ hop whole responses; like ↑, ← first snaps to
// the top of the response you're inside.
function jumpTurn(dir) {
  if (!doc || mode === 'waiting' || !turnStarts.length) return;
  const cur = turnStartAt(idx);
  if (dir < 0) idx = (idx - cur > 2) ? cur : (turnStarts.filter(v => v < cur).pop() ?? 0);
  else idx = turnStarts.find(v => v > cur) ?? cur;
  if (mode === 'playing') tick();
  else { if (mode === 'done') mode = 'paused'; redraw(); }
}

// ---------------------------------------------------------------- keys

// Holding an arrow down delivers several escape sequences in one read while we
// are busy drawing. Split those bursts so every press counts — walking back
// through a session means a lot of arrow presses. Anything not starting with
// ESC (a paste, say) is left alone and ignored as one unknown key.
function splitKeys(s) {
  if (s[0] !== '\x1b' || s.length <= 3) return [s];
  return s.match(/\x1b\[[0-9;]*[A-Za-z~]|\x1b.|[\s\S]/g) || [s];
}

function onKey(data) {
  for (const k of splitKeys(data.toString('utf8'))) handleKey(k);
}

function handleKey(s) {
  if (s === '\x03' || s === 'q' || s === 'Q' || s === '\x1b') { cleanup(); process.exit(0); }
  if (s === '\x10' || s === 'p' || s === 'P') {           // Ctrl+P: play from marker / speed up
    if (mode === 'playing') { wpm = Math.min(1500, wpm + step); drawFrame(); }
    else startPlay();
    return;
  }
  if (s === '\x0f' || s === 'o' || s === 'O') { pause(); return; }  // Ctrl+O: marker lands here
  if (s === '\t' || s === 'i' || s === 'I') {             // Ctrl+I (arrives as Tab): slow down
    wpm = Math.max(60, wpm - step);
    redraw();
    return;
  }
  if (s === '\x1b[D') { jumpTurn(-1); return; }   // ←: previous response
  if (s === '\x1b[C') { jumpTurn(1); return; }    // →: next response
  if (s === '\x1b[A') { jumpSentence(-1); return; }
  if (s === '\x1b[B') { jumpSentence(1); return; }
  if (s === 'r' || s === 'R') { if (doc) { idx = turnStartAt(idx); startPlay(); } return; } // restart this response
}

// ---------------------------------------------------------------- config live reload

// Apply only fields that changed in the file, so a /speedread wpm change lands
// without stomping adjustments made via keys, and vice versa.
function pollConfig() {
  let m = 0;
  try { m = fs.statSync(CONFIG_PATH).mtimeMs; } catch { return; }
  if (m === cfgMtime) return;
  cfgMtime = m;
  const fresh = normalizeConfig(loadConfigFile());
  if (fresh.wpm !== lastCfg.wpm) { wpm = fresh.wpm; }
  if (fresh.step !== lastCfg.step) { step = fresh.step; }
  if (fresh.autoplay !== lastCfg.autoplay) { autoplay = fresh.autoplay; }
  if (fresh.size !== lastCfg.size) { size = fresh.size; }
  if (fresh.size !== lastCfg.size) { size = fresh.size; }
  lastCfg = fresh;
  if (mode !== 'playing') redraw(); else drawFrame();
}

// ---------------------------------------------------------------- follow mode

// Swap in a new session document. Word indices of earlier responses never move
// when a response is appended or the newest one grows, so the marker survives.
function setTurns(next) {
  turns = next;
  doc = tokenizeTurns(next);
  turnStarts = doc.turnStarts;
  // Transcripts only ever grow, but if one somehow shrank, don't strand the
  // marker past the end of the document and render nonsense.
  if (idx >= doc.words.length) idx = turnStartAt(Math.max(0, doc.words.length - 1));
}

// Adopt a freshly read session. The rule that keeps the backlog usable: the
// marker only jumps to a new response when it was already sitting in the newest
// one. If you've walked back to read something older, new arrivals land quietly
// at the end of the document and wait for you there.
function ingestTurns(next) {
  if (!next.length) return;
  const prevCount = turns.length;
  const sameLast = prevCount > 0 && next.length === prevCount
    && next[next.length - 1] === turns[prevCount - 1];
  if (sameLast) return;                                    // nothing changed on disk that we care about

  const grew = prevCount > 0 && next.length === prevCount
    && next[next.length - 1].startsWith(turns[prevCount - 1]);
  const atNewest = prevCount === 0 || idx >= turnStarts[turnStarts.length - 1];
  const prevTotal = doc ? doc.words.length : 0;
  const wasDone = mode === 'done';

  setTurns(next);
  if (!atNewest) { redraw(); return; }  // you're reading the backlog: never yank the marker

  if (grew) {
    // The same response grew (Claude kept working after a text block): continue
    // from where the previous block ended instead of replaying it.
    if (!wasDone) { redraw(); return; } // ready/paused: marker stays, counts update
    idx = prevTotal;
    mode = 'ready';
    if (autoplay) startPlay(); else drawReady('response continued');
    return;
  }
  idx = turnStarts[turnStarts.length - 1]; // a new response: green marker at its start
  mode = 'ready';
  if (autoplay) startPlay(); else drawReady();
}

let followSig = null;    // path|mtime|size of the transcript as last read
let pendingTurns = null; // read but not yet adopted, waiting out one quiet poll

// Re-read the transcript only when it actually changed on disk: it's polled
// twice a second and a long session's file runs to megabytes.
function readTurnsIfChanged(file) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const sig = `${file}|${st.mtimeMs}|${st.size}`;
  if (sig === followSig) return null;
  let next;
  try { next = extractClaudeTurns(file); } catch { return null; }
  followSig = sig;
  return next;
}

// Which transcript the companion follows. A --session pin never moves. Without
// a pin we latch onto the newest file at startup and only ever switch to a
// transcript CREATED after the companion started (a fresh Claude session in
// this project) — never hop between two preexisting sessions on mtime alone.
const followStartMs = Date.now();
let latchedFile = null;

function chooseFollowFile() {
  const dir = claudeProjectDir();
  if (opts.session) {
    if (!latchedFile) latchedFile = transcriptForSession(dir, opts.session);
    return latchedFile;
  }
  if (latchedFile && !fs.existsSync(latchedFile)) latchedFile = null;
  const files = listTranscripts(dir);
  if (!latchedFile) { latchedFile = files.length ? files[0].p : null; return latchedFile; }
  const fresh = files.find(f => f.p !== latchedFile && f.b >= followStartMs && f.m > fs.statSync(latchedFile).mtimeMs);
  if (fresh) {
    latchedFile = fresh.p;
    turns = []; turnStarts = []; pendingTurns = null; followSig = null; doc = null; idx = 0;
    if (mode !== 'playing') { mode = 'waiting'; drawWaiting(); }
  }
  return latchedFile;
}

function pollFollow() {
  pollConfig();
  if (mode === 'playing') { setTimeout(pollFollow, 600); return; }
  let file = null;
  try { file = chooseFollowFile(); } catch { }
  if (file) {
    const fresh = readTurnsIfChanged(file);
    // Adopt only what the transcript then held still for a poll, so a response
    // is never grabbed mid-stream while Claude is still writing it.
    if (fresh) pendingTurns = fresh;
    else if (pendingTurns) { const next = pendingTurns; pendingTurns = null; ingestTurns(next); }
  }
  setTimeout(pollFollow, 600);
}

// ---------------------------------------------------------------- main

// Follow mode resolves its own text (the whole session, below); everything else
// is a single fixed document read once here.
let resolved = null;
if (!opts.follow) {
  try { resolved = resolveText(); }
  catch (e) { console.error('speedread: ' + e.message); process.exit(1); }
}

process.stdout.write(CSI + '?1049h' + CSI + '?25l' + CSI + '2J');
setupInput();
if (!inStream) {
  process.stdout.write(line(1, DIM + 'no keyboard input available — playing without controls' + RESET));
}
process.stdout.on('resize', redraw);

if (opts.follow) {
  // Load the session's whole backlog up front, so everything Claude has already
  // said in this conversation is reachable the moment the pane opens — the
  // marker just starts at the newest response.
  let initial = [];
  try { const f = chooseFollowFile(); if (f) initial = readTurnsIfChanged(f) || []; } catch { }
  idx = 0;
  if (initial.length) {
    setTurns(initial);
    idx = turnStarts[turnStarts.length - 1];
    mode = 'ready';
    drawReady('last response'); // ready-to-read, but never autoplay old news
  } else {
    mode = 'waiting';
    drawWaiting();
  }
  setTimeout(pollFollow, 600);
} else {
  doc = tokenize(resolved.text);
  idx = 0;
  if (!doc.words.length) { cleanup(); console.error('speedread: nothing to read'); process.exit(1); }
  startPlay();
  // Config changes from /speedread still land live in one-shot modes.
  setInterval(pollConfig, 1000);
}
