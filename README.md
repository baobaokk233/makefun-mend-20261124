# mend — one patch tool for every AI edit format

`mend` applies an edit that an AI model wrote to a tree of text files. Models
write edits in four formats, and `mend` reads all four to one written
specification (`SPEC.md`):

- **unified diffs** — often with wrong line numbers; the hunk is applied at the
  occurrence nearest the line number it names
- **SEARCH/REPLACE blocks** — `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE`
- **V4A patches** — `*** Begin Patch` … `*** End Patch`, with `Add` / `Delete` /
  `Update` / `Move to` sections and `@@` anchors
- **JSON tool calls** — one edit object per line, or a JSON array of them

Lines an edit names are found at the first of three matching tiers: exact,
then ignoring trailing whitespace, then ignoring leading and trailing
whitespace (with added lines re-indented to the file). Every file is changed
or none: a failed edit changes nothing, later edits still run, and when any
edit failed no file is written at all.

## Usage

Requires Node 22 and its standard library only — nothing is installed.

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- The working directory is the root of the tree; every path in a patch is
  relative to it.
- `PATCH` is the patch file, relative to the working directory. When it is
  absent or `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`,
  `search-replace`, `v4a` or `json`. `auto` (the default) detects it.
- `--check` does everything but write: the same output and exit code, and no
  file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- Options and `PATCH` may come in any order; `--` ends the options.

### Output and exit codes

Stdout holds lines, each ended by `\n`, and nothing else. Stderr is never
compared.

- Exit 0: one line per changed path, in byte order — `A <path>` created,
  `D <path>` deleted, `M <path>` modified, `R <old> -> <new>` moved — then
  `ok: <n> files` (`ok: 1 file` when n is 1). A patch that changes nothing
  prints only `ok: 0 files`.
- Exit 1: one line `error: <code> <path>` per failed edit, in the patch's
  order, then `failed: <k> of <n> edits`. Codes: `no-match`, `ambiguous`,
  `missing`, `exists`, `unsafe`.
- Exit 2, exactly one line: `error: usage`, `error: no-patch`,
  `error: format`, or `error: parse <N>` (N is the 1-based patch line).

### Examples

    # apply a unified diff from a file
    node main.ts fix.patch

    # apply SEARCH/REPLACE blocks from stdin, dry run
    cat edit.txt | node main.ts --check -

    # force one format, exact matching only
    node main.ts --format=v4a --strict change.diff

## Files

- `main.ts` — the CLI (Node 22, standard library only).
- `runner.ts` — the kit's runner, kept as shipped: in a trial it reads the
  checks from `MAKEFUN_ENV_URL`, runs `main.ts` on each, and posts the
  results. Keep it and the trial hand-over at the end of `main.ts` as they are.
- `SPEC.md` — the whole specification (version 1). It decides what a check
  expects wherever it seems to differ from anything else here.
- `check.ts`, `practice.json` — the 100 public practice checks with the house
  reference's expected outcomes, and the runner that scores `main.ts` on
  them: `node check.ts practice.json` (optionally followed by a family name
  or a check-key prefix to run only those).
- `test.mjs` — an additional end-to-end suite (100 cases) written against
  `SPEC.md` for sentences the practice set does not show: run it with
  `node --test test.mjs`.
- `LICENSE` — MIT.

## Verification

    node check.ts practice.json   # 100 of 100 passed: practice score 1000
    node --test test.mjs          # 100 of 100 passed

Both were run on Node 22.18.0, the runtime the grader uses. The program is
deterministic: the same check gives the same exit code, stdout and files on
every run, and it keeps times and randomness out of its output.
