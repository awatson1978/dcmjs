# Rewiring Plan: dcmjs 1.0 on the dicom-parser tokenizer

Status as of 2026-06-10 — executed through R8 step 6, version 1.0.0-beta.0 (NOT published).

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

Remaining for 1.0 final / 1.x: full R6 streaming re-platform of AsyncDicomReader
onto the tokenizer; delete the eager read loop once beta soak is over; packaging
subpath split + TypeScript surface; README/API docs; the four open API decisions
at the bottom of this file.

Generated 2026-06-09 from the cross-repo analysis
(see `dicom-merge-analysis-report.html` in the dicom-parser worktree for the full dossier).

## Decisions this plan assumes

- dcmjs becomes a pnpm monorepo; the dicom-parser tokenizer is vendored whole as
  `packages/parser` (private workspace package). Only `dcmjs` publishes.
- dcmjs 1.0 is a breaking release. No `dicom-parser` npm shim, no 0.x compat layer.
- The legacy eager reader (`DicomMessage._read` and the stream-driven read path) is
  **deleted** once the equivalence suite passes — not kept behind a flag.
  (EXECUTION DIVERGENCE: the eager core was kept as the `DCMJS_CORE=eager`
  escape hatch for the beta, and `_read`/`_readTag` are still required
  internally by AsyncDicomReader until the R6 re-platform. Final deletion is
  on the 1.x backlog in R8.)
- Internal tag identity is numeric (`(group << 16 | element) >>> 0`, dcmjs `Tag.value`).
  String keys survive only at public API boundaries.

---

## R0. Parser-package intake — changes made *inside* the vendored tokenizer

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
   literal with all fields present (kills hidden-class transitions, see perf target list):

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
   Today header start is *not recoverable* from the element (`dataOffset` is post-header,
   and the length-field size depends on VR), and corrected lengths for undefined-length
   elements *exclude* delimiter items — recording the span explicitly removes both
   ambiguities. Cost: two integer fields per element.
3. **Fix the `dataSet.string()` footguns** (`dataSet.js:180` Value escape hatch ignores
   `index`; out-of-range index throws TypeError) and the `omitPrivateAttibutes` typo.
4. **Mechanical perf fixes with no behavior change** (each with a test):
   `Uint8Array.set` fragment assembly (`readEncapsulatedPixelDataFromFragments.js:107-113`),
   scratch-buffer float/double reads, numeric peek in `isSequence`/delimiter loops,
   interned VR + length-size lookup table.

Everything else in the parser — including `readFixedString`'s byte-identity latin
semantics — stays byte-for-byte identical. Charset awareness does **not** go into the
parser; it lives in the data layer (R5).

---

## R1. Tag-key unification

> STATUS: DONE (bcdfb49). tagValue numeric internally; public dict keys remain
> clean uppercase strings; conversions live at the wrapLazy boundary.

Three incompatible formats exist today. Conversions happen exactly once, at the seams:

| Format | Example | Where it lives today | In 1.0 |
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
  -> wrapLazy(dataSet)                                   // O(#elements), no decoding
  -> DicomDict { meta, dict }                            // entries materialize on access
```

### 2a. Parser options mapping

| dcmjs readFile option | parser option |
| --- | --- |
| `untilTag` ('00080060' clean string) | `untilTag: 'x00080060'` (note: parser semantics are *inclusive* — the element at untilTag is read; matches `includeUntilTagValue: true`; for `false`, drop the materialized value at wrap) |
| `ignoreErrors` | catch parser's `{ exception, dataSet }` throw (`parseDicom.js:146-153`) and wrap the partial dataSet; surface `dataSet.warnings` as `result.warnings` |
| `noCopy` | obsolete — lazy binary values are views by default in 1.0 (breaking, intended) |
| `forceStoreRaw` | handled in the lazy entry (see 2c) |
| (new) deflate | pass `inflater` through; pako wired as the default inflater by the data layer, injectable |

The meta header arrives merged into the same elements map (`parseDicom.js:116-128`,
group `0002` elements carry `.parser` overrides) — `wrapLazy` splits on
`tagValue >>> 16 === 0x0002` to populate `DicomDict.meta` vs `.dict`.

### 2b. Per-dataset materialization context

Built once per wrapped dataset:

```js
{
  byteArray,                 // the source Uint8Array (retained for element lifetime)
  syntax,                    // transfer syntax UID resolved by parser
  decoder,                   // TextDecoder resolved from x00080005, see R5
  vrLookup,                  // numeric-tag -> VR for implicit files (dictionary, lazy)
}
```

### 2c. The lazy dict entry

Replaces the eager `{ vr, Value, _rawValue }` built at `DicomMessage.js:107-111`.
Same observable shape, deferred work:

```js
function lazyEntry(el, ctx) {
  let state = null;          // { value, rawValue } once materialized
  const vrType = el.vr ?? ctx.vrLookup(el.tagValue) ?? 'UN';
  return ValueRepresentation.addTagAccessors({
    vr: vrType,
    get Value()     { return (state ??= materialize(el, ctx)).value; },
    set Value(v)    { state = { ...(state ?? materialize(el, ctx)), value: v }; markDirty(el); },
    get _rawValue() { return (state ??= materialize(el, ctx)).rawValue; },
    _sourceSpan: el,         // { startOffset, endOffset } -> consumed by the writer (R4)
  });
}
```

Notes:
- `addTagAccessors` (`ValueRepresentation.js:146-156`) keeps the PN/value-formatting
  set-trap contract intact — the proxy wraps the lazy object exactly as it wraps the
  eager one today. Setting `Value` marks the element dirty (R4).
- Getter-based laziness means `JSON.stringify(dict)` and deep iteration materialize
  everything — same end state as today's eager reader, so no behavioral cliff.

### 2d. `materialize()` — reusing the VR classes unchanged

Key discovery: **`ReadBufferStream` already supports `{start, stop}` windows**
(`BufferStream.js:465-491`). So materialization needs *no VR-class rewrite*:

```js
function materialize(el, ctx) {
  const stream = new ReadBufferStream(ctx.byteArray.buffer, ctx.littleEndian, {
    start: ctx.byteArray.byteOffset + el.dataOffset,
    stop:  ctx.byteArray.byteOffset + el.dataOffset + el.length,
  });
  stream.setDecoder(ctx.decoder);
  const vr = ValueRepresentation.createByTypeString(el.vrForRead); // incl. ParsedUnknownValue path for UN+dictionary
  return vr.read(stream, el.length, ctx.syntax, { forceStoreRaw: ctx.forceStoreRaw });
  // -> { rawValue, value } — exactly the entry's two fields (ValueRepresentation.js:192-218)
}
```

- One small stream allocation per *first access* of an element, then cached. This is the
  correctness-first bridge; the report's perf targets for `readAsciiString` /
  `readEncodedString` / shared TextDecoder singletons then optimize the inside of this
  path without touching its contract. A later phase can add direct
  `readFromBuffer(byteArray, offset, length)` fast paths per VR family.
- **Special cases that bypass the generic path:**
  - `SQ`: do **not** call `SequenceOfItems.readBytes` (the scan-rewind reader dies).
    `el.items[]` from the parser already contains parsed item dataSets
    (`readSequenceElementExplicit.js:80-96`); `Value` = `items.map(it => wrapLazy(it.dataSet, ctx))`.
    Recursion is structural, not byte-scanning.
  - Encapsulated pixel data (`el.encapsulatedPixelData === true`): `Value` = a lazy
    frame array backed by `readEncapsulatedImageFrame(dataSet, el, i)` — zero-copy
    single-fragment frames via `sharedCopy`. dcmjs's frame logic in
    `BinaryRepresentation.readBytes` (`ValueRepresentation.js:508-636`), including the
    wrong 1-fragment=1-frame no-BOT assumption, is replaced by the parser toolkit +
    `createJPEGBasicOffsetTable` for the no-BOT JPEG case.
  - Unencapsulated OB/OW/UN: `Value` = `[sharedCopy(byteArray, dataOffset, length)]`
    view (1.0 default: views, copy on request).
  - `UN` with a dictionary hit: preserve today's `ParsedUnknownValue` re-parse behavior
    (read as the dictionary VR) — it is part of read-result equivalence.

### 2e. What `_readTag`/`_read` callers need instead

- `DicomDict.upsertTag` (`DicomDict.js:15-23`) — unchanged; it writes `Value`, which
  the lazy entry's setter handles (and marks dirty).
- `AsyncDicomReader` calls `DicomMessage._read` for the meta group
  (`AsyncDicomReader.js:51`) — point it at the parser's `readPart10Header` instead
  (R6, later phase).
- `DICOMWEB` and the deprecated `read`/`readTag` statics — deleted in 1.0, nothing to rewire.

---

## R3. `naturalizeDataset` over lazy entries

> STATUS: PARTIAL. Naturalize works unchanged over lazy entries (gated by the
> full suite on the lazy core, incl. data.test.js + charset suites). NOT built:
> the phase-2 lazy keyword facade, VM-driven value shapes, private-tag-preserving
> denaturalize, and the DicomDataset class for _meta/_vrMap — all tied to the
> open 1.0 API decisions below.

`naturalizeDataset` reads exactly `data.vr`, `data.Value`, `data.BulkDataURI`,
`data.InlineBinary` per entry (`DicomMetaDictionary.js:137-149`). The lazy entry
satisfies that contract via its getters, so **naturalize works unchanged on day one** —
it simply materializes everything it touches, which is what it means semantically
("give me the whole dataset as keywords").

Phase-2 option (not required for 1.0): a lazy naturalized facade — `defineProperty`
getters per keyword generated from the dictionary — so `ds.PatientName` materializes
one element instead of all. Ship eager-naturalize first; the facade is additive.

1.0 API decisions to make here (all breaking-allowed):

- **Scalar collapse** (`DicomMetaDictionary.js:168-182`): switch to VM-driven shapes
  (VM 1 → scalar, VM 1-n → always array) per the DevX findings, or keep instance-driven
  collapse for OHIF familiarity. Recommended: VM-driven, it is the thing 0.x could
  never fix.
- **Private tags**: naturalize records `vr` for hex-named entries into `_vrMap` (today
  it records nothing for them), denaturalize re-emits hex-named entries under their tag
  — closes the silent private-tag loss.
- `_meta`/`_vrMap` formalized on a `DicomDataset` class rather than magic keys.

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

`DicomDict.write` (`DicomDict.js:25-52`) keeps its shape (preamble, DICM, meta with
group length, then body via `DicomMessage.write`). Two changes inside:

1. **Passthrough fast path.** For each entry, if
   `entry is clean (never materialized-and-set) AND target syntax === source syntax
   AND charset unchanged`, emit
   `byteArray.subarray(span.startOffset, span.endOffset)` directly — header, value,
   items, and delimiters byte-identical, including whole SQ subtrees and the entire
   encapsulated PixelData run. This is why R0 records the span including delimiters.
   Dirty tracking: `markDirty` from the `Value` setter; a dirty item inside a sequence
   dirties the whole SQ element (first iteration; finer-grained item passthrough later).
2. **Re-encode path rework** for dirty/new elements: replace the per-element
   `new WriteBufferStream(256)` + double-copy `concat` (`Tag.js:135-209`,
   `BufferStream.js:336-346`) with direct writes into the destination stream and
   2/4-byte length backpatching (pre-measure only for the rare `isBig16Length` case,
   `Tag.js:187-196`). `_getTagWriteValues`' applyFormatting + `deepEqual` diffing
   (`DicomMessage.js:244-267`) becomes unnecessary for clean elements — the dirty flag
   replaces the diff.

Transfer-syntax conversion (e.g. implicit → explicit) disables passthrough globally and
takes the re-encode path for every element — same correctness as today, no worse.

Gates: the full lossless-read-write suite unchanged, plus new byte-identity tests
asserting that read → write with zero edits reproduces the input file byte-for-byte
for every fixture (a guarantee 0.x never had).

---

## R5. Character sets

> STATUS: DONE (bcdfb49). Decoder resolved once per dataset at wrap time;
> per-sequence-item override contexts (exceeds eager's single-charset support);
> ISO_IR 192 normalize-on-read quirk kept (decision still open below). Known
> approximation: charset applies per-dataset/per-item, not per stream position
> — diverges only on non-conformant ordering (documented in code).

Today the decoder is swapped mid-stream when the read loop passes tag `00080005`
(`DicomMessage.js:77-105` → `stream.setDecoder`), and consumed only by
`readEncodedString` (`BufferStream.js:308-318`).

In the lazy model there is no read-time loop, so:

- `wrapLazy` resolves the decoder **once** per dataset: read `x00080005` from the parser
  elements eagerly (tiny element, `dataSet.string()` semantics), map through
  `encodingMapping`, build the `TextDecoder`, store on the materialization context.
  Every windowed stream gets `setDecoder(ctx.decoder)` before `vr.read`.
- DICOM's "different charset per sequence item via 0008,0005 inside the item" corner:
  resolve per wrapped dataSet (items get their own context inheriting the parent's
  decoder unless overridden) — this actually *exceeds* today's single-charset support.
- Decision: keep or drop the 0.x quirk of rewriting the stored value to
  `["ISO_IR 192"]` and re-encoding strings as UTF-8 on write. Recommended: keep
  (normalize-on-read is a feature), but make it explicit in the result
  (`dataset.originalCharacterSet`).
- The parser's raw accessor tier (`dataSet.string()`) keeps byte-identity latin
  semantics — charset awareness is a data-layer concern only.

---

## R6. Streaming (deferred phase)

> STATUS: PARTIAL (fd526c3). Landed: readUint16Array off-by-one fix, shared
> default TextDecoder/TextEncoder singletons, SplitDataView cached last-hit
> chunk index for sequential streaming reads. NOT done: re-platforming
> AsyncDicomReader onto the tokenizer (it still runs its own header/element
> logic over SplitDataView and still calls DicomMessage._read for the meta
> group) — deliberate 1.x work, as planned below.

`AsyncDicomReader` duplicates header/element logic and reads through
`SplitDataView.findView` per primitive. Re-platforming it onto the parser is the hardest
rewiring because the parser assumes one contiguous buffer while the async reader works
over chunk lists with `ensureAvailable`/`consume`.

Deliberately deferred until after R2–R4 ship. Interim: AsyncDicomReader keeps working
as-is (it is self-contained). The eventual shape: the parser's element readers run over
the contiguous window `SplitDataView` can guarantee (`hasData`), falling back to
`ensureAvailable` awaits at element boundaries; `SplitDataView` gains the cached-chunk
fast path and stays confined to `packages/streaming`.

---

## R7. Deletions (after the equivalence gate passes)

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

- `DicomMessage._read`, `_readTag`, `read`, `readTag` — the entire eager loop.
- `SequenceOfItems.readBytes` scan-rewind reader (`ValueRepresentation.js:1108-1201`).
- `BinaryRepresentation.readBytes` frame logic (replaced by parser toolkit).
- `src/dicomweb.js`, import-time `registerPrivatesModule` (`index.js:13` — becomes an
  explicit, lazy registration), import-time `_generateNameMap`
  (`DicomMetaDictionary.js:444` — becomes a lazy static getter).
- The circular-dependency setters (`setDicomMessageClass` / `setTagClass`,
  `index.js:114-117`) — package layering makes them unnecessary.
- dcmjs known bugs fixed en route: `readUint16Array` off-by-one
  (`BufferStream.js:245-254`), per-instance `TextDecoder`/`TextEncoder`
  (`BufferStream.js:21,477` → module singletons).

## R8. Order of operations and gates

- [x] 1. R0 parser intake + ported byte-level suites + corpus — DONE ee33089
      (gate met: 245 parser tests green offline).
- [x] 2. Benchmark + bundle-size gates — DONE d8e4fc3 (`bench:parser` vs
      published dicom-parser@1.8.21: geomean ~0.85, vendored faster on every
      file; `gate:parser-bundle`: 29 modules all in-package, ~88 kB, zero
      side effects). Note: reference is 1.8.21 — 1.8.12 was never published.
- [x] 3. R1 + R2 lazy bridge — DONE bcdfb49 (gates met: 150/150 equivalence
      cells over all local fixtures incl. deflate + encapsulated; full suite
      identical on both cores; review-driven hardening included).
- [x] 4. R3 naturalize + R5 charset gates — MET via the forced-lazy full-suite
      run (data.test.js + charset suites green on the lazy core). The R3 API
      redesigns themselves remain open 1.0 decisions (see below).
- [x] 5. R4 writer fusion — DONE 2703b90 (gates met: lossless-read-write suite
      both cores; byte-identity rewrite suite over the corpus; writer-hardening
      review findings fixed).
- [x] 6. R7 deletions + 1.0.0-beta.0 — DONE fd526c3 (partial by design: eager
      core kept as DCMJS_CORE=eager escape hatch until R6 re-platform + beta
      soak; see R7 status note). NOT published.
- [ ] 7. R6 streaming re-platform — NOT DONE (1.x; scoped fixes landed in
      fd526c3: readUint16Array fix, codec singletons, cached-chunk fast path).

Post-plan 1.x backlog (not in the original numbered steps):
- [ ] Delete the eager read loop (_read/_readTag + eager element classes) once
      AsyncDicomReader is re-platformed and the beta has soaked.
- [ ] Packaging: subpath exports / workspace-package split (data, dictionary,
      streaming, features), `sideEffects: false`, types entry — deferred since
      nothing is being published yet.
- [ ] TypeScript surface (seed exists at packages/parser/index.d.ts).
- [ ] README/API docs for the 1.0 read-write pipeline.
- [ ] Per-element ASCII fast path to widen the charset passthrough gate
      (ISO_IR 100 sources currently always re-encode).

Open 1.0 API decisions — ALL STILL OPEN as of 2026-06-10 (need owner sign-off, flagged inline above):
scalar collapse → VM-driven? · keep ISO_IR 192 normalize-on-read? · binary values as
views by default? · numeric vs string dict keys at the public boundary (plan assumes
string keys stay, numeric stays internal).
