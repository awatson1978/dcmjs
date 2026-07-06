---
title: Roadmap
---

# Roadmap: toward the best JavaScript DICOM reader and writer

This page is the project's engineering plan — the step-by-step migration that
turns dcmjs into a single library with the fastest practical read path and a
byte-faithful write path, and what remains to finish that vision. It started as
the internal rewiring plan for the 1.0 work (generated 2026-06-09 from a
cross-repository analysis of dcmjs and dicom-parser) and is now maintained here
as the living roadmap.

The end state we are building toward:

- **One read core**: the lazy, offsets-only tokenizer (vendored from
  dicom-parser) under every read path, including streaming - no value is ever
  decoded before something asks for it.
- **One write path**: untouched elements pass through as verbatim source
  bytes; only edits are re-encoded; every transfer syntax (including deflate)
  writes correctly.
- **A typeable, tree-shakable surface**: layered packages (parser, data model,
  dictionary, streaming, features) with real subpath exports and TypeScript
  definitions.
- **Honest semantics**: documented value shapes, lossless round trips for
  private tags, machine-readable diagnostics instead of silent fallbacks.

## Where we are

Status as of 2026-06-10 — executed through step 6, version 1.0.0-beta.0 (NOT published).

| Section | Status | Commit |
| --- | --- | --- |
| R0 parser intake | DONE | ee33089 |
| R1 tag-key unification | DONE | bcdfb49 |
| R2 lazy bridge | DONE (default core since fd526c3) | bcdfb49 |
| R3 naturalize over lazy | PARTIAL — works unchanged, gated; lazy keyword facade + VM-driven shapes not built | bcdfb49 |
| R4 writer fusion | DONE (passthrough, backpatch, deflate-on-write) | 2703b90 |
| R5 character sets | DONE (per-dataset + per-item contexts; ISO_IR 192 rewrite kept) | bcdfb49 |
| R6 streaming | PARTIAL — scoped fixes only; full re-platform deferred to 1.x | fd526c3 |
| R7 deletions | PARTIAL — see R7 section; eager core kept as escape hatch for beta | fd526c3 |
| R8 gates | All standing gates green (see R8) | — |

Additional work since 2026-06-10: the event-stream layer (slices A–G and J, tracked in
`CLAUDE_REFACTOR_PLAN.md`) is complete. `src/core/decodeCore.js` is now the shared decode
module consumed by both `readFileLazy` and `fromPart10`; `fromPart10`'s whole-file delegation
to the lazy reader is removed. The `AsyncDicomReader` re-platform (R6) remains deferred.

Remaining for 1.0 final / 1.x: the full R6 streaming re-platform of
AsyncDicomReader onto the tokenizer; deleting the eager read loop once the beta
soak is over; the packaging subpath split and TypeScript surface; and the four
open API decisions at the bottom of this page.

## Founding decisions

- dcmjs becomes a pnpm monorepo; the dicom-parser tokenizer is vendored whole as
  `packages/parser` (private workspace package). Only `dcmjs` publishes.
- dcmjs 1.0 is a breaking release. No `dicom-parser` npm shim, no 0.x compat layer.
- The legacy eager reader (`DicomMessage._read` and the stream-driven read path) is
  **deleted** once the equivalence suite passes — not kept behind a flag.

:::note Execution divergence
The eager core was kept as the `DCMJS_CORE=eager` escape hatch for the beta,
and `_read`/`_readTag` are still required internally by AsyncDicomReader until
the R6 re-platform. Final deletion is on the 1.x backlog in R8.
:::

- Internal tag identity is numeric (`(group << 16 | element) >>> 0`, dcmjs `Tag.value`).
  String keys survive only at public API boundaries.

---

## R0. Parser-package intake — changes made inside the vendored tokenizer

> STATUS: DONE (ee33089). All four items landed plus later hardening: UV/SV/OV
> 4-byte framing, eager-aligned unknown-VR fallback, explicit FFFE delimiter
> framing, and deflate streams no longer re-walk the preamble (bcdfb49).
> Parser suite: 245 tests, offline.

The tokenizer arrives verbatim except for the following. These are safe because the
parser is now our package with no external consumers; all of them happen during the
port so they are covered by the ported byte-level test suite from day one.

1. **Fix the two `warnings()`-called-as-function crashes**
   (`findItemDelimitationItem.js:31`, `findAndSetUNElementLength.js:32` → `warnings.push(...)`),
   then delete `findAndSetUNElementLength.js` (duplicate of findItemDelimitationItem).
2. **Stable element shape + two new fields.** Construct every element as one object
   literal with all fields present (kills hidden-class transitions):

   ```js
   {
     tag,                    // 'x' + 8 lowercase hex (kept for parser-internal use)
     tagValue,               // NEW: numeric (group << 16 | element) >>> 0
     vr, length, dataOffset,
     startOffset,            // NEW: byte offset where the tag itself begins
     endOffset,              // NEW: byteStream.position after the element is fully
                             //      consumed, INCLUDING any item/sequence delimiters
     hadUndefinedLength, parser, items, fragments,
     basicOffsetTable, encapsulatedPixelData, Value
   }
   ```

   `startOffset`/`endOffset` are the prerequisite for the passthrough writer (R4).
   Header start is not recoverable from the upstream element (`dataOffset` is
   post-header, and the length-field size depends on VR), and corrected lengths for
   undefined-length elements exclude delimiter items — recording the span explicitly
   removes both ambiguities. Cost: two integer fields per element.
3. **Fix the `dataSet.string()` footguns** (`dataSet.js:180` Value escape hatch ignores
   `index`; out-of-range index throws TypeError) and the `omitPrivateAttibutes` typo.
4. **Mechanical perf fixes with no behavior change** (each with a test):
   `Uint8Array.set` fragment assembly (`readEncapsulatedPixelDataFromFragments.js:107-113`),
   scratch-buffer float/double reads, numeric peek in `isSequence`/delimiter loops,
   interned VR + length-size lookup table.

Everything else in the parser — including `readFixedString`'s byte-identity latin
semantics — stays byte-for-byte identical. Charset awareness does **not** go into the
parser; it lives in the data layer (R5). See
[the parser package](../architecture/parser-package.md).

---

## R1. Tag-key unification

> STATUS: DONE (bcdfb49). tagValue numeric internally; public dict keys remain
> clean uppercase strings; conversions live at the wrapLazy boundary.

Three incompatible formats existed. Conversions happen exactly once, at the seams:

| Format | Example | Where it lived | In 1.0 |
| --- | --- | --- | --- |
| parser key | `x00080005` ('x' + lowercase) | `readTag.js:18`, elements map | parser-internal only |
| dcmjs dict key | `00080005` (uppercase, no punct.) | `Tag.toCleanString` (`Tag.js:37-42`), `DicomDict.dict` | public dict keys (unchanged) |
| dictionary key | `(0008,0005)` (punctuated) | `nameMap`, `punctuateTag` (`DicomMetaDictionary.js:15-23`) | dictionary-internal; lookups become numeric |
| numeric | `0x00080005 >>> 0` | `Tag.value` (`Tag.js:101`) | **the internal identity everywhere** |

Bridge helpers (in the data layer, not the parser):

```js
const parserKeyToClean = k => k.slice(1).toUpperCase();        // 'x00080005' -> '00080005'
const tagValueToClean = v => v.toString(16).padStart(8, '0').toUpperCase();
```

Dictionary lookups (`DicomMessage.lookupTag`, naturalize) are re-keyed by `tagValue`
through a lazily built `Map<number, entry>` over the packed tables — this also removes
the per-element `punctuateTag` regex and the dictionary Proxy get-trap from hot paths.

---

## R2. The lazy bridge — `DicomMessage.readFile` on parser output

> STATUS: DONE (bcdfb49); DEFAULT core since fd526c3 (DCMJS_CORE=eager is the
> escape hatch). Implemented in src/lazy/LazyDicomReader.js. Gates: 150/150
> equivalence cells; full suite identical on both cores. Documented intentional
> divergences: value-level errors surface at first access (under
> ignoreErrors:true they warn + yield undefined instead of truncating the
> dict); tokenizer-rejected streams take a whole-file eager fallback;
> charset-scope approximations for non-conformant element ordering.

This is the central rewiring. `readFile` becomes:

```
parser.parseDicom(new Uint8Array(buffer), parserOptions)   // offsets only, fast
  -> wrapLazy(dataSet)                                     // O(#elements), no decoding
  -> DicomDict { meta, dict }                              // entries materialize on access
```

The lazy dict entry keeps the eager `{ vr, Value, _rawValue }` observable shape,
but `Value`/`_rawValue` are getter-backed: on first access a windowed
`ReadBufferStream` is opened over the element's byte range and the existing
`ValueRepresentation` classes decode it (no VR-class rewrite was needed —
`ReadBufferStream` already supported `{start, stop}` windows). Results are
cached; setters replace the cached value and mark the entry dirty for the
writer (R4).

Special paths that bypass the generic window:

- `SQ`: the parser already produced parsed item dataSets structurally —
  `Value` is the items mapped through the same lazy wrapper, recursively. No
  byte rescans.
- Encapsulated PixelData: frames assembled from the parser's fragment/basic
  offset table indexes.
- `UN` with a dictionary hit: the `ParsedUnknownValue` re-parse behavior is
  preserved for read-result equivalence.
- Tokenizer-rejected streams (declared-length overruns, missing meta pieces):
  a clearly-marked whole-file eager fallback returns the eager core's own
  result, byte-identical by construction.

Full mechanics: [Lazy core](../architecture/lazy-core.md).

---

## R3. `naturalizeDataset` over lazy entries

> STATUS: PARTIAL. Naturalize works unchanged over lazy entries (gated by the
> full suite on the lazy core, incl. data.test.js + charset suites). NOT built:
> the phase-2 lazy keyword facade, VM-driven value shapes, private-tag-preserving
> denaturalize, and the DicomDataset class for `_meta`/`_vrMap` — all tied to the
> open 1.0 API decisions below.

`naturalizeDataset` reads exactly `data.vr`, `data.Value`, `data.BulkDataURI`,
`data.InlineBinary` per entry. The lazy entry satisfies that contract via its
getters, so naturalize works unchanged — it simply materializes everything it
touches, which is what it means semantically ("give me the whole dataset as
keywords").

Phase-2 option (not required for 1.0): a lazy naturalized facade —
`defineProperty` getters per keyword generated from the dictionary — so
`ds.PatientName` materializes one element instead of all. The facade is additive.

1.0 API decisions to make here (all breaking-allowed):

- **Scalar collapse**: switch to VM-driven shapes (VM 1 → scalar, VM 1-n →
  always array), or keep instance-driven collapse for OHIF familiarity.
  Recommended: VM-driven — it is the thing 0.x could never fix.
- **Private tags**: naturalize records `vr` for hex-named entries into `_vrMap`
  (today it records nothing for them), denaturalize re-emits hex-named entries
  under their tag — closes the silent private-tag loss.
- `_meta`/`_vrMap` formalized on a `DicomDataset` class rather than magic keys.

See [Naturalized datasets](../guides/naturalized-datasets.md) for the current
behavior and footguns.

---

## R4. Writer fusion — passthrough + backpatch

> STATUS: DONE (2703b90). Backpatch writer (SR writes 1.76x, large values
> 3.23x, byte-identical output proven over 22 adversarial datasets incl. BE);
> passthrough with zero-copy windows for >=64KB spans, SQ structural-edit
> detection, non-default writeOptions disable passthrough; deflate-on-write
> (also fixed the pre-existing uncompressed-deflate bug). Caveat: the charset
> passthrough gate is conservative — ISO_IR 100 sources always re-encode; a
> per-element ASCII fast path is possible 1.x work. In-place mutation of
> materialized values remains undetectable by design (documented).

`DicomDict.write` keeps its shape (preamble, DICM, meta with group length, then
body). Two changes inside:

1. **Passthrough fast path.** For each entry, if the entry is clean (never
   assigned), the target body syntax matches the source, and the source charset
   is passthrough-safe, emit `byteArray.subarray(span.startOffset, span.endOffset)`
   directly — header, value, items, and delimiters byte-identical, including
   whole SQ subtrees and the entire encapsulated PixelData run. This is why R0
   records the span including delimiters. Dirty tracking comes from the `Value`
   setter; a dirty item inside a sequence dirties the whole SQ element, and
   structural item edits are detected at write time.
2. **Re-encode path rework** for dirty/new elements: direct writes into the
   destination stream with 2/4-byte length backpatching replaced the
   per-element temp stream and its double-copy concat (pre-measure only for the
   rare Big16 case).

Transfer-syntax conversion disables passthrough globally and takes the
re-encode path for every element — same correctness as before, no worse.

Gates: the full lossless-read-write suite unchanged, plus byte-identity tests
asserting that read → write with zero edits reproduces the input body
byte-for-byte for every eligible fixture (a guarantee 0.x never had).
Details: [Writer](../architecture/writer.md).

---

## R5. Character sets

> STATUS: DONE (bcdfb49). Decoder resolved once per dataset at wrap time;
> per-sequence-item override contexts (exceeds eager's single-charset support);
> ISO_IR 192 normalize-on-read quirk kept (decision still open below). Known
> approximation: charset applies per-dataset/per-item, not per stream position
> — diverges only on non-conformant ordering (documented in code).

In the lazy model there is no read-time loop to swap the decoder mid-stream, so:

- The decoder is resolved once per dataset at wrap time from `(0008,0005)`,
  mapped through `encodingMapping`, and installed on every materialization
  window.
- Sequence items that carry their own `(0008,0005)` get their own context
  inheriting the parent's decoder unless overridden — this exceeds the 0.x
  single-charset support.
- Open decision: keep or drop the 0.x quirk of rewriting the stored value to
  `["ISO_IR 192"]` and re-encoding strings as UTF-8 on write. Recommended:
  keep (normalize-on-read is a feature), but make it explicit in the result.
- The parser's raw accessor tier keeps byte-identity latin semantics — charset
  awareness is a data-layer concern only.

See [Character sets](../guides/character-sets.md).

---

## R6. Streaming (deferred phase)

> STATUS: PARTIAL (fd526c3). Landed: readUint16Array off-by-one fix, shared
> default TextDecoder/TextEncoder singletons, SplitDataView cached last-hit
> chunk index for sequential streaming reads. NOT done: re-platforming
> AsyncDicomReader onto the tokenizer (it still runs its own header/element
> logic over SplitDataView and still calls DicomMessage._read for the meta
> group) — deliberate 1.x work.

`AsyncDicomReader` duplicates header/element logic and reads through
`SplitDataView.findView` per primitive. Re-platforming it onto the parser is the
hardest rewiring because the parser assumes one contiguous buffer while the
async reader works over chunk lists with `ensureAvailable`/`consume`.

The eventual shape: the parser's element readers run over the contiguous window
`SplitDataView` can guarantee (`hasData`), falling back to `ensureAvailable`
awaits at element boundaries; `SplitDataView` stays confined to the streaming
layer. See [Streaming](../architecture/streaming.md).

---

## R7. Deletions

> STATUS: PARTIAL (fd526c3). DONE: deprecated DicomMessage.read/readTag statics
> removed; src/dicomweb.js deleted; _generateNameMap is a lazy one-shot static
> getter; private-dictionary registration is a thin lazy lambda; loglevel root
> no longer touched at import (named child logger 'dcmjs'); readUint16Array
> off-by-one fixed; TextDecoder/Encoder singletons. NOT done (deliberate):
> DicomMessage._read/_readTag and the eager element classes are KEPT — the
> eager core remains the DCMJS_CORE=eager escape hatch for the beta soak and
> AsyncDicomReader still depends on _read for its meta group; delete after R6
> re-platform + beta confidence. The circular-dependency setters in index.js
> also remain until the package split makes them unnecessary.

The remaining deletion list, executed once the gates allow:

- `DicomMessage._read`, `_readTag` — the entire eager loop.
- `SequenceOfItems.readBytes` scan-rewind reader and the eager
  `BinaryRepresentation.readBytes` frame logic (replaced by the parser toolkit).
- The circular-dependency setters (`setDicomMessageClass` / `setTagClass`) —
  package layering makes them unnecessary.

---

## R8. Order of operations and gates

- [x] 1. R0 parser intake + ported byte-level suites + corpus — DONE ee33089
      (gate met: 245 parser tests green offline).
- [x] 2. Benchmark + bundle-size gates — DONE d8e4fc3 (`bench:parser` vs
      published dicom-parser@1.8.21: geomean ~0.85, vendored faster on every
      file; `gate:parser-bundle`: 29 modules all in-package, ~88 kB, zero
      side effects).
- [x] 3. R1 + R2 lazy bridge — DONE bcdfb49 (gates met: 150/150 equivalence
      cells over all local fixtures incl. deflate + encapsulated; full suite
      identical on both cores; review-driven hardening included).
- [x] 4. R3 naturalize + R5 charset gates — MET via the forced-lazy full-suite
      run (data.test.js + charset suites green on the lazy core). The R3 API
      redesigns themselves remain open decisions (below).
- [x] 5. R4 writer fusion — DONE 2703b90 (gates met: lossless-read-write suite
      both cores; byte-identity rewrite suite over the corpus; writer-hardening
      review findings fixed).
- [x] 6. R7 deletions + 1.0.0-beta.0 — DONE fd526c3 (partial by design: eager
      core kept as DCMJS_CORE=eager escape hatch until R6 re-platform + beta
      soak). NOT published.
- [ ] 7. R6 streaming re-platform — NOT DONE (1.x; scoped fixes landed in
      fd526c3: readUint16Array fix, codec singletons, cached-chunk fast path).

### 1.x backlog

- [ ] Re-platform AsyncDicomReader onto the tokenizer (R6) so streaming and
      synchronous reads share one element reader.
- [ ] Delete the eager read loop (`_read`/`_readTag` + eager element classes)
      once AsyncDicomReader is re-platformed and the beta has soaked.
- [ ] Packaging: subpath exports / workspace-package split (data, dictionary,
      streaming, features), `sideEffects: false`, types entry — deferred since
      nothing is being published yet.
- [ ] TypeScript surface (seed exists at `packages/parser/index.d.ts`).
- [ ] Per-element ASCII fast path to widen the charset passthrough gate
      (ISO_IR 100 sources currently always re-encode).
- [ ] Lazy naturalized facade (R3 phase 2): per-keyword getters so
      `ds.PatientName` materializes one element instead of the whole dataset.

## Open 1.0 API decisions

All four are still open as of 2026-06-10 and need owner sign-off:

1. **Scalar collapse**: move naturalized value shapes to VM-driven (VM 1 →
   scalar, VM 1-n → always array) instead of instance-driven collapse?
   Recommended yes; breaking for code that relies on single-value collapse.
2. **ISO_IR 192 normalize-on-read**: keep rewriting `SpecificCharacterSet` to
   UTF-8 on read (with `_rawValue` preserved), or surface the original charset?
   Recommended keep, with the original exposed explicitly.
3. **Binary values as views by default**: return zero-copy views over the
   source buffer instead of copies? Saves memory; aliases the input buffer.
4. **Public dict key format**: keep clean uppercase string keys (current) with
   numeric tags internal, or expose numeric keys? The plan assumes string keys
   stay.

---

:::info Provenance
This page absorbed `docs/REWIRING-PLAN.md`, the engineering log used to plan and
execute the 1.0 merge; that file was removed when this page became the living
roadmap, and its full step-by-step history remains in git. The original
cross-repository analysis dossier (`dicom-merge-analysis-report.html`) lives in
the dicom-parser worktree that seeded this work.
:::
