// mend adversarial stress suite: sealed-pool weaknesses the practice set does not cover.
// Run with: node --test stress.mjs  (Node 22, standard library only)
// Every expectation below is hand-computed from SPEC.md. A failure means either
// main.ts diverges from the spec or the expectation was mis-derived; re-read the
// spec section named in the test before changing either side.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAIN = join(dirname(fileURLToPath(import.meta.url)), 'main.ts');

function runCase(c) {
  const dir = mkdtempSync(join(tmpdir(), 'mend-stress-'));
  try {
    for (const [p, text] of Object.entries(c.files ?? {})) {
      const f = join(dir, ...p.split('/'));
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, text);
    }
    const start = Date.now();
    const r = spawnSync(process.execPath, [MAIN, ...(c.argv ?? [])], {
      cwd: dir,
      input: c.stdin ?? '',
      encoding: 'utf8',
      timeout: 10000,
    });
    const ms = Date.now() - start;
    const after = {};
    const walk = (d) => {
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        const st = statSync(p);
        if (st.isDirectory()) walk(p);
        else if (st.isFile()) after[relative(dir, p).split(sep).join('/')] = readFileSync(p, 'utf8');
      }
    };
    walk(dir);
    return { exit: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', files: after, ms };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** c: {argv, stdin, files}; want: {exit, stdout, changes} (changes override files, null deletes). */
function expectCase(name, c, want) {
  test(name, () => {
    const got = runCase(c);
    const expectedFiles = { ...(c.files ?? {}) };
    for (const [p, v] of Object.entries(want.changes ?? {})) {
      if (v === null) delete expectedFiles[p];
      else expectedFiles[p] = v;
    }
    assert.equal(got.exit, want.exit, `exit (stdout ${JSON.stringify(got.stdout)} stderr ${JSON.stringify(got.stderr)})`);
    assert.equal(got.stdout, want.stdout);
    assert.deepEqual(got.files, expectedFiles);
  });
}

const SR = (oldLines, newLines, path = 'f.txt') =>
  `${path}\n<<<<<<< SEARCH\n${oldLines}=======\n${newLines}>>>>>>> REPLACE\n`;

/* ---- CLI: options, precedence, --format, --strict ---- */

expectCase('cli: --format=auto explicit works', { argv: ['--format=auto', '-'], stdin: SR('old\n', 'new\n'), files: { 'f.txt': 'old\n' } },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'new\n' } });
expectCase('cli: --format without equals is usage', { argv: ['--format', '-'], stdin: '', files: {} },
  { exit: 2, stdout: 'error: usage\n', changes: {} });
expectCase('cli: --format= empty is usage', { argv: ['--format=', '-'], stdin: '', files: {} },
  { exit: 2, stdout: 'error: usage\n', changes: {} });
expectCase('cli: --format=JSON uppercase is usage', { argv: ['--format=JSON', '-'], stdin: '', files: {} },
  { exit: 2, stdout: 'error: usage\n', changes: {} });
expectCase('cli: --format given twice is usage', { argv: ['--format=json', '--format=unified', '-'], stdin: '', files: {} },
  { exit: 2, stdout: 'error: usage\n', changes: {} });
expectCase('cli: unknown long option --chek is usage', { argv: ['--chek', '-'], stdin: '', files: {} },
  { exit: 2, stdout: 'error: usage\n', changes: {} });
expectCase('cli: single-dash option -x is usage', { argv: ['-x'], stdin: '', files: {} },
  { exit: 2, stdout: 'error: usage\n', changes: {} });
expectCase('cli: usage beats no-patch', { argv: ['--bogus', 'missing.patch'], files: {} },
  { exit: 2, stdout: 'error: usage\n', changes: {} });
expectCase('cli: no-patch beats format', { argv: ['missing.patch'], files: {} },
  { exit: 2, stdout: 'error: no-patch\n', changes: {} });
expectCase('cli: patch file that is a directory is no-patch', { argv: ['d'], files: { 'd/x.txt': 'x\n' } },
  { exit: 2, stdout: 'error: no-patch\n', changes: {} });
expectCase('cli: dash-leading patch filename after -- works', {
  argv: ['--', '-x.patch'],
  files: { '-x.patch': SR('old\n', 'new\n'), 'f.txt': 'old\n' },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'new\n' } });
expectCase('cli: parse error beats missing file', {
  argv: ['-'],
  stdin: 'diff --git a/g.txt b/g.txt\n--- a/g.txt\n+++ b/g.txt\n@@ bad\n-a\n+A\n',
  files: {},
}, { exit: 2, stdout: 'error: parse 4\n', changes: {} });
expectCase('cli: --format=json on unified text is parse 1', {
  argv: ['--format=json', '-'],
  stdin: 'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-a\n+A\n',
  files: { 'f.txt': 'a\n' },
}, { exit: 2, stdout: 'error: parse 1\n', changes: {} });
expectCase('cli: --check creates nothing', {
  argv: ['--check', '-'],
  stdin: 'a/b/c/new.txt\n<<<<<<< SEARCH\n=======\ndeep\n>>>>>>> REPLACE\n',
  files: {},
}, { exit: 0, stdout: 'A a/b/c/new.txt\nok: 1 file\n', changes: {} });
expectCase('cli: empty stdin with explicit format is parse 1', { argv: ['--format=search-replace', '-'], stdin: '', files: {} },
  { exit: 2, stdout: 'error: parse 1\n', changes: {} });
expectCase('cli: --strict blocks tier-1 S/R match', {
  argv: ['--strict', '-'], stdin: SR('foo\n', 'bar\n'), files: { 'f.txt': 'foo  \n' },
}, { exit: 1, stdout: 'error: no-match f.txt\nfailed: 1 of 1 edits\n', changes: {} });
expectCase('cli: --strict blocks tier-2 V4A anchor', {
  argv: ['--strict', 'p.txt'],
  files: {
    'p.txt': '*** Begin Patch\n*** Update File: f.py\n@@ def f():\n-  x = 1\n+  x = 2\n*** End Patch\n',
    'f.py': '  def f():\n  x = 1\n',
  },
}, { exit: 1, stdout: 'error: no-match f.py\nfailed: 1 of 1 edits\n', changes: {} });

/* ---- Unified: tiers, nearest, d, backslash, sections ---- */

expectCase('unified: tier 0 beats a nearer tier 2 occurrence', {
  argv: ['-'],
  stdin: 'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-bar\n+BAR\n',
  files: { 'f.txt': '  bar\na\nb\nbar\n' },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': '  bar\na\nb\nBAR\n' } });
expectCase('unified: A=0 with non-empty O replaces the first line', {
  argv: ['-'],
  stdin: 'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -0,1 +0,1 @@\n-a\n+A\n',
  files: { 'f.txt': 'a\nb\n' },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'A\nb\n' } });
expectCase('unified: backslash after a - line does not remove the final break', {
  argv: ['-'],
  stdin: 'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -3,1 +3,0 @@\n-c\n\\ No newline at end of file\n',
  files: { 'f.txt': 'a\nb\nc' },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'a\nb\n' } });
expectCase('unified: deleting the last line of a file that ends with a break', {
  argv: ['-'],
  stdin: 'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -3,1 +3,0 @@\n-c\n',
  files: { 'f.txt': 'a\nb\nc\n' },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'a\nb\n' } });
expectCase('unified: creation ignores context lines in hunks', {
  argv: ['-'],
  stdin: 'diff --git a/n.txt b/n.txt\nnew file mode 100644\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,3 @@\n ctx\n+one\n+two\n',
  files: {},
}, { exit: 0, stdout: 'A n.txt\nok: 1 file\n', changes: { 'n.txt': 'one\ntwo\n' } });
expectCase('unified: creation with no hunks makes an empty file', {
  argv: ['-'],
  stdin: 'diff --git a/n.txt b/n.txt\nnew file mode 100644\n--- /dev/null\n+++ b/n.txt\n',
  files: {},
}, { exit: 0, stdout: 'A n.txt\nok: 1 file\n', changes: { 'n.txt': '' } });
expectCase('unified: change with no hunks on an existing file is a no-op', {
  argv: ['-'],
  stdin: 'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n',
  files: { 'f.txt': 'x\n' },
}, { exit: 0, stdout: 'ok: 0 files\n', changes: {} });
expectCase('unified: change with no hunks on a missing file is missing', {
  argv: ['-'],
  stdin: 'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n',
  files: {},
}, { exit: 1, stdout: 'error: missing f.txt\nfailed: 1 of 1 edits\n', changes: {} });
expectCase('unified: move with no hunks still moves', {
  argv: ['-'],
  stdin: 'diff --git a/o.txt b/n.txt\n--- a/o.txt\n+++ b/n.txt\n',
  files: { 'o.txt': 'same\n' },
}, { exit: 0, stdout: 'R o.txt -> n.txt\nok: 1 file\n', changes: { 'o.txt': null, 'n.txt': 'same\n' } });
expectCase('unified: lone --- line in prose is ignored', {
  argv: ['-'],
  stdin: 'note\n--- something\nmore prose\ndiff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-a\n+A\n',
  files: { 'f.txt': 'a\n' },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'A\n' } });
expectCase('unified: ---/+++ pair after a hunk starts a new section', {
  argv: ['-'],
  stdin: 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-a\n+A\n--- a/b.txt\n+++ b/b.txt\n@@ -1,1 +1,1 @@\n-b\n+B\n',
  files: { 'a.txt': 'a\n', 'b.txt': 'b\n' },
}, { exit: 0, stdout: 'M a.txt\nM b.txt\nok: 2 files\n', changes: { 'a.txt': 'A\n', 'b.txt': 'B\n' } });
expectCase('unified: diff --git with trailing text is a parse error', {
  argv: ['-'],
  stdin: 'diff --git a/f.txt b/f.txt extra\n--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-a\n+A\n',
  files: { 'f.txt': 'a\n' },
}, { exit: 2, stdout: 'error: parse 1\n', changes: {} });
expectCase('unified: hunk header without closing @@ is a parse error', {
  argv: ['-'],
  stdin: '--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,1\n-a\n+A\n',
  files: { 'f.txt': 'a\n' },
}, { exit: 2, stdout: 'error: parse 3\n', changes: {} });
expectCase('unified: hunk header with no counts works', {
  argv: ['-'],
  stdin: 'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1 +1 @@\n-a\n+A\n',
  files: { 'f.txt': 'a\n' },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'A\n' } });
expectCase('unified: hunk header with trailing section text works', {
  argv: ['-'],
  stdin: 'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@ func F\n-a\n+A\n',
  files: { 'f.txt': 'a\n' },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'A\n' } });
expectCase('unified: backslash line with other text still counts', {
  argv: ['-'],
  stdin: 'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -3,1 +3,1 @@\n-c\n+C\n\\ whatever\n',
  files: { 'f.txt': 'a\nb\nc' },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'a\nb\nC' } });
expectCase('unified: two sections, second fails, nothing written', {
  argv: ['-'],
  stdin: 'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-a\n+A\ndiff --git a/g.txt b/g.txt\n--- a/g.txt\n+++ b/g.txt\n@@ -1,1 +1,1 @@\n-g\n+G\n',
  files: { 'f.txt': 'a\n' },
}, { exit: 1, stdout: 'error: missing g.txt\nfailed: 1 of 2 edits\n', changes: {} });
expectCase('unified: hunk of only context lines changes nothing', {
  argv: ['-'],
  stdin: 'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1,2 +1,2 @@\n a\n b\n',
  files: { 'f.txt': 'a\nb\n' },
}, { exit: 0, stdout: 'ok: 0 files\n', changes: {} });
expectCase('unified: tier-1 nearest among two occurrences', {
  argv: ['-'],
  stdin: 'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -4,1 +4,1 @@\n-foo\n+FOO\n',
  files: { 'f.txt': 'foo  \nx\nfoo\t\ny\n' },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'foo  \nx\nFOO\ny\n' } });
expectCase('unified: empty-O insert into an empty file', {
  argv: ['-'],
  stdin: 'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -0,0 +1,1 @@\n+X\n',
  files: { 'f.txt': '' },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'X\n' } });
expectCase('unified: rename from a path with spaces', {
  argv: ['-'],
  stdin: 'diff --git a/x b/y\nrename from my file.txt\nrename to new file.txt\n',
  files: { 'my file.txt': 'x\n' },
}, { exit: 0, stdout: 'R my file.txt -> new file.txt\nok: 1 file\n', changes: { 'my file.txt': null, 'new file.txt': 'x\n' } });
expectCase('unified: header mode lines ignored', {
  argv: ['-'],
  stdin: 'diff --git a/o.txt b/n.txt\nold mode 100644\nnew mode 100755\nsimilarity index 90%\nrename from o.txt\nrename to n.txt\n',
  files: { 'o.txt': 'x\n' },
}, { exit: 0, stdout: 'R o.txt -> n.txt\nok: 1 file\n', changes: { 'o.txt': null, 'n.txt': 'x\n' } });
expectCase('unified: mixed line breaks, second line not matchable', {
  argv: ['-'],
  stdin: 'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -2,1 +2,1 @@\n-b\n+B\n',
  files: { 'f.txt': 'a\r\nb\nc\n' },
}, { exit: 1, stdout: 'error: no-match f.txt\nfailed: 1 of 1 edits\n', changes: {} });
expectCase('unified: empty first line replaced', {
  argv: ['-'],
  stdin: 'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n \n+X\n',
  files: { 'f.txt': '\nb\n' },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': '\nX\nb\n' } });
expectCase('unified: unsafe path with double slash after b/ strip', {
  argv: ['-'],
  stdin: 'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b//x.txt\n@@ -1,1 +1,1 @@\n-a\n+A\n',
  files: { 'f.txt': 'a\n' },
}, { exit: 1, stdout: 'error: unsafe /x.txt\nfailed: 1 of 1 edits\n', changes: {} });
expectCase('unified: d goes negative and clamps the insert to the top', {
  argv: ['-'],
  stdin: 'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1,3 +1,0 @@\n-l1\n-l2\n-l3\n@@ -2,0 +2,1 @@\n+X\n',
  files: { 'f.txt': 'l1\nl2\nl3\nl4\nl5\n' },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'X\nl4\nl5\n' } });
expectCase('unified: --- not followed by +++ in a header is parse at the next line', {
  argv: ['-'],
  stdin: 'diff --git a/f.txt b/f.txt\n--- a/f.txt\n\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-a\n+A\n',
  files: { 'f.txt': 'a\n' },
}, { exit: 2, stdout: 'error: parse 3\n', changes: {} });
expectCase('unified: second hunk sees the first hunk result', {
  argv: ['-'],
  stdin: 'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-a\n+A\n@@ -2,1 +2,1 @@\n-A\n+AA\n',
  files: { 'f.txt': 'a\nb\n' },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'AA\nb\n' } });
expectCase('unified: file with only a newline, empty line replaced', {
  argv: ['-'],
  stdin: 'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n \n+x\n',
  files: { 'f.txt': '\n' },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': '\nx\n' } });
expectCase('unified: CRLF file with empty-O insert at the end', {
  argv: ['-'],
  stdin: 'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -2,0 +3,1 @@\n+X\n',
  files: { 'f.txt': 'a\r\nb\r\n' },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'a\r\nb\r\nX\r\n' } });

/* ---- SEARCH/REPLACE: tiers, paths, markers ---- */

expectCase('sr: tier 0 beats tier 2, not ambiguous', {
  argv: ['p.txt'],
  files: { 'p.txt': SR('x\n', 'X\n'), 'f.txt': '  x\nx\n' },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': '  x\nX\n' } });
expectCase('sr: two tier-2 occurrences are ambiguous', {
  argv: ['p.txt'],
  files: { 'p.txt': SR('x\n', 'X\n'), 'f.txt': '  x\n\tx\n' },
}, { exit: 1, stdout: 'error: ambiguous f.txt\nfailed: 1 of 1 edits\n', changes: {} });
expectCase('sr: path line trimmed of surrounding spaces', {
  argv: ['p.txt'],
  files: { 'p.txt': '  f.txt  \n<<<<<<< SEARCH\na\n=======\nA\n>>>>>>> REPLACE\n', 'f.txt': 'a\n' },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'A\n' } });
expectCase('sr: fence with language skipped for path', {
  argv: ['p.txt'],
  files: { 'p.txt': '```diff\nf.txt\n<<<<<<< SEARCH\na\n=======\nA\n>>>>>>> REPLACE\n```\n', 'f.txt': 'a\n' },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'A\n' } });
expectCase('sr: ======= inside old lines ends the old part', {
  argv: ['p.txt'],
  files: {
    'p.txt': 'f.txt\n<<<<<<< SEARCH\na\n=======\nb\n=======\nA\n>>>>>>> REPLACE\n',
    'f.txt': 'a\n=======\nb\n',
  },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'b\n=======\nA\n=======\nb\n' } });
expectCase('sr: create keeps trailing spaces in new lines', {
  argv: ['p.txt'],
  files: { 'p.txt': 'new.txt\n<<<<<<< SEARCH\n=======\nx  \n>>>>>>> REPLACE\n' },
}, { exit: 0, stdout: 'A new.txt\nok: 1 file\n', changes: { 'new.txt': 'x  \n' } });
expectCase('sr: delete lines with empty new part', {
  argv: ['p.txt'],
  files: { 'p.txt': SR('a\nb\n', ''), 'f.txt': 'x\na\nb\ny\n' },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'x\ny\n' } });
expectCase('sr: second block inherits path after a failed first block', {
  argv: ['p.txt'],
  files: {
    'p.txt': 'f.txt\n<<<<<<< SEARCH\nnope\n=======\nN\n>>>>>>> REPLACE\n<<<<<<< SEARCH\nb\n=======\nB\n>>>>>>> REPLACE\n',
    'f.txt': 'a\nb\n',
  },
}, { exit: 1, stdout: 'error: no-match f.txt\nfailed: 1 of 2 edits\n', changes: {} });
expectCase('sr: markers with trailing spaces and tabs', {
  argv: ['p.txt'],
  files: { 'p.txt': 'f.txt\n<<<<<<< SEARCH  \na\n======= \t\nA\n>>>>>>> REPLACE  \n', 'f.txt': 'a\n' },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'A\n' } });
expectCase('sr: fence line with leading spaces skipped', {
  argv: ['p.txt'],
  files: { 'p.txt': '   ```js\nf.txt\n<<<<<<< SEARCH\na\n=======\nA\n>>>>>>> REPLACE\n', 'f.txt': 'a\n' },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'A\n' } });
expectCase('sr: path is the nearest non-blank line, skipping blanks', {
  argv: ['p.txt'],
  files: { 'p.txt': '\n\nf.txt\n\n<<<<<<< SEARCH\na\n=======\nA\n>>>>>>> REPLACE\n', 'f.txt': 'a\n' },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'A\n' } });
expectCase('sr: backtick path line is skipped, first block has no path', {
  argv: ['p.txt'],
  files: { 'p.txt': '``` f.txt\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n' },
}, { exit: 2, stdout: 'error: parse 2\n', changes: {} });

/* ---- V4A: anchors, cursor, End of File, sections ---- */

expectCase('v4a: tier 0 anchor beats a nearer tier 2 anchor', {
  argv: ['p.txt'],
  files: {
    'p.txt': '*** Begin Patch\n*** Update File: f.py\n@@ def f():\n-  x = 1\n+  x = 2\n*** End Patch\n',
    'f.py': '  def f():\ndef f():\n  x = 1\n',
  },
}, { exit: 0, stdout: 'M f.py\nok: 1 file\n', changes: { 'f.py': '  def f():\ndef f():\n  x = 2\n' } });
expectCase('v4a: anchor before the cursor is not found again', {
  argv: ['p.txt'],
  files: {
    'p.txt': '*** Begin Patch\n*** Update File: f.py\n@@ def b():\n-  x = 1\n+  x = 2\n@@ def a():\n-  x = 1\n+  x = 9\n*** End Patch\n',
    'f.py': 'def a():\n  x = 1\ndef b():\n  x = 1\n',
  },
}, { exit: 1, stdout: 'error: no-match f.py\nfailed: 1 of 1 edits\n', changes: {} });
expectCase('v4a: EOF chunk whose O does not end at the last line is no-match', {
  argv: ['p.txt'],
  files: {
    'p.txt': '*** Begin Patch\n*** Update File: f.txt\n a\n-b\n*** End of File\n*** End Patch\n',
    'f.txt': 'a\nb\na\n',
  },
}, { exit: 1, stdout: 'error: no-match f.txt\nfailed: 1 of 1 edits\n', changes: {} });
expectCase('v4a: empty-O EOF chunk without an anchor inserts at the end', {
  argv: ['p.txt'],
  files: {
    'p.txt': '*** Begin Patch\n*** Update File: f.txt\n+X\n*** End of File\n*** End Patch\n',
    'f.txt': 'a\nb\n',
  },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'a\nb\nX\n' } });
expectCase('v4a: chunk after End of File with @@ works', {
  argv: ['p.txt'],
  files: {
    'p.txt': '*** Begin Patch\n*** Update File: f.txt\n@@ b\n-c\n+C\n*** End of File\n@@\n+X\n*** End Patch\n',
    'f.txt': 'a\nb\nc\n',
  },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'a\nb\nC\nX\n' } });
expectCase('v4a: body line after End of File is a parse error', {
  argv: ['p.txt'],
  files: {
    'p.txt': '*** Begin Patch\n*** Update File: f.txt\n@@ c\n-c\n+C\n*** End of File\n-a\n*** End Patch\n',
    'f.txt': 'a\nb\nc\n',
  },
}, { exit: 2, stdout: 'error: parse 7\n', changes: {} });
expectCase('v4a: Add File trailing blank lines are not file lines', {
  argv: ['p.txt'],
  files: { 'p.txt': '*** Begin Patch\n*** Add File: n.txt\n+a\n\n\n*** End Patch\n' },
}, { exit: 0, stdout: 'A n.txt\nok: 1 file\n', changes: { 'n.txt': 'a\n' } });
expectCase('v4a: Add File line starting with a space is a parse error', {
  argv: ['p.txt'],
  files: { 'p.txt': '*** Begin Patch\n*** Add File: n.txt\n x\n*** End Patch\n' },
}, { exit: 2, stdout: 'error: parse 3\n', changes: {} });
expectCase('v4a: trailing blank lines after End Patch are fine', {
  argv: ['p.txt'],
  files: {
    'p.txt': '*** Begin Patch\n*** Update File: f.txt\n-a\n+A\n*** End Patch\n\n\n',
    'f.txt': 'a\n',
  },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'A\n' } });
expectCase('v4a: leading blank lines before Begin Patch are fine', {
  argv: ['p.txt'],
  files: {
    'p.txt': '\n\n*** Begin Patch\n*** Update File: f.txt\n-a\n+A\n*** End Patch\n',
    'f.txt': 'a\n',
  },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'A\n' } });
expectCase('v4a: Begin Patch with trailing spaces works', {
  argv: ['p.txt'],
  files: {
    'p.txt': '*** Begin Patch   \n*** Update File: f.txt\n-a\n+A\n*** End Patch\n',
    'f.txt': 'a\n',
  },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'A\n' } });
expectCase('v4a: backslash body line is a parse error', {
  argv: ['p.txt'],
  files: {
    'p.txt': '*** Begin Patch\n*** Update File: f.txt\n\\ No newline\n*** End Patch\n',
    'f.txt': 'a\n',
  },
}, { exit: 2, stdout: 'error: parse 3\n', changes: {} });
expectCase('v4a: empty-O chunk without anchor inserts at the cursor (top)', {
  argv: ['p.txt'],
  files: {
    'p.txt': '*** Begin Patch\n*** Update File: f.txt\n+X\n*** End Patch\n',
    'f.txt': 'a\nb\n',
  },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'X\na\nb\n' } });
expectCase('v4a: failed chunk in a move edit leaves the file in place', {
  argv: ['p.txt'],
  files: {
    'p.txt': '*** Begin Patch\n*** Update File: old.txt\n*** Move to: new.txt\n-nope\n+new\n*** End Patch\n',
    'old.txt': 'a\n',
  },
}, { exit: 1, stdout: 'error: no-match old.txt\nfailed: 1 of 1 edits\n', changes: {} });
expectCase('v4a: Update File path with extra spaces after the colon', {
  argv: ['p.txt'],
  files: {
    'p.txt': '*** Begin Patch\n*** Update File:   f.txt\n-a\n+A\n*** End Patch\n',
    'f.txt': 'a\n',
  },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'A\n' } });
expectCase('v4a: Move to a path created by an earlier section is exists', {
  argv: ['p.txt'],
  files: {
    'p.txt': '*** Begin Patch\n*** Add File: b.txt\n+x\n*** Update File: a.txt\n*** Move to: b.txt\n*** End Patch\n',
    'a.txt': 'a\n',
  },
}, { exit: 1, stdout: 'error: exists b.txt\nfailed: 1 of 2 edits\n', changes: {} });

/* ---- JSON: forms, key order, CRLF, insert ---- */

expectCase('json: pretty-printed array form', {
  argv: ['-'],
  stdin: '[\n  {"command": "create", "path": "a.txt", "file_text": "hi\\n"},\n  {"command": "create", "path": "b.txt", "file_text": "yo\\n"}\n]\n',
  files: {},
}, { exit: 0, stdout: 'A a.txt\nA b.txt\nok: 2 files\n', changes: { 'a.txt': 'hi\n', 'b.txt': 'yo\n' } });
expectCase('json: JSON Lines with leading spaces before the object', {
  argv: ['-'],
  stdin: '   {"command":"create","path":"a.txt","file_text":"hi\\n"}\n',
  files: {},
}, { exit: 0, stdout: 'A a.txt\nok: 1 file\n', changes: { 'a.txt': 'hi\n' } });
expectCase('json: key order shuffled and extra keys ignored', {
  argv: ['-'],
  stdin: '{"file_text":"hi\\n","extra":{"z":[1,2]},"path":"a.txt","command":"create"}\n',
  files: {},
}, { exit: 0, stdout: 'A a.txt\nok: 1 file\n', changes: { 'a.txt': 'hi\n' } });
expectCase('json: str_replace overlapping occurrences are ambiguous', {
  argv: ['-'],
  stdin: '{"command":"str_replace","path":"f.txt","old_str":"aa","new_str":"b"}\n',
  files: { 'f.txt': 'aaa\n' },
}, { exit: 1, stdout: 'error: ambiguous f.txt\nfailed: 1 of 1 edits\n', changes: {} });
expectCase('json: str_replace with new_str absent deletes the match', {
  argv: ['-'],
  stdin: '{"command":"str_replace","path":"f.txt","old_str":"X"}\n',
  files: { 'f.txt': 'aXb\n' },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'ab\n' } });
expectCase('json: str_replace in a CRLF file matches LF old_str', {
  argv: ['-'],
  stdin: '{"command":"str_replace","path":"f.txt","old_str":"a\\nb","new_str":"X"}\n',
  files: { 'f.txt': 'a\r\nb\r\n' },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'X\r\n' } });
expectCase('json: str_replace in a CRLF file writes new_str CRLF', {
  argv: ['-'],
  stdin: '{"command":"str_replace","path":"f.txt","old_str":"a","new_str":"p\\r\\nq"}\n',
  files: { 'f.txt': 'a\r\nb\r\n' },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'p\r\nq\r\nb\r\n' } });
expectCase('json: str_replace in an LF file does not match CRLF old_str', {
  argv: ['-'],
  stdin: '{"command":"str_replace","path":"f.txt","old_str":"a\\r\\nb","new_str":"X"}\n',
  files: { 'f.txt': 'a\nb\n' },
}, { exit: 1, stdout: 'error: no-match f.txt\nfailed: 1 of 1 edits\n', changes: {} });
expectCase('json: insert at lines.length appends', {
  argv: ['-'],
  stdin: '{"command":"insert","path":"f.txt","insert_line":2,"new_str":"c"}\n',
  files: { 'f.txt': 'a\nb\n' },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'a\nb\nc\n' } });
expectCase('json: insert at 0 into an empty file has no final break', {
  argv: ['-'],
  stdin: '{"command":"insert","path":"f.txt","insert_line":0,"new_str":"x"}\n',
  files: { 'f.txt': '' },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'x' } });
expectCase('json: insert_line 2.0 works (JSON number)', {
  argv: ['-'],
  stdin: '{"command":"insert","path":"f.txt","insert_line":2.0,"new_str":"c"}\n',
  files: { 'f.txt': 'a\nb\n' },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'a\nb\nc\n' } });
expectCase('json: insert_line 2.5 is a parse error', {
  argv: ['-'],
  stdin: '{"command":"insert","path":"f.txt","insert_line":2.5,"new_str":"x"}\n',
  files: { 'f.txt': 'a\nb\n' },
}, { exit: 2, stdout: 'error: parse 1\n', changes: {} });
expectCase('json: insert_line as a string is a parse error', {
  argv: ['-'],
  stdin: '{"command":"insert","path":"f.txt","insert_line":"1","new_str":"x"}\n',
  files: { 'f.txt': 'a\nb\n' },
}, { exit: 2, stdout: 'error: parse 1\n', changes: {} });
expectCase('json: insert with empty new_str changes nothing', {
  argv: ['-'],
  stdin: '{"command":"insert","path":"f.txt","insert_line":1,"new_str":""}\n',
  files: { 'f.txt': 'a\nb\n' },
}, { exit: 0, stdout: 'ok: 0 files\n', changes: {} });
expectCase('json: insert into a CRLF file keeps CRLF', {
  argv: ['-'],
  stdin: '{"command":"insert","path":"f.txt","insert_line":1,"new_str":"x\\ny"}\n',
  files: { 'f.txt': 'a\r\nb\r\n' },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'a\r\nx\r\ny\r\nb\r\n' } });
expectCase('json: insert new_str with CRLF inside splits lines', {
  argv: ['-'],
  stdin: '{"command":"insert","path":"f.txt","insert_line":1,"new_str":"x\\r\\ny"}\n',
  files: { 'f.txt': 'a\nb\n' },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'a\nx\ny\nb\n' } });
expectCase('json: create with empty file_text makes an empty file', {
  argv: ['-'],
  stdin: '{"command":"create","path":"e.txt","file_text":""}\n',
  files: {},
}, { exit: 0, stdout: 'A e.txt\nok: 1 file\n', changes: { 'e.txt': '' } });
expectCase('json: array form with one bad object is a parse error at the array line', {
  argv: ['-'],
  stdin: '\n[{"command":"create","path":"a.txt","file_text":"hi"},{"command":"bogus","path":"b.txt"}]\n',
  files: {},
}, { exit: 2, stdout: 'error: parse 2\n', changes: {} });
expectCase('json: JSON Lines line that is an array is a parse error at its line', {
  argv: ['-'],
  stdin: '{"command":"create","path":"a.txt","file_text":"hi"}\n[1,2]\n',
  files: {},
}, { exit: 2, stdout: 'error: parse 2\n', changes: {} });
expectCase('json: JSON Lines line that is a string is a parse error at its line', {
  argv: ['--format=json', '-'],
  stdin: '"hello"\n',
  files: {},
}, { exit: 2, stdout: 'error: parse 1\n', changes: {} });
expectCase('detect: a patch starting with a JSON string detects no format', {
  argv: ['-'],
  stdin: '"hello"\n',
  files: {},
}, { exit: 2, stdout: 'error: format\n', changes: {} });
expectCase('json: object missing path is a parse error', {
  argv: ['-'],
  stdin: '{"command":"create","file_text":"x"}\n',
  files: {},
}, { exit: 2, stdout: 'error: parse 1\n', changes: {} });
expectCase('json: create with a non-string path is a parse error', {
  argv: ['-'],
  stdin: '{"command":"create","path":3,"file_text":"x"}\n',
  files: {},
}, { exit: 2, stdout: 'error: parse 1\n', changes: {} });
expectCase('json: str_replace with empty old_str is a parse error', {
  argv: ['-'],
  stdin: '{"command":"str_replace","path":"f.txt","old_str":"","new_str":"x"}\n',
  files: { 'f.txt': 'a\n' },
}, { exit: 2, stdout: 'error: parse 1\n', changes: {} });
expectCase('json: insert without insert_line is a parse error', {
  argv: ['-'],
  stdin: '{"command":"insert","path":"f.txt","new_str":"x"}\n',
  files: { 'f.txt': 'a\n' },
}, { exit: 2, stdout: 'error: parse 1\n', changes: {} });
expectCase('json: BOM at the start is a parse error under --format=json', {
  argv: ['--format=json', '-'],
  stdin: '\uFEFF{"command":"create","path":"a.txt","file_text":"hi"}\n',
  files: {},
}, { exit: 2, stdout: 'error: parse 1\n', changes: {} });
expectCase('json: insert at lines.length on a file without a final break', {
  argv: ['-'],
  stdin: '{"command":"insert","path":"f.txt","insert_line":2,"new_str":"c"}\n',
  files: { 'f.txt': 'a\nb' },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'a\nb\nc' } });
expectCase('json: str_replace where old_str spans a line break', {
  argv: ['-'],
  stdin: '{"command":"str_replace","path":"f.txt","old_str":"foo\\nbar","new_str":"X"}\n',
  files: { 'f.txt': 'foo\nbar\n' },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'X\n' } });

/* ---- Output ordering, moves, atomicity ---- */

expectCase('order: unicode paths sort by UTF-8 bytes', {
  argv: ['p.txt'],
  files: {
    'p.txt': 'z.txt\n<<<<<<< SEARCH\nz\n=======\nZ\n>>>>>>> REPLACE\nä.txt\n<<<<<<< SEARCH\nä\n=======\nÄ\n>>>>>>> REPLACE\na.txt\n<<<<<<< SEARCH\na\n=======\nA\n>>>>>>> REPLACE\n',
    'z.txt': 'z\n', 'ä.txt': 'ä\n', 'a.txt': 'a\n',
  },
}, { exit: 0, stdout: 'M a.txt\nM z.txt\nM ä.txt\nok: 3 files\n', changes: { 'z.txt': 'Z\n', 'ä.txt': 'Ä\n', 'a.txt': 'A\n' } });
expectCase('order: R row sorts by its new path', {
  argv: ['-'],
  stdin: 'diff --git a/a.txt b/z.txt\n--- a/a.txt\n+++ b/z.txt\ndiff --git a/m.txt b/m.txt\n--- a/m.txt\n+++ b/m.txt\n@@ -1,1 +1,1 @@\n-m\n+M\n',
  files: { 'a.txt': 'x\n', 'm.txt': 'm\n' },
}, { exit: 0, stdout: 'M m.txt\nR a.txt -> z.txt\nok: 2 files\n', changes: { 'a.txt': null, 'z.txt': 'x\n', 'm.txt': 'M\n' } });
expectCase('order: create then modify is one A row', {
  argv: ['p.txt'],
  files: {
    'p.txt': 'n.txt\n<<<<<<< SEARCH\n=======\nhello\n>>>>>>> REPLACE\nn.txt\n<<<<<<< SEARCH\nhello\n=======\nworld\n>>>>>>> REPLACE\n',
  },
}, { exit: 0, stdout: 'A n.txt\nok: 1 file\n', changes: { 'n.txt': 'world\n' } });
expectCase('order: modify then delete is one D row', {
  argv: ['-'],
  stdin: 'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-a\n+A\ndiff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ /dev/null\n',
  files: { 'f.txt': 'a\n' },
}, { exit: 0, stdout: 'D f.txt\nok: 1 file\n', changes: { 'f.txt': null } });
expectCase('order: delete then recreate with the same bytes is no row', {
  argv: ['-'],
  stdin: 'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ /dev/null\ndiff --git a/f.txt b/f.txt\n--- /dev/null\n+++ b/f.txt\n@@ -0,0 +1,1 @@\n+x\n',
  files: { 'f.txt': 'x\n' },
}, { exit: 0, stdout: 'ok: 0 files\n', changes: {} });
expectCase('order: delete then recreate with different bytes is M', {
  argv: ['-'],
  stdin: 'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ /dev/null\ndiff --git a/f.txt b/f.txt\n--- /dev/null\n+++ b/f.txt\n@@ -0,0 +1,1 @@\n+y\n',
  files: { 'f.txt': 'x\n' },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'y\n' } });
expectCase('order: move then modify the target is one R row', {
  argv: ['-'],
  stdin: 'diff --git a/a.txt b/b.txt\n--- a/a.txt\n+++ b/b.txt\n@@ -1,1 +1,1 @@\n-a\n+A\ndiff --git a/b.txt b/b.txt\n--- a/b.txt\n+++ b/b.txt\n@@ -1,1 +1,1 @@\n-A\n+AA\n',
  files: { 'a.txt': 'a\n' },
}, { exit: 0, stdout: 'R a.txt -> b.txt\nok: 1 file\n', changes: { 'a.txt': null, 'b.txt': 'AA\n' } });
expectCase('order: move then delete the target is a D row for the old path', {
  argv: ['-'],
  stdin: 'diff --git a/a.txt b/b.txt\n--- a/a.txt\n+++ b/b.txt\ndiff --git a/b.txt b/b.txt\n--- a/b.txt\n+++ /dev/null\n',
  files: { 'a.txt': 'a\n' },
}, { exit: 0, stdout: 'D a.txt\nok: 1 file\n', changes: { 'a.txt': null } });
expectCase('order: chained moves a->b then b->c', {
  argv: ['-'],
  stdin: 'diff --git a/a.txt b/b.txt\n--- a/a.txt\n+++ b/b.txt\ndiff --git a/b.txt b/c.txt\n--- a/b.txt\n+++ b/c.txt\n',
  files: { 'a.txt': 'a\n' },
}, { exit: 0, stdout: 'D a.txt\nA c.txt\nok: 2 files\n', changes: { 'a.txt': null, 'c.txt': 'a\n' } });
expectCase('order: failures are reported in patch order', {
  argv: ['p.txt'],
  files: {
    'p.txt': 'f.txt\n<<<<<<< SEARCH\na\n=======\nA\n>>>>>>> REPLACE\ngone.txt\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\nf.txt\n<<<<<<< SEARCH\nnope\n=======\nN\n>>>>>>> REPLACE\n',
    'f.txt': 'a\n',
  },
}, { exit: 1, stdout: 'error: missing gone.txt\nerror: no-match f.txt\nfailed: 2 of 3 edits\n', changes: {} });
expectCase('atomicity: a later edit sees a created file, a failure still writes nothing', {
  argv: ['p.txt'],
  files: {
    'p.txt': 'n.txt\n<<<<<<< SEARCH\n=======\nhello\n>>>>>>> REPLACE\nn.txt\n<<<<<<< SEARCH\nhello\n=======\nworld\n>>>>>>> REPLACE\nn.txt\n<<<<<<< SEARCH\nnope\n=======\nx\n>>>>>>> REPLACE\n',
  },
}, { exit: 1, stdout: 'error: no-match n.txt\nfailed: 1 of 3 edits\n', changes: {} });

/* ---- Performance: big files, many repeated lines ---- */

test('perf: 20k-line file with repeated lines finishes fast', () => {
  const lines = Array.from({ length: 20000 }, (_, i) => `line ${i % 50}`);
  const file = `${lines.join('\n')}\n`;
  const patch = 'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -19999,2 +19999,2 @@\n line 48\n-line 49\n+LINE 49\n';
  const got = runCase({ argv: ['-'], stdin: patch, files: { 'f.txt': file } });
  assert.equal(got.exit, 0, got.stdout);
  assert.ok(got.ms < 5000, `took ${got.ms}ms`);
  const want = lines.slice();
  want[19999] = 'LINE 49';
  assert.equal(got.files['f.txt'], `${want.join('\n')}\n`);
});

test('perf: str_replace counting 50k overlapping occurrences finishes fast', () => {
  const file = `${'a'.repeat(50000)}\n`;
  const patch = '{"command":"str_replace","path":"f.txt","old_str":"aa","new_str":"b"}\n';
  const got = runCase({ argv: ['-'], stdin: patch, files: { 'f.txt': file } });
  assert.equal(got.exit, 1, got.stdout);
  assert.equal(got.stdout, 'error: ambiguous f.txt\nfailed: 1 of 1 edits\n');
  assert.ok(got.ms < 5000, `took ${got.ms}ms`);
});

test('perf: 200 hunks on a 2000-line file finish fast', () => {
  const lines = Array.from({ length: 2000 }, (_, i) => `l${i}`);
  const file = `${lines.join('\n')}\n`;
  let patch = 'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n';
  for (let h = 0; h < 200; h += 1) patch += `@@ -${h * 10 + 1},1 +${h * 10 + 1},1 @@\n-l${h * 10}\n+L${h * 10}\n`;
  const got = runCase({ argv: ['-'], stdin: patch, files: { 'f.txt': file } });
  assert.equal(got.exit, 0, got.stdout);
  assert.ok(got.ms < 5000, `took ${got.ms}ms`);
  assert.equal(got.files['f.txt'].split('\n')[0], 'L0');
});
