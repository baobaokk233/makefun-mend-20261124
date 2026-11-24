// mend test suite: end-to-end checks of the CLI against SPEC.md.
// Run with: node test.mjs  (Node 22, standard library only)
// Each case runs `node main.ts` once in a fresh directory and compares the
// exit code, stdout and every file afterwards with hand-computed expectations.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAIN = join(dirname(fileURLToPath(import.meta.url)), 'main.ts');

function runCase(c) {
  const dir = mkdtempSync(join(tmpdir(), 'mend-test-'));
  try {
    for (const [p, text] of Object.entries(c.files ?? {})) {
      const f = join(dir, ...p.split('/'));
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, text);
    }
    const r = spawnSync(process.execPath, [MAIN, ...(c.argv ?? [])], {
      cwd: dir,
      input: c.stdin ?? '',
      encoding: 'utf8',
      timeout: 10000,
    });
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
    return { exit: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', files: after };
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

const GO = 'package demo\n\nfunc F() int {\n\treturn 1\n}\n';

/* ---- CLI: usage, no-patch, format, parse-1 ---- */

expectCase('cli: unknown option is a usage error', { argv: ['--bogus'], stdin: '', files: {} },
  { exit: 2, stdout: 'error: usage\n', changes: {} });
expectCase('cli: duplicate --check is a usage error', { argv: ['--check', '--check'], stdin: '', files: {} },
  { exit: 2, stdout: 'error: usage\n', changes: {} });
expectCase('cli: bad --format value is a usage error', { argv: ['--format=bogus', '-'], stdin: '', files: {} },
  { exit: 2, stdout: 'error: usage\n', changes: {} });
expectCase('cli: two positionals is a usage error', { argv: ['a.patch', 'b.patch'], files: {} },
  { exit: 2, stdout: 'error: usage\n', changes: {} });
expectCase('cli: two positionals after -- is a usage error', { argv: ['--', 'a.patch', 'b.patch'], files: {} },
  { exit: 2, stdout: 'error: usage\n', changes: {} });
expectCase('cli: missing patch file is no-patch', { argv: ['missing.patch'], files: {} },
  { exit: 2, stdout: 'error: no-patch\n', changes: {} });
expectCase('cli: prose detects no format', { argv: ['-'], stdin: 'just some prose\nno patch here\n', files: {} },
  { exit: 2, stdout: 'error: format\n', changes: {} });
expectCase('cli: empty patch with --format=unified is parse 1', { argv: ['--format=unified', '-'], stdin: '', files: {} },
  { exit: 2, stdout: 'error: parse 1\n', changes: {} });
expectCase('cli: empty patch with auto is a format error', { argv: ['-'], stdin: '', files: {} },
  { exit: 2, stdout: 'error: format\n', changes: {} });
expectCase('cli: -- after options still takes the patch file', {
  argv: ['--', 'p.patch'],
  files: {
    'p.patch': 'x.txt\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE\n',
    'x.txt': 'old\n',
  },
}, { exit: 0, stdout: 'M x.txt\nok: 1 file\n', changes: { 'x.txt': 'new\n' } });
expectCase('cli: options may come after the positional', {
  argv: ['p.patch', '--check'],
  files: {
    'p.patch': 'x.txt\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE\n',
    'x.txt': 'old\n',
  },
}, { exit: 0, stdout: 'M x.txt\nok: 1 file\n', changes: {} });

/* ---- Unified diffs ---- */

const U_CHANGE = 'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -99,1 +99,1 @@\n-old\n+new\n';
expectCase('unified: wrong line numbers still find the line', {
  argv: ['-'], stdin: U_CHANGE, files: { 'f.txt': 'old\n' },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'new\n' } });

expectCase('unified: nearest tie takes the earlier occurrence', {
  argv: ['-'],
  stdin: 'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -3,3 +3,3 @@\n aa\n-bb\n+BB\n cc\n',
  files: { 'f.txt': 'aa\nbb\ncc\nzz\naa\nbb\ncc\n' },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'aa\nBB\ncc\nzz\naa\nbb\ncc\n' } });

expectCase('unified: occurrences may overlap', {
  argv: ['-'],
  stdin: 'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -2,2 +2,2 @@\n x\n-x\n+Y\n',
  files: { 'f.txt': 'x\nx\nx\n' },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'x\nx\nY\n' } });

expectCase('unified: tier 1 trailing-whitespace drift', {
  argv: ['-'],
  stdin: 'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1,2 +1,2 @@\n foo\n-bar\n+baz\n',
  files: { 'f.txt': 'foo  \nbar\t\n' },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'foo  \nbaz\n' } });

expectCase('unified: tier 2 re-indents added lines, context keeps the file line', {
  argv: ['-'],
  stdin: 'diff --git a/f.py b/f.py\n--- a/f.py\n+++ b/f.py\n@@ -2,3 +2,3 @@\n if True:\n-  x = 1\n+  x = 10\n   y = 2\n',
  files: { 'f.py': 'def f():\n    if True:\n        x = 1\n        y = 2\n' },
}, { exit: 0, stdout: 'M f.py\nok: 1 file\n', changes: { 'f.py': 'def f():\n    if True:\n      x = 10\n        y = 2\n' } });

expectCase('unified: CRLF file stays CRLF', {
  argv: ['-'],
  stdin: 'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -2,1 +2,1 @@\n-b\n+B\n',
  files: { 'f.txt': 'a\r\nb\r\nc\r\n' },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'a\r\nB\r\nc\r\n' } });

expectCase('unified: hunk away from the end keeps a missing final break', {
  argv: ['-'],
  stdin: 'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-a\n+A\n',
  files: { 'f.txt': 'a\nb\nc' },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'A\nb\nc' } });

expectCase('unified: backslash after last + line keeps no final break', {
  argv: ['-'],
  stdin: 'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -3,1 +3,1 @@\n-c\n+C\n\\ No newline at end of file\n',
  files: { 'f.txt': 'a\nb\nc' },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'a\nb\nC' } });

expectCase('unified: hunk at the end with no backslash ends with a break', {
  argv: ['-'],
  stdin: 'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -3,1 +3,1 @@\n-c\n+C\n',
  files: { 'f.txt': 'a\nb\nc' },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'a\nb\nC\n' } });

expectCase('unified: empty-O hunk inserts after A lines', {
  argv: ['-'],
  stdin: 'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -2,0 +3,2 @@\n+X\n+Y\n',
  files: { 'f.txt': 'a\nb\nc\n' },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'a\nb\nX\nY\nc\n' } });

expectCase('unified: empty-O insert past the end lands at the end', {
  argv: ['-'],
  stdin: 'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -99,0 +100,1 @@\n+X\n',
  files: { 'f.txt': 'a\nb\nc\n' },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'a\nb\nc\nX\n' } });

expectCase('unified: d accumulates across hunks', {
  argv: ['-'],
  stdin: 'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -0,0 +1,2 @@\n+n1\n+n2\n@@ -5,1 +7,1 @@\n-l5\n+L5\n',
  files: { 'f.txt': 'l1\nl2\nl3\nl4\nl5\nl6\n' },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'n1\nn2\nl1\nl2\nl3\nl4\nL5\nl6\n' } });

expectCase('unified: creation from /dev/null', {
  argv: ['-'],
  stdin: 'diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+hello\n+world\n',
  files: {},
}, { exit: 0, stdout: 'A new.txt\nok: 1 file\n', changes: { 'new.txt': 'hello\nworld\n' } });

expectCase('unified: creation with backslash after last + has no final break', {
  argv: ['-'],
  stdin: 'diff --git a/new.txt b/new.txt\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,1 @@\n+hello\n\\ No newline at end of file\n',
  files: {},
}, { exit: 0, stdout: 'A new.txt\nok: 1 file\n', changes: { 'new.txt': 'hello' } });

expectCase('unified: creation of an existing file is exists', {
  argv: ['-'],
  stdin: 'diff --git a/f.txt b/f.txt\n--- /dev/null\n+++ b/f.txt\n@@ -0,0 +1,1 @@\n+x\n',
  files: { 'f.txt': 'old\n' },
}, { exit: 1, stdout: 'error: exists f.txt\nfailed: 1 of 1 edits\n', changes: {} });

expectCase('unified: deletion ignores hunks that would not match', {
  argv: ['-'],
  stdin: 'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ /dev/null\n@@ -1,2 +1,0 @@\n-not-there\n-not-there-either\n',
  files: { 'f.txt': 'a\nb\n' },
}, { exit: 0, stdout: 'D f.txt\nok: 1 file\n', changes: { 'f.txt': null } });

expectCase('unified: deletion of a missing file is missing', {
  argv: ['-'],
  stdin: 'diff --git a/f.txt b/f.txt\ndeleted file mode 100644\n--- a/f.txt\n+++ /dev/null\n',
  files: {},
}, { exit: 1, stdout: 'error: missing f.txt\nfailed: 1 of 1 edits\n', changes: {} });

expectCase('unified: rename from/to moves the file', {
  argv: ['-'],
  stdin: 'diff --git a/old.txt b/new.txt\nrename from old.txt\nrename to new.txt\n',
  files: { 'old.txt': 'same\n' },
}, { exit: 0, stdout: 'R old.txt -> new.txt\nok: 1 file\n', changes: { 'old.txt': null, 'new.txt': 'same\n' } });

expectCase('unified: move applies hunks and reports R', {
  argv: ['-'],
  stdin: 'diff --git a/old.txt b/new.txt\n--- a/old.txt\n+++ b/new.txt\n@@ -1,1 +1,1 @@\n-a\n+A\n',
  files: { 'old.txt': 'a\n' },
}, { exit: 0, stdout: 'R old.txt -> new.txt\nok: 1 file\n', changes: { 'old.txt': null, 'new.txt': 'A\n' } });

expectCase('unified: move to an existing path is exists', {
  argv: ['-'],
  stdin: 'diff --git a/old.txt b/new.txt\n--- a/old.txt\n+++ b/new.txt\n',
  files: { 'old.txt': 'a\n', 'new.txt': 'b\n' },
}, { exit: 1, stdout: 'error: exists new.txt\nfailed: 1 of 1 edits\n', changes: {} });

expectCase('unified: same path after prefix strip is a change, not a move', {
  argv: ['-'],
  stdin: 'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-a\n+A\n',
  files: { 'f.txt': 'a\n' },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'A\n' } });

expectCase('unified: rename beats the diff --git paths', {
  argv: ['-'],
  stdin: 'diff --git a/wrong.txt b/wrong.txt\nrename from old.txt\nrename to new.txt\n',
  files: { 'old.txt': 'x\n' },
}, { exit: 0, stdout: 'R old.txt -> new.txt\nok: 1 file\n', changes: { 'old.txt': null, 'new.txt': 'x\n' } });

expectCase('unified: tab after a --- path ends the path', {
  argv: ['-'],
  stdin: 'diff --git a/f.txt b/f.txt\n--- a/f.txt\t2026-01-01 00:00:00\n+++ b/f.txt\t2026-01-01 00:00:00\n@@ -1,1 +1,1 @@\n-a\n+A\n',
  files: { 'f.txt': 'a\n' },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'A\n' } });

expectCase('unified: bad diff --git line is a parse error at its line', {
  argv: ['-'],
  stdin: 'diff --git a/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-a\n+A\n',
  files: { 'f.txt': 'a\n' },
}, { exit: 2, stdout: 'error: parse 1\n', changes: {} });

expectCase('unified: bad @@ header is a parse error at its line', {
  argv: ['-'],
  stdin: '--- a/f.txt\n+++ b/f.txt\n@@ 1,1 +1,1 @@\n-a\n+A\n',
  files: { 'f.txt': 'a\n' },
}, { exit: 2, stdout: 'error: parse 3\n', changes: {} });

expectCase('unified: hunk before any section is a parse error', {
  argv: ['-'],
  stdin: 'prose\n@@ -1,1 +1,1 @@\n-a\n+A\ndiff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-a\n+A\n',
  files: { 'f.txt': 'a\n' },
}, { exit: 2, stdout: 'error: parse 2\n', changes: {} });

expectCase('unified: an @@ hunk alone does not detect as unified', {
  argv: ['-'],
  stdin: 'prose\n@@ -1,1 +1,1 @@\n-a\n+A\n',
  files: { 'f.txt': 'a\n' },
}, { exit: 2, stdout: 'error: format\n', changes: {} });

expectCase('unified: --- in a header without +++ is a parse error at the next line', {
  argv: ['-'],
  stdin: 'diff --git a/f.txt b/f.txt\n--- a/f.txt\nindex abc..def 100644\n@@ -1,1 +1,1 @@\n-a\n+A\n',
  files: { 'f.txt': 'a\n' },
}, { exit: 2, stdout: 'error: parse 3\n', changes: {} });

expectCase('unified: prose and code fences around the patch are ignored', {
  argv: ['-'],
  stdin: 'Here is the fix:\n```diff\ndiff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-a\n+A\n```\nDone.\n',
  files: { 'f.txt': 'a\n' },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'A\n' } });

expectCase('unified: no-op hunk prints ok: 0 files', {
  argv: ['-'],
  stdin: 'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-a\n+a\n',
  files: { 'f.txt': 'a\n' },
}, { exit: 0, stdout: 'ok: 0 files\n', changes: {} });

expectCase('unified: multi-file rows sort in byte order', {
  argv: ['-'],
  stdin: 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-a\n+A\ndiff --git a/Z.txt b/Z.txt\n--- a/Z.txt\n+++ b/Z.txt\n@@ -1,1 +1,1 @@\n-z\n+Z\n',
  files: { 'a.txt': 'a\n', 'Z.txt': 'z\n' },
}, { exit: 0, stdout: 'M Z.txt\nM a.txt\nok: 2 files\n', changes: { 'a.txt': 'A\n', 'Z.txt': 'Z\n' } });

expectCase('unified: unsafe path after a/ strip is unsafe', {
  argv: ['-'],
  stdin: 'diff --git a/x b/x\n--- a/../../evil.txt\n+++ b/../../evil.txt\n@@ -1,1 +1,1 @@\n-a\n+A\n',
  files: {},
}, { exit: 1, stdout: 'error: unsafe ../../evil.txt\nfailed: 1 of 1 edits\n', changes: {} });

expectCase('unified: no-match fails the section and nothing is written', {
  argv: ['-'],
  stdin: 'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-not-there\n+new\n',
  files: { 'f.txt': 'a\n' },
}, { exit: 1, stdout: 'error: no-match f.txt\nfailed: 1 of 1 edits\n', changes: {} });

/* ---- SEARCH/REPLACE blocks ---- */

expectCase('search-replace: basic replace', {
  argv: ['p.txt'],
  files: {
    'p.txt': 'The edit:\n\nf.txt\n<<<<<<< SEARCH\n- Keep 3\n=======\n- Keep 9\n>>>>>>> REPLACE\n',
    'f.txt': 'head\n- Keep 3\ntail\n',
  },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'head\n- Keep 9\ntail\n' } });

expectCase('search-replace: empty old lines create the file', {
  argv: ['p.txt'],
  files: { 'p.txt': 'new.txt\n<<<<<<< SEARCH\n=======\nhello\nworld\n>>>>>>> REPLACE\n' },
}, { exit: 0, stdout: 'A new.txt\nok: 1 file\n', changes: { 'new.txt': 'hello\nworld\n' } });

expectCase('search-replace: empty old and new create an empty file', {
  argv: ['p.txt'],
  files: { 'p.txt': 'new.txt\n<<<<<<< SEARCH\n=======\n>>>>>>> REPLACE\n' },
}, { exit: 0, stdout: 'A new.txt\nok: 1 file\n', changes: { 'new.txt': '' } });

expectCase('search-replace: create of an existing file is exists', {
  argv: ['p.txt'],
  files: {
    'p.txt': 'f.txt\n<<<<<<< SEARCH\n=======\nx\n>>>>>>> REPLACE\n',
    'f.txt': 'old\n',
  },
}, { exit: 1, stdout: 'error: exists f.txt\nfailed: 1 of 1 edits\n', changes: {} });

expectCase('search-replace: two occurrences are ambiguous', {
  argv: ['p.txt'],
  files: {
    'p.txt': 'f.txt\n<<<<<<< SEARCH\nsame\n=======\nchanged\n>>>>>>> REPLACE\n',
    'f.txt': 'same\nsame\n',
  },
}, { exit: 1, stdout: 'error: ambiguous f.txt\nfailed: 1 of 1 edits\n', changes: {} });

expectCase('search-replace: missing file is missing', {
  argv: ['p.txt'],
  files: { 'p.txt': 'gone.txt\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n' },
}, { exit: 1, stdout: 'error: missing gone.txt\nfailed: 1 of 1 edits\n', changes: {} });

expectCase('search-replace: second block inherits the previous path', {
  argv: ['p.txt'],
  files: {
    'p.txt': 'f.txt\n<<<<<<< SEARCH\na\n=======\nA\n>>>>>>> REPLACE\n<<<<<<< SEARCH\nb\n=======\nB\n>>>>>>> REPLACE\n',
    'f.txt': 'a\nb\n',
  },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'A\nB\n' } });

expectCase('search-replace: fence line is skipped when looking for the path', {
  argv: ['p.txt'],
  files: {
    'p.txt': '```\n<<<<<<< SEARCH\n}\n=======\n} // x\n>>>>>>> REPLACE\n```\n',
    'f.txt': '}\n',
  },
}, { exit: 2, stdout: 'error: parse 2\n', changes: {} });

expectCase('search-replace: SEARCH with no ======= is a parse error at the SEARCH line', {
  argv: ['p.txt'],
  files: {
    'p.txt': 'f.txt\n<<<<<<< SEARCH\nx\n>>>>>>> REPLACE\n',
    'f.txt': 'x\n',
  },
}, { exit: 2, stdout: 'error: parse 2\n', changes: {} });

expectCase('search-replace: SEARCH with no REPLACE is a parse error at the SEARCH line', {
  argv: ['p.txt'],
  files: {
    'p.txt': 'f.txt\n<<<<<<< SEARCH\nx\n=======\ny\n',
    'f.txt': 'x\n',
  },
}, { exit: 2, stdout: 'error: parse 2\n', changes: {} });

expectCase('search-replace: CRLF file stays CRLF', {
  argv: ['p.txt'],
  files: {
    'p.txt': 'f.txt\n<<<<<<< SEARCH\nb\n=======\nB\n>>>>>>> REPLACE\n',
    'f.txt': 'a\r\nb\r\nc\r\n',
  },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'a\r\nB\r\nc\r\n' } });

expectCase('search-replace: tier 2 re-indents the new lines', {
  argv: ['p.txt'],
  files: {
    'p.txt': 'f.py\n<<<<<<< SEARCH\nif True:\n  x = 1\n=======\nif True:\n  x = 10\n>>>>>>> REPLACE\n',
    'f.py': 'def f():\n    if True:\n        x = 1\n',
  },
}, { exit: 0, stdout: 'M f.py\nok: 1 file\n', changes: { 'f.py': 'def f():\n    if True:\n      x = 10\n' } });

expectCase('search-replace: unsafe path is unsafe', {
  argv: ['p.txt'],
  files: { 'p.txt': '../evil.txt\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n' },
}, { exit: 1, stdout: 'error: unsafe ../evil.txt\nfailed: 1 of 1 edits\n', changes: {} });

/* ---- V4A patches ---- */

expectCase('v4a: anchor plus cursor picks the later repeated block', {
  argv: ['p.txt'],
  files: {
    'p.txt': '*** Begin Patch\n*** Update File: f.py\n@@ def second():\n     x = 1\n-    return a * 2\n+    return a * 3\n*** End Patch\n',
    'f.py': 'def first():\n    x = 1\n    return a * 2\ndef second():\n    x = 1\n    return a * 2\n',
  },
}, { exit: 0, stdout: 'M f.py\nok: 1 file\n', changes: { 'f.py': 'def first():\n    x = 1\n    return a * 2\ndef second():\n    x = 1\n    return a * 3\n' } });

expectCase('v4a: first chunk may start at a body line', {
  argv: ['p.txt'],
  files: {
    'p.txt': '*** Begin Patch\n*** Update File: f.txt\n-old\n+new\n*** End Patch\n',
    'f.txt': 'old\n',
  },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'new\n' } });

expectCase('v4a: a space after - or + is part of the line, matched at tier 2', {
  argv: ['p.txt'],
  files: {
    'p.txt': '*** Begin Patch\n*** Update File: f.txt\n- old\n+ new\n*** End Patch\n',
    'f.txt': 'old\n',
  },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'new\n' } });

expectCase('v4a: End of File chunk must end at the last line', {
  argv: ['p.txt'],
  files: {
    'p.txt': '*** Begin Patch\n*** Update File: f.js\n   config.region = 1;\n-}\n+} // done\n*** End of File\n*** End Patch\n',
    'f.js': 'function a() {\n  config.region = 1;\n}\nfunction b() {\n  config.region = 1;\n}\n',
  },
}, { exit: 0, stdout: 'M f.js\nok: 1 file\n', changes: { 'f.js': 'function a() {\n  config.region = 1;\n}\nfunction b() {\n  config.region = 1;\n} // done\n' } });

expectCase('v4a: empty-O End of File chunk inserts at the end', {
  argv: ['p.txt'],
  files: {
    'p.txt': '*** Begin Patch\n*** Update File: f.txt\n@@ tail\n+last\n*** End of File\n*** End Patch\n',
    'f.txt': 'head\ntail\n',
  },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'head\ntail\nlast\n' } });

expectCase('v4a: empty-O chunk inserts at the cursor past the anchor', {
  argv: ['p.txt'],
  files: {
    'p.txt': '*** Begin Patch\n*** Update File: f.txt\n@@ b\n+INSERTED\n*** End Patch\n',
    'f.txt': 'a\nb\nc\n',
  },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'a\nb\nINSERTED\nc\n' } });

expectCase('v4a: add file keeps interior empty lines', {
  argv: ['p.txt'],
  files: {
    'p.txt': '*** Begin Patch\n*** Add File: new.txt\n+line one\n\n+line three\n*** End Patch\n',
  },
}, { exit: 0, stdout: 'A new.txt\nok: 1 file\n', changes: { 'new.txt': 'line one\n\nline three\n' } });

expectCase('v4a: add of an existing file is exists', {
  argv: ['p.txt'],
  files: {
    'p.txt': '*** Begin Patch\n*** Add File: f.txt\n+x\n*** End Patch\n',
    'f.txt': 'old\n',
  },
}, { exit: 1, stdout: 'error: exists f.txt\nfailed: 1 of 1 edits\n', changes: {} });

expectCase('v4a: delete file', {
  argv: ['p.txt'],
  files: {
    'p.txt': '*** Begin Patch\n*** Delete File: f.txt\n*** End Patch\n',
    'f.txt': 'old\n',
  },
}, { exit: 0, stdout: 'D f.txt\nok: 1 file\n', changes: { 'f.txt': null } });

expectCase('v4a: delete of a missing file is missing', {
  argv: ['p.txt'],
  files: { 'p.txt': '*** Begin Patch\n*** Delete File: gone.txt\n*** End Patch\n' },
}, { exit: 1, stdout: 'error: missing gone.txt\nfailed: 1 of 1 edits\n', changes: {} });

expectCase('v4a: update with only Move to is a pure move', {
  argv: ['p.txt'],
  files: {
    'p.txt': '*** Begin Patch\n*** Update File: old.txt\n*** Move to: new.txt\n*** End Patch\n',
    'old.txt': 'same\n',
  },
}, { exit: 0, stdout: 'R old.txt -> new.txt\nok: 1 file\n', changes: { 'old.txt': null, 'new.txt': 'same\n' } });

expectCase('v4a: move to an existing path is exists', {
  argv: ['p.txt'],
  files: {
    'p.txt': '*** Begin Patch\n*** Update File: old.txt\n*** Move to: new.txt\n*** End Patch\n',
    'old.txt': 'a\n',
    'new.txt': 'b\n',
  },
}, { exit: 1, stdout: 'error: exists new.txt\nfailed: 1 of 1 edits\n', changes: {} });

expectCase('v4a: update plus move applies chunks then moves', {
  argv: ['p.txt'],
  files: {
    'p.txt': '*** Begin Patch\n*** Update File: old.txt\n*** Move to: new.txt\n-a\n+A\n*** End Patch\n',
    'old.txt': 'a\n',
  },
}, { exit: 0, stdout: 'R old.txt -> new.txt\nok: 1 file\n', changes: { 'old.txt': null, 'new.txt': 'A\n' } });

expectCase('v4a: missing Begin Patch is a parse error at the first non-blank line', {
  argv: ['--format=v4a', '-'],
  stdin: '{"command":"create","path":"x","file_text":"y"}\n',
  files: {},
}, { exit: 2, stdout: 'error: parse 1\n', changes: {} });

expectCase('v4a: missing End Patch is a parse error at lines plus one', {
  argv: ['-'],
  stdin: '*** Begin Patch\n*** Update File: f.txt\n-a\n+A\n',
  files: { 'f.txt': 'a\n' },
}, { exit: 2, stdout: 'error: parse 5\n', changes: {} });

expectCase('v4a: garbage line in a section is a parse error at its line', {
  argv: ['-'],
  stdin: '*** Begin Patch\n*** Update File: f.txt\nhello\n*** End Patch\n',
  files: { 'f.txt': 'a\n' },
}, { exit: 2, stdout: 'error: parse 3\n', changes: {} });

expectCase('v4a: Add section with a - line is a parse error', {
  argv: ['-'],
  stdin: '*** Begin Patch\n*** Add File: new.txt\n-x\n*** End Patch\n',
  files: {},
}, { exit: 2, stdout: 'error: parse 3\n', changes: {} });

expectCase('v4a: Delete section with a line is a parse error', {
  argv: ['-'],
  stdin: '*** Begin Patch\n*** Delete File: f.txt\n+x\n*** End Patch\n',
  files: { 'f.txt': 'a\n' },
}, { exit: 2, stdout: 'error: parse 3\n', changes: {} });

expectCase('v4a: Update with no chunk and no Move to is a parse error at the Update line', {
  argv: ['-'],
  stdin: '*** Begin Patch\n*** Update File: f.txt\n*** End Patch\n',
  files: { 'f.txt': 'a\n' },
}, { exit: 2, stdout: 'error: parse 2\n', changes: {} });

expectCase('v4a: Move to after a chunk is a parse error', {
  argv: ['-'],
  stdin: '*** Begin Patch\n*** Update File: f.txt\n-a\n+A\n*** Move to: new.txt\n*** End Patch\n',
  files: { 'f.txt': 'a\n' },
}, { exit: 2, stdout: 'error: parse 5\n', changes: {} });

expectCase('v4a: trailing blank lines at the end of a section are not part of it', {
  argv: ['p.txt'],
  files: {
    'p.txt': '*** Begin Patch\n*** Update File: f.py\n@@ def second():\n     x = 1\n-    return a * 2\n+    return a * 3\n \n*** End Patch\n',
    'f.py': 'def first():\n    x = 1\n    return a * 2\ndef second():\n    x = 1\n    return a * 2\n',
  },
}, { exit: 0, stdout: 'M f.py\nok: 1 file\n', changes: { 'f.py': 'def first():\n    x = 1\n    return a * 2\ndef second():\n    x = 1\n    return a * 3\n' } });

expectCase('v4a: anchor found at tier 2 when indentation drifted', {
  argv: ['p.txt'],
  files: {
    'p.txt': '*** Begin Patch\n*** Update File: f.py\n@@ def f():\n-  x = 1\n+  x = 2\n*** End Patch\n',
    'f.py': 'def f():\n        x = 1\n',
  },
}, { exit: 0, stdout: 'M f.py\nok: 1 file\n', changes: { 'f.py': 'def f():\n        x = 2\n' } });

expectCase('v4a: CRLF file stays CRLF', {
  argv: ['p.txt'],
  files: {
    'p.txt': '*** Begin Patch\n*** Update File: f.txt\n-b\n+B\n*** End Patch\n',
    'f.txt': 'a\r\nb\r\nc\r\n',
  },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'a\r\nB\r\nc\r\n' } });

expectCase('v4a: a failed chunk still runs later sections and reports both', {
  argv: ['p.txt'],
  files: {
    'p.txt': '*** Begin Patch\n*** Update File: f.txt\n-nope\n+new\n*** Delete File: gone.txt\n*** End Patch\n',
    'f.txt': 'a\n',
  },
}, { exit: 1, stdout: 'error: no-match f.txt\nerror: missing gone.txt\nfailed: 2 of 2 edits\n', changes: {} });

/* ---- JSON edits ---- */

expectCase('json: array form with a bad object is a parse error at the array line', {
  argv: ['-'],
  stdin: '\n[{"command":"bogus","path":"x"}]\n',
  files: {},
}, { exit: 2, stdout: 'error: parse 2\n', changes: {} });

expectCase('json: JSON Lines ignores blank lines', {
  argv: ['-'],
  stdin: '\n{"command":"create","path":"a.txt","file_text":"hi\\n"}\n\n{"command":"create","path":"b.txt","file_text":"yo\\n"}\n',
  files: {},
}, { exit: 0, stdout: 'A a.txt\nA b.txt\nok: 2 files\n', changes: { 'a.txt': 'hi\n', 'b.txt': 'yo\n' } });

expectCase('json: str_replace ambiguous is ambiguous', {
  argv: ['-'],
  stdin: '{"command":"str_replace","path":"f.txt","old_str":"x","new_str":"y"}\n',
  files: { 'f.txt': 'x x\n' },
}, { exit: 1, stdout: 'error: ambiguous f.txt\nfailed: 1 of 1 edits\n', changes: {} });

expectCase('json: insert past the end is no-match', {
  argv: ['-'],
  stdin: '{"command":"insert","path":"f.txt","insert_line":9,"new_str":"z"}\n',
  files: { 'f.txt': 'a\nb\n' },
}, { exit: 1, stdout: 'error: no-match f.txt\nfailed: 1 of 1 edits\n', changes: {} });

expectCase('json: create writes file_text byte for byte', {
  argv: ['-'],
  stdin: '{"command":"create","path":"f.txt","file_text":"a\\r\\nb"}\n',
  files: {},
}, { exit: 0, stdout: 'A f.txt\nok: 1 file\n', changes: { 'f.txt': 'a\r\nb' } });

expectCase('json: wrong command is a parse error at its line', {
  argv: ['-'],
  stdin: '{"command":"explode","path":"f.txt"}\n',
  files: {},
}, { exit: 2, stdout: 'error: parse 1\n', changes: {} });

/* ---- Order, atomicity, --check, --strict, determinism ---- */

expectCase('atomicity: a later failing edit writes nothing at all', {
  argv: ['p.txt'],
  files: {
    'p.txt': 'new.txt\n<<<<<<< SEARCH\n=======\nhello\n>>>>>>> REPLACE\ngone.txt\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n',
  },
}, { exit: 1, stdout: 'error: missing gone.txt\nfailed: 1 of 2 edits\n', changes: {} });

expectCase('order: a later edit sees the file an earlier edit created', {
  argv: ['p.txt'],
  files: {
    'p.txt': 'new.txt\n<<<<<<< SEARCH\n=======\nhello\n>>>>>>> REPLACE\nnew.txt\n<<<<<<< SEARCH\nhello\n=======\nworld\n>>>>>>> REPLACE\n',
  },
}, { exit: 0, stdout: 'A new.txt\nok: 1 file\n', changes: { 'new.txt': 'world\n' } });

expectCase('check: --check reports the change but writes nothing', {
  argv: ['--check', 'p.txt'],
  files: {
    'p.txt': 'f.txt\n<<<<<<< SEARCH\na\n=======\nA\n>>>>>>> REPLACE\n',
    'f.txt': 'a\n',
  },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: {} });

expectCase('check: --check with a failing edit still exits 1 and writes nothing', {
  argv: ['--check', 'p.txt'],
  files: {
    'p.txt': 'gone.txt\n<<<<<<< SEARCH\na\n=======\nA\n>>>>>>> REPLACE\nf.txt\n<<<<<<< SEARCH\na\n=======\nA\n>>>>>>> REPLACE\n',
    'f.txt': 'a\n',
  },
}, { exit: 1, stdout: 'error: missing gone.txt\nfailed: 1 of 2 edits\n', changes: {} });

expectCase('strict: tier-1-only match fails under --strict', {
  argv: ['--strict', '-'],
  stdin: 'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-foo\n+bar\n',
  files: { 'f.txt': 'foo  \n' },
}, { exit: 1, stdout: 'error: no-match f.txt\nfailed: 1 of 1 edits\n', changes: {} });

expectCase('strict: exact match still works under --strict', {
  argv: ['--strict', '-'],
  stdin: 'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-foo\n+bar\n',
  files: { 'f.txt': 'foo\n' },
}, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', changes: { 'f.txt': 'bar\n' } });

expectCase('detect: v4a wins over search-replace when Begin Patch is first', {
  argv: ['-'],
  stdin: '*** Begin Patch\n*** Update File: f.txt\n<<<<<<< SEARCH\n',
  files: { 'f.txt': 'a\n' },
}, { exit: 2, stdout: 'error: parse 4\n', changes: {} });

expectCase('detect: json wins over unified when the first line is {', {
  argv: ['-'],
  stdin: '{"command":\n',
  files: {},
}, { exit: 2, stdout: 'error: parse 1\n', changes: {} });

expectCase('unsafe: backslash in a path is unsafe', {
  argv: ['p.txt'],
  files: { 'p.txt': 'a\\b.txt\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n' },
}, { exit: 1, stdout: 'error: unsafe a\\b.txt\nfailed: 1 of 1 edits\n', changes: {} });

expectCase('unsafe: empty path segment is unsafe', {
  argv: ['p.txt'],
  files: { 'p.txt': 'a//b.txt\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n' },
}, { exit: 1, stdout: 'error: unsafe a//b.txt\nfailed: 1 of 1 edits\n', changes: {} });

expectCase('unsafe: absolute path is unsafe', {
  argv: ['p.txt'],
  files: { 'p.txt': '/tmp/evil.txt\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n' },
}, { exit: 1, stdout: 'error: unsafe /tmp/evil.txt\nfailed: 1 of 1 edits\n', changes: {} });

expectCase('create: nested directories are created as needed', {
  argv: ['p.txt'],
  files: { 'p.txt': 'a/b/c/new.txt\n<<<<<<< SEARCH\n=======\ndeep\n>>>>>>> REPLACE\n' },
}, { exit: 0, stdout: 'A a/b/c/new.txt\nok: 1 file\n', changes: { 'a/b/c/new.txt': 'deep\n' } });

test('determinism: the same check gives the same result twice', () => {
  const c = {
    argv: ['-'],
    stdin: 'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -2,1 +2,1 @@\n-b\n+B\n',
    files: { 'f.txt': 'a\nb\nc\n' },
  };
  const one = runCase(c);
  const two = runCase(c);
  assert.equal(one.exit, two.exit);
  assert.equal(one.stdout, two.stdout);
  assert.deepEqual(one.files, two.files);
  assert.equal(one.stdout, 'M f.txt\nok: 1 file\n');
  assert.deepEqual(one.files, { 'f.txt': 'a\nB\nc\n' });
});
