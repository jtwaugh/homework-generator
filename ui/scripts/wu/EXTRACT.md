# Extracting one chapter of Wu into DAG nodes

You read a page range of one of H. Wu's drafts (pdftotext output, one file per PDF page, so formulas are often
garbled: rebuild them from context) and write one chapter file. The chapters of a curriculum are merged afterwards
by `merge.mjs`. It joins nodes across chapters by `ref`, so **reuse the refs of earlier chapters** of the same
curriculum when a node is the same concept (read `chapters/<curriculum>/*.json` first).

## Two graphs

**Content**: the mathematics in Wu's logical order.
- `definition`: a term Wu defines precisely (fraction, sum of fractions, congruence, slope, linear function…).
- `theorem`: a statement he proves or states as a theorem, proposition, lemma or corollary, or a named fact he
  derives (theorem on equivalent fractions, cross-multiplication algorithm, FTS, AA criterion…).
- `assumed`: a fact taken without proof (Wu's assumptions and FASM, the number laws of whole numbers, the basic
  properties of rigid motions), or a prerequisite from an earlier course.
- One node per idea a teacher would teach and test. Aim for 6–20 nodes per ~25 pages. Skip pedagogical commentary,
  history and exercises, but keep any idea that appears only in an exercise when later text depends on it.

**Methods**: what a student learns to *do*.
- `method`: a technique or algorithm (add fractions by finding a common denominator, long division, solve a linear
  equation by the two-sided operations, construct a perpendicular bisector, prove triangles congruent by SAS…).
- `word-problem`: a type of problem Wu teaches how to set up (constant-rate problems, "of" and percent problems,
  mixture, work problems…).
- Each method rests on content nodes: the definitions and theorems that justify it.

## Edges
Edges point **from prerequisite to dependent**.
- `uses`: refs needed to state or define this node, or (for a method) earlier methods it calls as a step.
- `proofUses` (content only): refs used in the proof but not in the statement. These are drawn dashed.
- `restsOn` (methods only): content refs that justify the method.

Refer to a node from an earlier chapter of the same curriculum by its existing ref. Refer to anything from another
course (e.g. whole-number long division inside fractions) by a ref of the form `@<curriculum-id>:<slug>`, using a
short descriptive slug. The merge turns these into `assumed` nodes linked to that course. The curricula are:
wu-whole-numbers, wu-fractions, wu-rational-numbers, wu-ms-geometry, wu-algebra-1, wu-hs-geometry, wu-precalculus.

## Fields
- `ref`: kebab-case and stable, e.g. `def-fraction`, `thm-equivalent-fractions`, `m-add-fractions`, `wp-constant-rate`.
- `title`: Wu's name for it, short (≤ 60 characters). In **wu-algebra-1 only**, prefix the section, like the
  existing board: `§4 Graph of a linear equation is a line`.
- `detail`: one sentence that states the definition or theorem precisely, or says what the method does.
- `sections`: Wu's section numbers as strings, e.g. `["1.3"]`.
- `pages`: the PDF page numbers where it is introduced.
- `aliases` (optional): other names the same idea goes by in other drafts. These help the merge.

## The file
Write `ui/data/sources/wu/chapters/<curriculum>/<NN>-<doc>-<from>.json`, where `NN` is the chapter's index in
`split.json` with two digits:

```json
{
  "curriculum": "wu-fractions", "doc": "EMI2a", "from": 4, "to": 29, "title": "Definition of a Fraction; …",
  "content": [
    {"ref": "def-fraction", "title": "Fraction", "kind": "definition", "detail": "…", "sections": ["1"], "pages": [6],
     "uses": ["@wu-whole-numbers:number-line"], "proofUses": [], "aliases": ["fraction as a point on the number line"]}
  ],
  "methods": [
    {"ref": "m-place-fraction-on-line", "title": "Locate a fraction on the number line", "kind": "method", "detail": "…",
     "sections": ["1"], "pages": [8], "uses": [], "restsOn": ["def-fraction"]}
  ],
  "notes": "anything the merge or a reviewer should know (garbled pages, unclear dependencies)"
}
```

Be precise in the manner of Wu: a definition is what he says it is, not the textbook version he is arguing against.
