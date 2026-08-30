# dcmjs v2.0 — the ECMAScript DICOM Foundation epic

This is the working roadmap for the `v2.0-development` line. It exists
for team review: argue with the priorities, claim a workstream, or add
to the open questions at the bottom.

Source document: an independent gap analysis ("ECMAScript DICOM
Foundation — Gap Analysis and Parity Roadmap vs. DCMTK, dcm4che,
pydicom/highdicom, GDCM, and Orthanc", produced with fresh eyes against
the 1.0 line). Its strategic conclusion, adopted here verbatim:

> Success should not be defined as "dcmjs achieves feature parity with
> DCMTK." That accidentally lets a 30-year-old C++ toolkit define the
> architecture. A better definition: **a developer can build a
> standards-conformant modern imaging application entirely in
> ECMAScript, without needing Python, Java, or native DICOM code.**

That means excellent Part 10, validation, character sets, derived
objects, de-identification, codecs-through-WASM, DICOMweb, SR/SEG, and
DICOM semantics. It does not mean Print Management or rebuilding C-MOVE.

## Branch model

- **`development`** — the 1.x line. Frozen-ish: bug fixes and the
  dcmjs-org handoff only. 120 suites / 1705 tests green; 82 of the 172
  upstream issues addressed (39 of the 76 open ones); benchmarks
  published in BENCHMARKS.md.
- **`v2.0-development`** — this line. Feature branches stack as open
  PRs onto it (the same review routine the 1.0 arcs used) and merge in
  as approved.

## The gap matrix, re-baselined

The gap analysis was written against an earlier snapshot; three days of
work landed between its snapshot and this branch. Every row below is
rescored against the code as it exists today, with the evidence.

| # | Domain | Analysis said | Actually today | Evidence | v2 target | Tranche |
|---|---|---|---|---|---|---|
| 1 | Part 10 parser/writer | Strong | Strong — plus 82 issue-derived regression pins | `test/issues/` (35 suites), `ISSUE_TEST_PLAN.md` | Foundation-grade + formal TS compatibility matrix | 1 (matrix) |
| 1b | Conformance corpus | Partial | Internal only: 3 read paths + dicom-parser cross-check | `scripts/corpus-runner.mjs` | Differential vs external toolkits | deferred (see open questions) |
| 2 | Character sets | Partial | **Good** — full ISO 2022 escape decoding (Japanese, Korean, GB 2312, 8859 GR halves), verified against the dclunie corpus | `src/charset/iso2022.js`, `test/issues/issue454-*` | Foundation-grade: last defined terms + write-side policy | 1 |
| 3 | Private tags | Partial | Registry + lazy private dictionary; naturalize/denaturalize round-trips since #215/#388 | `src/dictionary.private.data.js`, `registerPrivatesModule` | Vendor dictionary packages (@dcmjs/private-*) | 3 |
| 4 | Codecs | Limited | Unchanged — deliberately codec-free; RLE encode only | `src/image/buildImageDataset.js` header | Pluggable registry in core; codecs as WASM packages | 2 |
| 5 | Pixel pipeline | Partial | Unchanged — pre-decoded contract, geometry-wins | same | Explicit Cornerstone interop contract | 2 |
| 6 | High-level IODs | Moderate | Ad-hoc builders exist (SC, Encapsulated PDF, video, SEG derivation) | `src/encapsulated/`, `src/image/`, `src/derivations/` | `dcmjs.sop.*` constructors on the IOD catalog | 3 |
| 7 | Validation | Partial | Confirmed minimal: VR-format checks only; no Part 3 semantics anywhere | recon 2026-08-29 | Layered engine: structural → cross-field → IOD/module | **1 (core)** |
| 8 | TypeScript/schema | Good | **Largely built** — generated 10,337-line `NaturalizedDataset` d.ts, JSON-Schema projection, CI determinism gates | `types/dcmjs-schema.d.ts`, `generate/generate-schema.mjs` | Per-IOD typed datasets (`DicomDataset<CTImageStorage>`) | **1** |
| 9 | DICOMweb | Emerging | JSON model in core; transport lives in dcmjs-commands/Static-DICOMweb | `src/eventStream/DicomWebJsonWriter.js` | First-class client (QIDO/WADO/STOW) behind DicomAccess | 2 |
| 10 | DIMSE | Deliberately limited | Stub bin only | `dimsejs` | **Don't chase** — adapter boundary; DICOMweb is the protocol | — |
| 11 | De-identification | Moderate | CTP-style, 228 validated tag rules (all dead names fixed in #345) | `src/anonymizer.js` | PS3.15 confidentiality profiles + UID remapping engine | 3 |
| 12 | UID infrastructure | (not scored) | `uid()` UUID-derived per PS3.5 B.2 since the gap-fix arc | `DicomMetaDictionary.uid()` | validate / remap / deterministic helpers | 3 |
| 13 | DICOMDIR | Very good | Read + write with exact offsets; CLI + CD workflows | `src/media/`, dcmjs-commands | migrate-to-DICOMweb+FHIR polish | 4 |
| 14 | FHIR | Good | Patient/ImagingStudy both directions, Bundles, dicomweb+fhir format | `packages/fhir/` | Leadership: SR → DiagnosticReport + Observation | 4 |
| 15 | Structured reporting | Good | Adapters + TID utilities; 30 issue-derived work orders sketched | `ISSUE_TEST_PLAN.md` wave-2 rows | SR tree model + TID 1500/1410/300 builders | 4 |
| 16 | TypeScript-first API | (housekeeping) | Data model typed; API surface untyped | `types/` | Typed public contract | 4 |
| 17 | Runtime portability | (promise) | Node 22/24 CI; browser via bundle; latin1-less runtimes handled (#297) | `.github/workflows`, `src/charset/latin1.js` | Browser/worker CI matrix; Deno/Bun later | 4 |
| 18 | Benchmarks | (todo) | Harness + published results vs upstream + dicom-parser; 20 GB workloads | `BENCHMARKS.md`, `scripts/bench.mjs` | Add external comparators + workload classes | deferred |
| — | Streaming | Excellent | The category-leader claim is now benchmarked (0.22 s / 771 MB on 1.3 GB; 20.3 GB parses where whole-file readers cannot) | `BENCHMARKS.md` | Keep the crown | continuous |
| — | Static-DICOMweb | Very good | Publisher + FHIR layer in dcmjs-commands | sibling repo | Category leader | continuous |
| — | Agent/MCP | Good | 8 typed tools, corrective-error contract | dcmjs-commands `src/mcp/` | Category leader | continuous |

## The derby scoreboard

Each differential, what a home run means, and where it's batting:

| Gap | Home run = | Status | Tranche | Size |
|---|---|---|---|---|
| Part 3 metadata pipeline (keystone) | Generated, gated IOD/module/Type catalog powering three other gaps | **DONE (PR #61)** — 175 SOP classes / 171 IODs / 98,469 rules, 99.44% condition coverage | 1 | L |
| Validation engine | `dcmjs.validate()` reports Type-1 violations on a CT with tag-level findings; streamable over 20 GB files | **DONE (PRs #63/#64)** — 3 layers, streaming listener, streamed≡eager gated | 1 | L |
| Charset completion | Every PS3.3 defined term decodes; write-side policy documented + opt-in preserve | **DONE (PRs #60/#62)** — incl. the write-coherence fix the new fixtures exposed | 1 | S+M |
| Typed IOD datasets | `DicomDataset<"1.2.840.10008.5.1.4.1.1.2">` compiles with Rows required; `asIod()` narrows at runtime | **DONE (PR #64)** — all 171 IODs typed, tsc-strict gated | 1 | M |
| TS compatibility matrix | Every transfer syntax × read/write/roundtrip cell backed by a test | **DONE (PR #66)** — COMPATIBILITY.md with the parse/carry/decode distinction | 1 | S |
| Codec registry | `dcmjs.codecs.register({transferSyntaxUID, decode, encode})` + one reference WASM codec package | not started | 2 | L |
| Pixel/Cornerstone contract | Written interop contract + `getFrame()` | not started | 2 | M |
| DICOMweb client | QIDO/WADO/STOW client, streaming retrieval, AbortSignal, browser CORS | not started | 2 | L |
| PS3.15 de-identification | `deidentify(ds, {profile, options})` with UID remapping + date shifting | anonymizer base | 3 | L |
| UID toolkit | generate/validate/remap/deterministic | half done | 3 | S |
| High-level SOP constructors | `new dcmjs.sop.Segmentation(...)` family on the IOD catalog | builders exist | 3 | L |
| Vendor private dictionaries | @dcmjs/private-siemens et al. pattern proven with one package | registry done | 3 | M |
| SR tree model + TID builders | Parse/build TID 1500 with coded concepts, UCUM | adapters exist | 4 | L |
| FHIR leadership | SR → DiagnosticReport + Observation | mappers exist | 4 | L |
| TS-first API + portability CI | Typed public surface; browser/worker CI | partial | 4 | M |
| DICOMDIR migrate polish | `dcmjs migrate DICOMDIR --to web --fhir` one-shot | mostly exists | 4 | S |

Don't-chase (settled; do not relitigate): DIMSE beyond an adapter
boundary, PACS, rendering (Cornerstone's job), full DCMTK parity.

---

## Tranche 1 — executor-ready design

Theme: turn the 1.0 architecture into semantic infrastructure. One
keystone (the Part 3 metadata pipeline) unlocks validation, typed IODs,
and — in tranche 3 — the SOP constructors. Verified against the actual
code, including an empirical probe of Node's TextDecoder label support.

### Workstream A — Part 3 semantic metadata pipeline (the keystone)

**Data source decision (team question #1 below):** recommend vendoring a
pinned snapshot of the Innolitics `dicom-standard` JSON artifacts
(`ciods.json`, `sops.json`, `ciod_to_modules.json`, `modules.json`,
`module_to_attributes.json`, plus the functional-group macro tables) —
they are factored exactly along our needs (SOP Class UID → CIOD →
modules with M/C/U usage → attributes with nested paths and Type
1/1C/2/2C/3 plus condition text). Believed MIT-licensed; **license text,
npm-vs-GitHub sourcing, and tracked DICOM edition must be verified
before the PR lands.** The generator gets an input-adapter seam so a
NEMA part03.xml DocBook parser can replace the source later without
changing the artifacts; a hand-curated top-20 subset is the emergency
fallback only.

**Artifacts (all generated, committed, diff-gated like the schema):**
- `generate/generate-iods.mjs` + `generate/buildIodCatalog.mjs` (pure)
  + `generate/iodRules.mjs` — mirrors the `generate-schema.mjs` /
  `buildCatalog.mjs` pattern exactly. Vendored data under
  `generate/data/dicom-standard/` with a `VERSION.md` (upstream SHA,
  DICOM edition, license notice, refresh commands).
- `src/schema/iodIndex.js` (~60–120 KB, eager): SOP Class UID → CIOD →
  module list with usage + condition text.
- `src/schema/iodModules.packed.js` (~2.5 MB source, ~300–450 KB
  gzipped): the big attribute table — per-module minified-JSON strings,
  lazily parsed and memoized on first use (`initPackedPrivate`
  philosophy), rows `{path: "00400275.00081080", type: "1C",
  condition?}` with a shared deduplicated conditions array. Zero cost
  unless layer-3 validation or `asIod` runs.
- `schema/iod.schema.json` — JSON-Schema projection of the index.
- Gate: `test/schema/iodCatalog.test.js` — regenerate-and-diff
  determinism plus invariants (every SOP resolves; every type/usage in
  the closed set; every 1C/2C carries condition text).

**Scope statement encoded in the generator:** conditions are carried as
text for reporting only; no machine evaluation in v1; 1C/2C never error.

### Workstream B — layered validation engine

`dcmjs.validate(datasetOrDict, options)` in `src/validation/`:

- **Layer 1 — structural** (no keystone needed): VR legality, VM vs
  dictionary (reuse `parseVm` from `generate/schemaRules.mjs`), value
  regex/length caps from `naturalizedRules`, UID format, charset-term
  legality and value-order rules.
- **Layer 2 — cross-field**: PixelData length vs
  Rows×Columns×SamplesPerPixel×bytes×frames (native TS; fragment/BOT
  coherence for encapsulated), BitsStored ≤ BitsAllocated, HighBit,
  palette descriptor coherence, transfer-syntax-vs-encapsulation
  coherence, FMI group length, declared-charset-vs-observed-bytes.
- **Layer 3 — IOD/module** (consumes A): SOP Class → CIOD; Type 1
  present+non-empty = ERROR, Type 2 present = ERROR, 1C/2C absent =
  INFO with the condition text, conditional modules INFO, unknown
  attributes INFO (rate-limited), unknown SOP Class = one WARNING.
- Result shape: `{ok, issues: [{severity, tag?, path?, module?, rule,
  message}], summary}` with stable namespaced rule ids
  (`iod.type1.missing`, `pixel.dataLength`, `charset.valueOrder`, …)
  filterable via `options.ignore`.
- **`ValidationListener`** implements the event-stream vocabulary so
  huge files validate streaming: layers 1+2 fire per element (PixelData
  length accumulated from fragment byte lengths, never buffered); a
  minimal collector (paths + a dozen scalars, no values) feeds layer 3
  at `finish()`. Memory is O(paths).
- CLI adoption (sibling repo, later): layers 1+2 become the `dcmjs
  validate` default; `--semantic` adds layer 3 until corpus calibration
  says it can be default. `scripts/corpus-runner.mjs` gains
  `--validate` for the calibration histogram.
- Test seeds: the issue-derived fixtures map straight onto rule ids
  (#338→`fmi.groupLength`, #487→`vm.count`, #398→`vr.maxLength`), plus
  a streamed-vs-eager parity gate over the fixture corpus.

### Workstream C — charset completion + corpus hardening

Verified remaining gaps (small!):
1. **ISO_IR 203 / ISO 2022 IR 203** (Latin-9): add mappings +
   the ESC handler. 2. **ISO 2022 IR 159** (JIS X 0212): decode by
   re-encoding GL pairs as EUC-JP SS3 (`0x8F, b|0x80, b|0x80`) through
   `TextDecoder("euc-jp")` — ~10 lines, no mapping tables. 3. Bare
   **`GB2312`** alias (real files declare it; validator flags the
   nonstandard term). 4. PN component-delimiter audit across all four
   read paths. 5. Node TextDecoder labels for every single-byte set
   verified present; legacy sets require full-ICU runtimes (documented;
   #297's fallback already degrades gracefully).
- New synthesized fixtures: `test/fixtures/charsets/` (Thai IR 166 —
  absent from the dclunie set — Latin-9, JIS X 0212, GB2312-literal,
  GB18030, multi-byte-value-1 edge) + `test/charset-completion.test.js`.
- **Write-side decision (team question #3):** keep normalize-to-UTF-8 as
  the documented default (conformant; already the pinned behavior), add
  opt-in `write({preserveSpecificCharacterSet: true})` writing from
  retained raw bytes where unmodified — dcmjs has no ISO 2022 encoder
  and building one is out of scope.

### Workstream D — typed IOD datasets

- Same generator emits `types/dcmjs-iods.d.ts`: per-CIOD interfaces
  extending `NaturalizedDataset` with Type 1/2 top-level attributes of
  mandatory modules made required (module/usage doc comments), the
  `SopClassDatasetMap` keyed by UID literal, and
  `DicomDataset<T extends SopClassUid>`.
- Runtime narrowing: `asIod(dataset, sopClassUid?)` runs layers 1+3 and
  throws an `IodValidationError` (carrying `.issues`) or returns the
  dataset — typed in the d.ts to return `DicomDataset<T>`.
- Wave 1 generates ALL ~130 CIODs (marginal cost zero, d.ts has no
  runtime weight); an allowlist constant is the escape hatch if the
  type-check gate slows past ~30 s. New gate:
  `types/checks/iod-consumer.ts` with positive and `@ts-expect-error`
  negative cases.

### PR slicing (stacked onto v2.0-development, sizes S/M/L)

| # | Branch | Content | Depends | Size |
|---|---|---|---|---|
| 1 | v2/charset-completion | C decode fixes + fixtures + suite | — | S |
| 2 | v2/iod-catalog | A entire (vendor, generators, artifacts, gate) | — | L |
| 3 | v2/validation-structural | B layers 1+2 + listener + collector + `validate()` | — | M/L |
| 4 | v2/validation-iod | B layer 3 + calibration | 2,3 | M |
| 5 | v2/iod-types | D types + `asIod` + gates | 2,4 | M |
| 6 | v2/charset-write-policy | C write option + docs | 1 | M |
| 7 | v2/corpus-hardening | Matrix assembly, promote gated tests, **ecosystem corpus acquisition (pydicom-data, gdcmData, Clunie sets) + validator calibration over it**, changelog | 1–5 | **M** |

Critical path 2→4→5; PRs 1, 2, 3 can start in parallel.

Pre-verified implementation notes an executor needs: the determinism
gates are jest tests (not workflow steps — `tests.yml` just runs
`pnpm test`); the packed-data precedent is `src/dicom.packed.js` with
lazy `registerPrivatesModule` wiring; files that change:
`src/constants/dicom.js`, `src/charset/iso2022.js`,
`src/DicomMessage.js`, `src/index.js`, `src/eventStream/index.js`,
`package.json` (exports `./schema/iods` + `./validation`, files,
scripts, check:types), `scripts/corpus-runner.mjs`,
`test/data-encoding.test.js`, `test/schema/exports.test.js`,
`License.txt`/NOTICE, `changelog.md`.

---

## Community knowledge mining

The mature toolkits' real asset isn't their code — it's thirty years of
community-discovered edge cases, encoded in four mineable forms. The
issue-tracker mining that produced ISSUE_TEST_PLAN.md (172 issues → 82
addressed) is the template; it generalizes to the whole ecosystem.

**1. Test corpora (feeds tranche 1 directly — added to PR 7).** Their
test *data* is downloadable files, no toolkit installation required:

- **pydicom-data** — a decade of contributed edge-case files (our
  dclunie charset fixtures share this lineage).
- **gdcmData / gdcmConformanceTests** — the gnarliest broken-file
  collection in the ecosystem; GDCM's read-anything reputation,
  published as evidence.
- **David Clunie's corpora** beyond the charset set (compression
  samples, edge-case IODs).

Run everything through `corpus-runner` and the new validator: layer-3
calibration then happens against thousands of real-world-shaped files
instead of our fixture shelf — resolving the calibration-corpus risk
without installing a single external comparator. (Check each corpus's
redistribution terms; cache like network fixtures, never commit.)

**2. Validator check lists (a free spec for layer 3).** `dciodvfy`
(Clunie's dicom3tools) is the reference IOD validator; its documented
checks and message catalog encode three decades of which-rules-
actually-matter triage. Mine the check lists and severity judgments —
dcm4che's validator likewise — so our rule set is designed from Part 3
*plus* field feedback, not Part 3 alone.

**3. Issue trackers (the pipeline already exists).**
`scripts/harvest-issues.mjs` is repo-agnostic modulo one constant.
pydicom's tracker especially: thousands of issues, many about *files*
(vendor quirks, broken encoders, charset horrors) rather than Python —
portable edge cases. Same triage taxonomy, same synthetic-reproducer
discipline. Every edge case mined from their tracker is an issue never
filed on ours.

**4. API designs (donors for tranches 3–4).** highdicom's constructor
signatures, defaults, and conformance decisions are the explicit model
for `dcmjs.sop.*` (Gap 6); dcm4che's PS3.15 implementation is the
design donor for tranche-3 de-identification; their test suites encode
the edge cases their communities found.

**The guardrail (one rule, held everywhere):** we mine data, documented
behavior, check lists, and API shapes — **never source translations**.
pydicom/highdicom are MIT and GDCM is BSD, but dcm4che has
GPL-adjacent parts, and one clean rule beats per-file license
analysis: knowledge in, code never. Same spirit as the tiered
attachment policy.

## Ralph loop state (tranche 1 close, 2026-08-30)

Four waves run against pydicom-data (MIT) + gdcmData (local-testing
only, never committed): baseline sweep, isolated re-sweep (after one
hostile file taught the harness per-file process isolation), the fix
wave (PR #65), and the post-fix verification sweep. Score: 329 files;
fails 38 → 28, divergences 4 → 1, nine hostile files cleared including
three bonus Philips private-sequence variants. The one remaining
divergence is deliberate: dcmjs decodes ISO 2022 Japanese person names
correctly where dicom-parser returns raw escape bytes.

The 28 remaining "fails" are dominated by corrective-error rejections
of deliberately hostile specimens (truncated files, bogus lengths,
mixed explicit/implicit VR) — correct behavior, cataloged in
corpus-cache/wave4.ndjson for the next mining session's triage. The
issue vein banked 1,097 pydicom issues (75 portable edge cases, 40
design lessons — several already folded into the fixes). **Status:
paused, not dry.** Unmined veins: the Clunie compression corpora,
dciodvfy's check catalog (layer-3 severity calibration), highdicom's
API designs (tranche 3), and re-triage of the remaining wave-4 ore.

## Tranches 2–4 (sketched; each gets its own design pass)

**Tranche 2 — pixels and the wire (Gaps 4, 5, 9).** The codec registry
abstraction in core (`dcmjs.codecs.register({transferSyntaxUID, decode,
encode})`) with one reference WASM codec package to prove the
@dcmjs/codec-* pattern; the written Cornerstone interop contract
(`pixelData.getFrame(dataset, n)` — who decodes, who owns LUT/VOI/
photometric semantics — decided intentionally, since we sit in both
projects); a first-class DICOMweb client (QIDO/WADO/STOW, streaming
retrieval, AbortSignal, auth hooks, browser CORS) presented through the
DicomAccess model so DICOMweb is "just another source". Acceptance: an
OHIF-class app can fetch, decode, and display through dcmjs-only code.

**Tranche 3 — semantics and safety (Gaps 11, 12, 6, 3).** PS3.15
confidentiality profiles on top of the anonymizer (profile + retain
options, deterministic UID remapping, date shifting, burned-in
annotation warnings) — a flagship for the NIH/research context; the UID
toolkit (validate/remap/deterministic); `dcmjs.sop.*` high-level
constructors generated against the tranche-1 IOD catalog (Secondary
Capture, Encapsulated PDF, SEG, SR family, Parametric Map, Key Object
Selection, Presentation State); the first vendor private-dictionary
package to prove @dcmjs/private-*. Acceptance: `deidentify()` passes a
PS3.15 profile conformance checklist; a valid SEG builds without
hand-rolled tag dictionaries.

**Tranche 4 — the connective tissue (Gaps 15, 14, 16, 17, 13).** SR
tree model and TID 1500/1410/300 builders (the OHIF strength, made
foundation-grade); SR → FHIR DiagnosticReport + Observation (territory
no C++/Python toolkit owns); the TypeScript-first public API surface;
runtime-portability CI (browser + worker matrix, later Deno/Bun);
DICOMDIR `migrate` polish. Acceptance: a measurement drawn in OHIF
round-trips DICOM SR → FHIR Observation → back, typed end to end.

## Open questions for the team

1. **Part 3 data source**: Innolitics `dicom-standard` JSON (verify
   license text, npm packaging, DICOM edition) vs our own part03.xml
   parser vs curated subset. Recommendation: Innolitics snapshot with
   an adapter seam.
2. **External comparators** (DCMTK/pydicom/dcm4che/GDCM) for the
   conformance corpus: deferred by decision 2026-08-29; revisit when
   tranche 1 lands.
3. **Write-side charset policy**: normalize-to-UTF-8 default +
   opt-in raw preservation (recommended) vs full charset-preserving
   encoder (large; not recommended for v2).
4. **v2 semver policy**: what breaks? (Candidates: none required by
   tranche 1 — everything is additive. The lazy core's scheduled
   removal is the first real break.)
5. Carried from 1.x: FHIR Endpoint.address defaults, Encounter→DICOM
   mapping scope, gender mapping ratification, DICOM-in-FHIR
   embed-vs-reference line.
6. **Bundle-size tolerance** for the packed IOD table (~2.5 MB source /
   ~350 KB gzipped) in the rollup build — measure in PR 2; the
   registerPrivatesModule-style slim entry is the fallback.
7. **Ecosystem corpus redistribution**: pydicom-data / gdcmData /
   Clunie corpora are cached like network fixtures, never committed —
   verify each set's redistribution terms when wiring PR 7.
8. **Tranche 2 pull-forward?** The internal next-generation-PACS
   project will lean on the DICOMweb client and codec registry early;
   if it starts before tranche 1 completes, consider promoting the
   DICOMweb client from tranche 2 into a parallel workstream.

## Working agreements (carried forward)

- Feature branches + open PR chain onto `v2.0-development`; periodic
  merges; plain-language PR bodies with runnable examples.
- All generated artifacts carry a jest determinism gate.
- Fixtures use JANE DOE / JANE FOX identities, fictional UIDs; issue
  attachments follow the tiered policy in ISSUE_TEST_PLAN.md (diagnose
  transiently → synthesize → verified-anonymized → never retain).
- Every doc ships with a plain-language pass; implementors are DICOM
  veterans and newcomers alike.
