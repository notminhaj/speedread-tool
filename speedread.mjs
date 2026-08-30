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
//   left/right  jump by sentence     r restart     q / Esc  quit
//
// Config (~/.speedread.json, live-reloaded): { "wpm": 300, "step": 25, "autoplay": false }

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
  const c = { wpm: 300, step: 25, autoplay: false, ...raw };
  c.wpm = Number.isFinite(c.wpm) ? Math.min(1500, Math.max(60, c.wpm)) : 300;
  c.step = Number.isFinite(c.step) ? Math.min(200, Math.max(5, c.step)) : 25;
  c.autoplay = !!c.autoplay;
  return c;
}
let lastCfg = normalizeConfig(loadConfigFile());
let cfgMtime = 0;
try { cfgMtime = fs.statSync(CONFIG_PATH).mtimeMs; } catch { }

// ---------------------------------------------------------------- args

const argv = process.argv.slice(2);
const opts = { wpm: null, file: null, clip: false, claude: false, follow: false, demo: false, help: false, session: null };
for (let a = 0; a < argv.length; a++) {
  const arg = argv[a];
  if (arg === '--wpm') { opts.wpm = parseInt(argv[++a], 10); }
  else if (arg.startsWith('--wpm=')) { opts.wpm = parseInt(arg.slice(6), 10); }
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
                                 Claude response; p plays from the marker
  speedread --claude             one-shot: play Claude Code's last response
  speedread <file> [--wpm 300]   read a text file
  <cmd> | speedread              read piped output
  speedread --clip               read the clipboard
  speedread --demo               built-in demo text

keys: Ctrl+P play/faster · Ctrl+O pause (marker lands there) · Ctrl+I slower
      left/right sentence · r restart · q quit
      (plain p/o/i also work — the pane has no text input, so they're free)
config: ~/.speedread.json  { "wpm": 300, "step": 25, "autoplay": false }
--session <id>: pin to one Claude session's transcript (prefix of its filename)`);
  process.exit(0);
}

let wpm = lastCfg.wpm;
let step = lastCfg.step;
let autoplay = lastCfg.autoplay;
if (Number.isFinite(opts.wpm)) wpm = Math.min(1500, Math.max(60, opts.wpm));

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

// Extract the text of Claude's latest turn: all assistant text blocks that come
// after the last real user message (tool results also arrive as "user" entries,
// so a user entry only counts when it carries actual text).
function extractLastClaudeResponse(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const entries = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch { /* trailing line may be mid-write */ }
  }
  let lastUser = -1;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.type !== 'user' || e.isSidechain || e.isMeta) continue;
    const c = e.message && e.message.content;
    const isReal = typeof c === 'string'
      || (Array.isArray(c) && c.some(x => x && x.type === 'text'));
    if (isReal) lastUser = i;
  }
  const parts = [];
  for (let i = lastUser + 1; i < entries.length; i++) {
    const e = entries[i];
    if (e.type !== 'assistant' || e.isSidechain) continue;
    const c = e.message && e.message.content;
    if (!Array.isArray(c)) continue;
    for (const item of c) {
      if (item && item.type === 'text' && item.text) parts.push(item.text);
    }
  }
  return stripMarkdown(parts.join('\n\n')).trim();
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

function tokenize(text) {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const mults = words.map(multiplierFor);
  const cum = [0];
  for (let i = 0; i < mults.length; i++) cum.push(cum[i] + mults[i]);
  const sentenceStarts = [0];
  for (let i = 0; i < words.length - 1; i++) {
    if (/[.!?…]["')\]}»”’]*$/.test(words[i])) sentenceStarts.push(i + 1);
  }
  return { words, mults, cum, sentenceStarts };
}

// ---------------------------------------------------------------- non-interactive fallback

// When stdout isn't a terminal there is nothing to animate: print the resolved
// text and its stats instead (this is also the scriptable/smoke-test mode).
if (!process.stdout.isTTY) {
  try {
    const { text, label } = resolveText();
    const { words, cum } = tokenize(text);
    const secs = (cum[words.length] * 60000 / wpm) / 1000;
    process.stdout.write(text + '\n');
    process.stdout.write(`\n[speedread] source=${label} words=${words.length} wpm=${wpm} step=${step} autoplay=${autoplay} est=${Math.round(secs)}s\n`);
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
//        -> playing <-> paused (marker lands at pause point) -> done (marker back at start)
// `idx` is both the playhead and the marker: when not playing, idx IS the marker.

let doc = null;
let idx = 0;
let mode = 'idle';
let timer = null;
let turnText = '';   // follow: full text of the turn currently tracked
let prevPoll = null; // follow: previous poll result, for stability check

function baseDelay() { return 60000 / wpm; }
function delayFor(i) { return Math.max(20, doc.mults[i] * baseDelay()); }

function fmtTime(secs) {
  secs = Math.max(0, Math.round(secs));
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
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

const HINTS = `${DIM}^P play/faster · ^O pause · ^I slower · ←/→ sentence · r restart · q quit${RESET}`;

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

function drawReady(label) {
  const { cols, rows, mid } = screenBase();
  const total = doc.words.length;
  const remaining = (doc.cum[total] - doc.cum[idx]) * baseDelay() / 1000;
  let out = CSI + '2J';
  out += line(mid - 2, centered(`${GREEN}${BOLD}▶ ${label || 'response ready'}${RESET}`, cols));
  out += line(mid, centered(markerContext(cols), cols));
  out += line(mid + 2, centered(`${DIM}${total - idx} words from the marker · ~${fmtTime(remaining)} at ${wpm} wpm · press Ctrl+P${RESET}`, cols));
  out += statusFooter(cols, rows, `${idx + 1}/${total}`);
  process.stdout.write(out);
}

function drawPaused() {
  const { cols, rows, mid } = screenBase();
  const total = doc.words.length;
  let out = CSI + '2J';
  out += line(mid - 2, centered(`${BOLD}⏸ paused${RESET} ${DIM}— the marker landed here${RESET}`, cols));
  out += line(mid, centered(markerContext(cols), cols));
  out += line(mid + 2, centered(`${DIM}Ctrl+P resumes from the ${RESET}${GREEN}▶${RESET}${DIM} · ←/→ move it by sentence${RESET}`, cols));
  out += statusFooter(cols, rows, `${idx + 1}/${total}`);
  process.stdout.write(out);
}

function drawDone() {
  const { cols, rows, mid } = screenBase();
  const total = doc ? doc.words.length : 0;
  let out = CSI + '2J';
  out += line(mid - 1, centered(`${GREEN}✓${RESET} ${BOLD}finished${RESET} — ${total} words`, cols));
  out += line(mid + 1, centered(`${DIM}${opts.follow ? 'Ctrl+P replay · waiting for the next response' : 'Ctrl+P replay · q quit'}${RESET}`, cols));
  out += statusFooter(cols, rows);
  process.stdout.write(out);
}

function drawFrame() {
  const { cols, rows, mid } = screenBase();
  const pivot = Math.floor(cols / 2);

  let word = doc.words[Math.min(idx, doc.words.length - 1)] || '';
  // Truncate words too wide to fit right of the pivot (URLs, long paths).
  const maxw = Math.max(5, pivot - 3);
  if (word.length > maxw) word = word.slice(0, maxw - 1) + '…';
  const o = Math.min(orpIndex(word.length), Math.max(0, word.length - 1));
  const before = word.slice(0, o);
  const orp = word[o] || '';
  const after = word.slice(o + 1);

  const gw = Math.min(41, Math.max(11, cols - 4));
  const gLeft = pivot - Math.floor(gw / 2);
  const guide = (tick) => {
    let s = '';
    for (let c = 0; c < gw; c++) s += (gLeft + c === pivot) ? tick : '─';
    return ' '.repeat(Math.max(0, gLeft)) + DIM + s + RESET;
  };

  const startCol = Math.max(1, pivot - before.length);
  const wordLine = ' '.repeat(startCol) + before + RED + BOLD + orp + RESET + after;

  const total = doc.words.length;
  const pct = total ? Math.round((idx / total) * 100) : 0;
  const remaining = (doc.cum[total] - doc.cum[Math.min(idx, total)]) * baseDelay() / 1000;

  let out = '';
  out += line(mid - 2, guide('┬'));
  out += line(mid, wordLine);
  out += line(mid + 2, guide('┴'));
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
  if (idx >= doc.words.length) idx = 0;
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
  idx = 0; // marker back to the start for replay
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

// ---------------------------------------------------------------- keys

function onKey(data) {
  const s = data.toString('utf8');
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
  if (s === '\x1b[D') { jumpSentence(-1); return; }
  if (s === '\x1b[C') { jumpSentence(1); return; }
  if (s === 'r' || s === 'R') { if (doc) { idx = 0; startPlay(); } return; }
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
  lastCfg = fresh;
  if (mode !== 'playing') redraw(); else drawFrame();
}

// ---------------------------------------------------------------- follow mode

function adoptText(text, label) {
  turnText = text;
  doc = tokenize(text);
  mode = 'ready';
  if (autoplay) startPlay();
  else drawReady(label);
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
    turnText = ''; prevPoll = null; doc = null; idx = 0;
    if (mode !== 'playing') { mode = 'waiting'; drawWaiting(); }
  }
  return latchedFile;
}

function pollFollow() {
  pollConfig();
  if (mode === 'playing') { setTimeout(pollFollow, 600); return; }
  let text = '';
  try { const f = chooseFollowFile(); if (f) text = extractLastClaudeResponse(f); } catch { }
  // Act only on text that is non-empty, different, and stable across two polls
  // (so we don't grab a turn mid-stream while Claude is still writing).
  if (text && text !== turnText && text === prevPoll) {
    prevPoll = null;
    if (turnText && text.startsWith(turnText)) {
      // The same turn grew (Claude kept working after a text block).
      const oldCount = doc ? doc.words.length : 0;
      const wasDone = mode === 'done';
      turnText = text;
      doc = tokenize(text);
      if (wasDone) { idx = oldCount; mode = 'ready'; if (autoplay) startPlay(); else drawReady('response continued'); }
      else redraw(); // ready/paused: marker stays where it was, counts update
    } else {
      // A brand-new response: green marker goes to its start.
      idx = 0;
      adoptText(text);
    }
  } else {
    prevPoll = text;
  }
  setTimeout(pollFollow, 600);
}

// ---------------------------------------------------------------- main

let resolved;
try { resolved = resolveText(); }
catch (e) {
  if (opts.follow) resolved = { text: '', label: 'claude' }; // no transcript yet: start waiting
  else { console.error('speedread: ' + e.message); process.exit(1); }
}

process.stdout.write(CSI + '?1049h' + CSI + '?25l' + CSI + '2J');
setupInput();
if (!inStream) {
  process.stdout.write(line(1, DIM + 'no keyboard input available — playing without controls' + RESET));
}
process.stdout.on('resize', redraw);

if (opts.follow) {
  idx = 0;
  if (resolved.text) {
    // Show the response that already finished as ready-to-read; don't autoplay old news.
    turnText = resolved.text;
    doc = tokenize(resolved.text);
    mode = 'ready';
    drawReady('last response');
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
