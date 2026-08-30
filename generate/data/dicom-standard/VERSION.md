# Vendored DICOM Standard snapshots

Stripped derivatives of the machine-readable DICOM Standard JSON published
by Innolitics, consumed by `generate/generate-iods.mjs` to build the Part 3
IOD catalog artifacts (`src/schema/iodIndex.js`,
`src/schema/iodModules.packed.js`, `schema/iod.schema.json`).

| | |
|---|---|
| Upstream repository | <https://github.com/innolitics/dicom-standard> |
| Pinned commit | `90571bcc4e46b08bc815bd683e6c466308bcff9a` (2026-04-17) |
| DICOM edition | **PS3.3 2024e** (upstream's monthly auto-refresh workflow was disabled after its 2024e regeneration; later commits are workflow/test fixes) |
| License | MIT (Innolitics, LLC) — full text below and in the repo-root `NOTICE` |

## Refresh

```sh
node scripts/refresh-dicom-standard.mjs   # downloads pinned commit, rewrites this directory
node generate/generate-iods.mjs           # rebuilds the committed artifacts
npx jest test/schema                      # determinism + invariant gates
```

To track a newer upstream state, bump `COMMIT` (and `EDITION`) in
`scripts/refresh-dicom-standard.mjs` first. Output is deterministic:
stable key order, sorted rows, one packed row per line.

## What was stripped and why

The raw upstream tables total ~93 MB — `module_to_attributes.json` alone is
78 MB, dominated by HTML attribute descriptions. The snapshots keep only
what the catalog needs (~6.5 MB total):

- `meta.json` — repository / commit / edition (generated; feeds
  `sourceEdition` in the artifacts).
- `ciods.json`, `sops.json`, `modules.json`, `macros.json` — id/name(/ciod)
  fields only; descriptions and `linkToStandard` dropped; sorted by id.
- `ciod_to_modules.json` — `ciodId`, `moduleId`, `informationEntity`,
  `usage` (M/C/U), plus `condition` (the plain-text `conditionalStatement`,
  present on all usage-C rows); sorted by (ciodId, moduleId).
- `ciod_to_func_group_macros.json` — same treatment for the functional-group
  macro assignments (`ciodId`, `macroId`, `moduleType`, `usage`,
  `condition`).
- `module_to_attributes.json` / `macro_to_attributes.json` —
  `{ "conditions": [...], "modules"|"macros": { "<id>": [rows] } }` where a
  row is `[relativeColonPath, type, conditionIndex?]`:
  - the path is upstream's verbatim colon path minus the leading module/macro
    id (restored and dot-normalized by `generate/buildIodCatalog.mjs`);
  - `type` is verbatim, including upstream's `"None"` (attribute tables with
    no Type column — Print Management / normalized-service modules; the
    builder normalizes these to Type 3, 888 rows);
  - each row's HTML description is reduced to its **condition sentence**: the
    first sentence starting `"Required if"` or `"Shall be present if"` (the
    code-sequence macro phrasing — including it lifts 1C/2C coverage from
    ~68% to 99.4%), HTML tags stripped, deduplicated into the per-file
    `conditions` array (the standard reuses sentences heavily: 93k module
    rows share 1,155 distinct sentences). Rows whose description has no
    condition sentence get none; see `CONDITIONLESS_1C2C_ROW_COUNT` in
    `generate/iodRules.mjs`.
- `confidentiality_profile_attributes.json` — kept whole (already lean),
  sorted by id; vendored now for the tranche-3 PS3.15 de-identification
  work.

Functional-group macro expansion is **not** limited: all 114 macros
referenced by `ciod_to_func_group_macros.json` are expanded into synthetic
`fg:<macro-id>` modules (packed source stayed well under the 8 MB budget).

Not vendored: `references.json`, `attributes.json` and the HTML description
bodies — nothing in the catalog needs them.

## Upstream license (MIT)

```
Copyright (c) 2017 Innolitics, LLC.

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the Software, and to permit persons to whom the Software is furnished to do
so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
