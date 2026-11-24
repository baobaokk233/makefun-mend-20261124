// mend: one patch tool for every AI edit format, as SPEC.md specifies.
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// It reads four formats (unified diffs, SEARCH/REPLACE blocks, V4A patches and
// JSON tool calls), finds the lines an edit names at the first of three
// matching tiers, and changes every file or none. The last lines hand a trial
// over to runner.ts when MAKEFUN_ENV_URL is set: keep that hand-over and
// runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's lines, its line break and whether it ends with one (SPEC.md section 3). */
interface FileState {
  lines: string[];
  br: string;
  final: boolean;
}

function fileParts(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(st: FileState): string {
  if (st.lines.length === 0) return '';
  return st.lines.join(st.br) + (st.final ? st.br : '');
}

/** Matching lines at three tiers (SPEC.md section 5). */
function stripTrail(s: string): string {
  return s.replace(/[ \t]+$/, '');
}
function stripBoth(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}
function leadingWS(s: string): string {
  let k = 0;
  while (k < s.length && (s[k] === ' ' || s[k] === '\t')) k += 1;
  return s.slice(0, k);
}

/** Positions i >= from where O matches the file's lines at the tier.
 *  At tiers 1/2 each line is normalized at most once per call (a repeated-line
 *  file otherwise re-strips the same line at every position x every O line). */
function occurrencesAt(lines: string[], o: string[], tier: number, from: number, eofOnly: boolean): number[] {
  const out: number[] = [];
  const last = lines.length - o.length;
  if (tier === 0) {
    for (let i = from; i <= last; i += 1) {
      if (eofOnly && i + o.length !== lines.length) continue;
      let ok = true;
      for (let k = 0; k < o.length; k += 1) {
        if (lines[i + k]! !== o[k]!) {
          ok = false;
          break;
        }
      }
      if (ok) out.push(i);
    }
    return out;
  }
  const norm = tier === 1 ? stripTrail : stripBoth;
  const nl: (string | undefined)[] = new Array(lines.length);
  const no: (string | undefined)[] = new Array(o.length);
  const nline = (i: number): string => {
    let v = nl[i];
    if (v === undefined) {
      v = norm(lines[i]!);
      nl[i] = v;
    }
    return v;
  };
  const nold = (k: number): string => {
    let v = no[k];
    if (v === undefined) {
      v = norm(o[k]!);
      no[k] = v;
    }
    return v;
  };
  for (let i = from; i <= last; i += 1) {
    if (eofOnly && i + o.length !== lines.length) continue;
    let ok = true;
    for (let k = 0; k < o.length; k += 1) {
      if (nline(i + k) !== nold(k)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 when strict) with an occurrence. */
function findTier(
  lines: string[],
  o: string[],
  strict: boolean,
  from: number,
  eofOnly = false,
): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrencesAt(lines, o, t, from, eofOnly);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** The first line at or after `from` equal to the anchor, at the first tier with one. */
function findAnchor(lines: string[], anchor: string, strict: boolean, from: number): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i += 1) {
      if (lineEq(lines[i]!, anchor, t)) return i;
    }
  }
  return -1;
}

/** A line of N re-indented at tier 2 (SPEC.md section 5). */
function reindentLine(text: string, o: string[], fileLines: string[], pos: number, tier: number): string {
  if (tier !== 2) return text;
  if (text.trim() === '') return text;
  const f = leadingWS(fileLines[pos]!);
  const p = leadingWS(o[0]!);
  if (!text.startsWith(p)) return text;
  return f + text.slice(p.length);
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { from: string; to: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** One body line of a unified hunk or a V4A chunk: ' ' context, '-' old, '+' new. */
interface BodyLine {
  k: string;
  text: string;
}

/** Split a hunk/chunk body into old lines O and new lines N (context lines carry their O index). */
function splitBody(body: BodyLine[]): { o: string[]; n: { text: string; oIdx: number | null }[] } {
  const o: string[] = [];
  const n: { text: string; oIdx: number | null }[] = [];
  for (const b of body) {
    if (b.k === ' ') {
      o.push(b.text);
      n.push({ text: b.text, oIdx: o.length - 1 });
    } else if (b.k === '-') {
      o.push(b.text);
    } else if (b.k === '+') {
      n.push({ text: b.text, oIdx: null });
    }
  }
  return { o, n };
}

/** The replacement lines for an occurrence at `pos` at `tier`: context lines are the file's own. */
function replacementLines(
  n: { text: string; oIdx: number | null }[],
  o: string[],
  fileLines: string[],
  pos: number,
  tier: number,
): string[] {
  const out: string[] = [];
  for (const ni of n) {
    if (ni.oIdx !== null) out.push(fileLines[pos + ni.oIdx]!);
    else out.push(reindentLine(ni.text, o, fileLines, pos, tier));
  }
  return out;
}

/* ---- Unified diffs (SPEC.md section 6) ---- */

interface Hunk {
  a: number;
  body: BodyLine[];
  noEol: boolean;
}

interface UniSection {
  pairOld?: string | null;
  pairNew?: string | null;
  renameOld?: string;
  renameNew?: string;
  diffOld?: string;
  diffNew?: string;
  creation: boolean;
  deletion: boolean;
  hunks: Hunk[];
}

/** The path of a `--- ` / `+++ ` line, or null for /dev/null. */
function uniPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  if (p === '/dev/null') return null;
  return p;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let header = false;
  const n = lines.length;
  const diffRe = /^diff --git a\/(\S+) b\/(\S+)[ \t]*$/;
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const startSection = (s: UniSection): void => {
    sections.push(s);
    cur = s;
    header = true;
  };
  let i = 0;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = l.match(diffRe);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection({ diffOld: m[1]!, diffNew: m[2]!, creation: false, deletion: false, hunks: [] });
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && header) {
        if (cur.pairOld === undefined) {
          cur.pairOld = uniPath(l);
          cur.pairNew = uniPath(lines[i + 1]!);
        }
        i += 2;
        continue;
      }
      startSection({ pairOld: uniPath(l), pairNew: uniPath(lines[i + 1]!), creation: false, deletion: false, hunks: [] });
      i += 2;
      continue;
    }
    if (l.startsWith('--- ') && cur !== null && header) {
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = l.match(hunkRe);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseInt(m[1]!, 10);
      i += 1;
      const body: BodyLine[] = [];
      while (i < n) {
        const b = lines[i]!;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') {
          body.push({ k: b === '' ? ' ' : b[0]!, text: b === '' ? '' : b.slice(1) });
          i += 1;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1]!.k === ' ' && body[body.length - 1]!.text === '') body.pop();
      let noEol = false;
      for (let j = body.length - 1; j >= 0; j -= 1) {
        if (body[j]!.k === ' ' || body[j]!.k === '+') {
          noEol = j + 1 < body.length && body[j + 1]!.k === '\\';
          break;
        }
      }
      cur.hunks.push({ a, body, noEol });
      header = false;
      continue;
    }
    if (cur !== null && header) {
      if (l.startsWith('rename from ')) cur.renameOld = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) cur.renameNew = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) cur.creation = true;
      else if (l.startsWith('deleted file mode')) cur.deletion = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

function applyUnifiedHunk(st: FileState, h: Hunk, d: number, strict: boolean, path: string): FileState {
  const { o, n } = splitBody(h.body);
  if (o.length === 0) {
    const at = Math.min(Math.max(h.a + d, 0), st.lines.length);
    const newLines = [...st.lines.slice(0, at), ...n.map((x) => x.text), ...st.lines.slice(at)];
    const final = at === st.lines.length ? !h.noEol : st.final;
    return { lines: newLines, br: st.br, final };
  }
  const found = findTier(st.lines, o, strict, 0);
  if (found === null) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let best = found.occ[0]!;
  let bestDist = Math.abs(best - target);
  for (const p of found.occ) {
    const dist = Math.abs(p - target);
    if (dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  const rep = replacementLines(n, o, st.lines, best, found.tier);
  const newLines = [...st.lines.slice(0, best), ...rep, ...st.lines.slice(best + o.length)];
  const runsToEnd = best + o.length === st.lines.length;
  const final = runsToEnd ? !h.noEol : st.final;
  return { lines: newLines, br: st.br, final };
}

function unifiedEdit(sec: UniSection, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.pairOld !== undefined ? sec.pairOld : sec.renameOld !== undefined ? sec.renameOld : sec.diffOld;
    const newP = sec.pairNew !== undefined ? sec.pairNew : sec.renameNew !== undefined ? sec.renameNew : sec.diffNew;
    if (oldP === undefined || newP === undefined) return;
    const creation = oldP === null || sec.creation;
    const deletion = !creation && (newP === null || sec.deletion);
    if (creation) {
      if (newP === null) return;
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const addLines: string[] = [];
      let lastPlus: { h: Hunk; j: number } | null = null;
      for (const h of sec.hunks) {
        for (let j = 0; j < h.body.length; j += 1) {
          if (h.body[j]!.k === '+') {
            addLines.push(h.body[j]!.text);
            lastPlus = { h, j };
          }
        }
      }
      let noEol = false;
      if (lastPlus !== null) {
        const { h, j } = lastPlus;
        noEol = j + 1 < h.body.length && h.body[j + 1]!.k === '\\';
      }
      tree.now.set(newP, addLines.length === 0 ? '' : addLines.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (deletion) {
      if (oldP === null) return;
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP === null || newP === null) return;
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== oldP && !safe(newP)) throw new Fail('unsafe', newP);
    const cur = tree.get(oldP);
    if (cur === null) throw new Fail('missing', oldP);
    if (newP !== oldP && tree.get(newP) !== null) throw new Fail('exists', newP);
    let st = fileParts(cur);
    let d = 0;
    for (const h of sec.hunks) {
      const { o, n } = splitBody(h.body);
      st = applyUnifiedHunk(st, h, d, strict, oldP);
      d += n.length - o.length;
    }
    const out = joinFile(st);
    if (newP !== oldP) {
      tree.now.set(newP, out);
      tree.now.set(oldP, null);
      tree.moves.push({ from: oldP, to: newP });
    } else {
      tree.now.set(oldP, out);
    }
  };
}

/* ---- SEARCH/REPLACE blocks (SPEC.md section 7) ---- */

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  interface Block {
    path: string;
    old: string[];
    next: string[];
  }
  const blocks: Block[] = [];
  let prevReplace = -1;
  let i = 0;
  while (i < lines.length) {
    let s = -1;
    for (let k = i; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') {
        s = k;
        break;
      }
    }
    if (s < 0) break;
    let eq = -1;
    for (let k = s + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '=======') {
        eq = k;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let k = eq + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    let path: string | null = null;
    for (let j = s - 1; j > prevReplace; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (blocks.length === 0) throw new Exit2(`error: parse ${s + 1}`);
      path = blocks[blocks.length - 1]!.path;
    }
    blocks.push({ path, old: lines.slice(s + 1, eq), next: lines.slice(eq + 1, rep) });
    prevReplace = rep;
    i = rep + 1;
  }
  return blocks.map((b) => {
    const path = b.path;
    const old = b.old;
    const next = b.next;
    return (tree: Tree): void => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (old.length === 0) {
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, next.length === 0 ? '' : next.join('\n') + '\n');
        return;
      }
      const cur = tree.get(path);
      if (cur === null) throw new Fail('missing', path);
      const st = fileParts(cur);
      const found = findTier(st.lines, old, strict, 0);
      if (found === null) throw new Fail('no-match', path);
      if (found.occ.length > 1) throw new Fail('ambiguous', path);
      const pos = found.occ[0]!;
      const rep = next.map((t) => reindentLine(t, old, st.lines, pos, found.tier));
      const newLines = [...st.lines.slice(0, pos), ...rep, ...st.lines.slice(pos + old.length)];
      tree.now.set(path, joinFile({ lines: newLines, br: st.br, final: st.final }));
    };
  });
}

/* ---- V4A patches (SPEC.md section 8) ---- */

interface V4aChunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

interface V4aRaw {
  kind: string;
  path: string;
  start: number;
  lines: number[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = n - 1; i >= 0; i -= 1) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const raws: V4aRaw[] = [];
  let cur: V4aRaw | null = null;
  for (let i = first + 1; i < last; i += 1) {
    const l = lines[i]!;
    if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) {
      const kind = l.startsWith('*** Add File: ') ? 'add' : l.startsWith('*** Delete File: ') ? 'delete' : 'update';
      const prefix = kind === 'add' ? '*** Add File: ' : kind === 'delete' ? '*** Delete File: ' : '*** Update File: ';
      cur = { kind, path: l.slice(prefix.length).trim(), start: i, lines: [] };
      raws.push(cur);
    } else if (cur === null) {
      if (!blank(l)) throw new Exit2(`error: parse ${i + 1}`);
    } else {
      cur.lines.push(i);
    }
  }
  const edits: Edit[] = [];
  for (const r of raws) {
    while (r.lines.length > 0 && blank(lines[r.lines[r.lines.length - 1]!]!)) r.lines.pop();
    if (r.kind === 'add') {
      const fileLines: string[] = [];
      for (const idx of r.lines) {
        const l = lines[idx]!;
        if (l.startsWith('+')) fileLines.push(l.slice(1));
        else if (l === '') fileLines.push('');
        else throw new Exit2(`error: parse ${idx + 1}`);
      }
      const path = r.path;
      edits.push((tree: Tree): void => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
    } else if (r.kind === 'delete') {
      if (r.lines.length > 0) throw new Exit2(`error: parse ${r.lines[0]! + 1}`);
      const path = r.path;
      edits.push((tree: Tree): void => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      edits.push(v4aUpdateEdit(r, lines, strict));
    }
  }
  return edits;
}

function v4aUpdateEdit(r: V4aRaw, lines: string[], strict: boolean): Edit {
  let moveTo: string | undefined;
  const chunks: V4aChunk[] = [];
  let cur: V4aChunk | null = null;
  for (let k = 0; k < r.lines.length; k += 1) {
    const idx = r.lines[k]!;
    const l = lines[idx]!;
    if (k === 0 && l.startsWith('*** Move to: ')) {
      moveTo = l.slice('*** Move to: '.length).trim();
      continue;
    }
    if (l.startsWith('@@')) {
      cur = { anchor: l.slice(2).trim(), body: [], eof: false };
      chunks.push(cur);
      continue;
    }
    if (l === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${idx + 1}`);
      cur.eof = true;
      cur = null;
      continue;
    }
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (cur === null) {
        if (chunks.length === 0) {
          cur = { anchor: null, body: [], eof: false };
          chunks.push(cur);
        } else throw new Exit2(`error: parse ${idx + 1}`);
      }
      cur.body.push({ k: l === '' ? ' ' : l[0]!, text: l === '' ? '' : l.slice(1) });
      continue;
    }
    throw new Exit2(`error: parse ${idx + 1}`);
  }
  if (chunks.length === 0 && moveTo === undefined) throw new Exit2(`error: parse ${r.start + 1}`);
  const path = r.path;
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== undefined && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const curText = tree.get(path);
    if (curText === null) throw new Fail('missing', path);
    if (moveTo !== undefined && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let st = fileParts(curText);
    let cursor = 0;
    for (const chunk of chunks) {
      const res = applyV4aChunk(st, chunk, cursor, strict, path);
      st = res.st;
      cursor = res.cursor;
    }
    const out = joinFile(st);
    if (moveTo !== undefined) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      tree.moves.push({ from: path, to: moveTo });
    } else {
      tree.now.set(path, out);
    }
  };
}

function applyV4aChunk(
  st: FileState,
  chunk: V4aChunk,
  cursor: number,
  strict: boolean,
  path: string,
): { st: FileState; cursor: number } {
  let cur = cursor;
  if (chunk.anchor !== null && chunk.anchor !== '') {
    const idx = findAnchor(st.lines, chunk.anchor, strict, cur);
    if (idx < 0) throw new Fail('no-match', path);
    cur = idx + 1;
  }
  const { o, n } = splitBody(chunk.body);
  if (o.length === 0) {
    const at = chunk.eof ? st.lines.length : cur;
    const newLines = [...st.lines.slice(0, at), ...n.map((x) => x.text), ...st.lines.slice(at)];
    return { st: { lines: newLines, br: st.br, final: st.final }, cursor: at + n.length };
  }
  const found = findTier(st.lines, o, strict, cur, chunk.eof);
  if (found === null) throw new Fail('no-match', path);
  const pos = found.occ[0]!;
  const rep = replacementLines(n, o, st.lines, pos, found.tier);
  const newLines = [...st.lines.slice(0, pos), ...rep, ...st.lines.slice(pos + o.length)];
  return { st: { lines: newLines, br: st.br, final: st.final }, cursor: pos + rep.length };
}

/* ---- Invocation, output and exit codes (SPEC.md sections 1, 2 and 10) ---- */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  interface Row {
    key: string;
    line: string;
  }
  const rows: Row[] = [];
  const movedFrom = new Set<string>();
  const movedTo = new Set<string>();
  for (const m of tree.moves) {
    const wasOld = tree.original(m.from);
    const nowOld = tree.get(m.from);
    const wasNew = tree.original(m.to);
    const nowNew = tree.get(m.to);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: m.to, line: `R ${m.from} -> ${m.to}` });
      movedFrom.add(m.from);
      movedTo.add(m.to);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (movedFrom.has(p) || movedTo.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      if (tree.now.get(p) === null && tree.original(p) !== null) rmSync(p, { force: true });
    }
    for (const p of [...tree.now.keys()]) {
      const now = tree.now.get(p)!;
      if (now !== null && tree.original(p) !== now) {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
