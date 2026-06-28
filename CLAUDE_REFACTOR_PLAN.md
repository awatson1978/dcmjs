# CLAUDE_REFACTOR_PLAN.md — Unified dcmjs Refactor

This is the working engineering plan for the Unified dcmjs architecture. It is scoped,
incremental, and slice-by-slice. The reasoning behind every design decision lives in
[`CLAUDE_REFACTOR_ANALYSIS.md`](./CLAUDE_REFACTOR_ANALYSIS.md). The existing 1.0
read/write migration is tracked separately in
`packages/docs/docs/development/roadmap.md` (R0–R8); this plan layers the spec-driven
event-stream/naturalization architecture on top of it.

> Specs of record: the **Unified dcmjs Architecture Proposal** and the **Naturalized
> DICOM Metadata Behavior Specification**. Section (§) references point into the
> Naturalized spec unless noted.

## Why

Today Part 10 and DICOMweb follow separate metadata paths, naturalization behavior has
drifted, cardinality is unpredictable, and private-tag handling lacks a formal model.
The unified architecture fixes this with four layers — **source representations →
event stream → listeners/writers → retained naturalized metadata** — where the **event
stream** is the single canonical transformation layer and the **naturalized object** is
the preferred application-facing representation.

## Decomposition

Each slice is its own spec → plan → implement cycle. Dependency-ordered:

| # | Slice | Depends on | Status |
|---|---|---|---|
| **A** | **Event-stream contract** | — | **DONE** — `src/eventStream/`, 79 tests, corpus round-trip green |
| **B** | **Part 10 (raw bytes) → generator** | A | **DONE** — `fromPart10`, 31-fixture corpus gate green |
| **C** | **DICOMweb JSON → generator** | A | **DONE** — `fromDicomWebJson`, source-agnostic structural gate green |
| **D1** | **Naturalized value model (core)** | A, B, C | **DONE** — `NaturalizedListener`, generator-agnostic corpus gate green |
| **D2a** | **Naturalized Person Name proxy (§17)** | D1 | **DONE** — `.Alphabetic` + `String()`→raw PN, reuses `pnAddValueAccessors` |
| **D2b** | **Naturalized private-tag grouping (§18)** | D1 | **DONE** — `<slot>:<creator>` groups incl. registered names (§18.1–§18.5) |
| **D2c** | **Naturalized precision/raw retention (§16/§27)** | D1, A | **DONE** — raw-value channel + round-trip retention; DS precision preserved |
| **E1** | **DICOMweb JSON writer (sink)** | A | **DONE** — `DicomWebJsonWriter`, JSON round-trip + end-to-end gate green |
| E2 | Part 10 byte writer (passthrough via sourceSpan) | A | not started |
| **F** | **Public source/sink API (§32)** | A–E1 | **DONE** — `DicomEventStream` + `Naturalized.from` / `DicomWebJson.from` |
| **G** | **Cross-source equivalence matrix (§31)** | A–F | **DONE** — 30-fixture three-source (bytes/dict/DICOMweb JSON) naturalize-identically gate |
| **E2** | **Part 10 byte writer (sink)** | A, E1 | **DONE** — `Part10Writer` layers over the canonical `DicomDict.write`; corpus semantic round-trip green |
| E | Writers (Part 10 + DICOMweb) on event stream | A | not started |
| F | Public source/sink API + compat wrappers | A–E | not started |
| G | Cross-source equivalence suite (§31) | A–F | not started |

---

# Slice A — The Event-Stream Contract  *(current)*

**Goal:** turn the implicit listener model into a documented, versioned,
conformance-tested contract — the vocabulary every reader/writer/listener/filter speaks
— and prove it with one reference generator. **Out of scope:** naturalization semantics
(D), DICOMweb (C), writers (E).

## Approved design decisions
1. **Hybrid model** — push/callback is canonical; an async-iterator adapter sits on top. *(D2)*
2. **Sync calls + async checkpoints** — allocation-free hot path; backpressure only at
   top-level element boundaries and binary-fragment emission. *(D3)*
3. **Binary = fragment sub-stream + reference event.** *(D4)*
4. **File Meta Information** is a leading bracketed sub-stream. *(D5)*
5. **Optional `sourceSpan {start,end}`** on structural events. *(D6)*
6. **Reference generator** = standalone tree-walker over `@dcmjs/parser`'s `DataSet`. *(D7)*

## The contract

### Vocabulary
```
Lifecycle
  startDataSet({ transferSyntaxUID?, sourceContext? })   endDataSet()
  startFileMetaInformation()                             endFileMetaInformation()

Structural — always balanced, always source-ordered
  startElement(tag, { vr, length, vm?, sourceSpan? })    endElement()
  startSequence(tag, { vr, length, sourceSpan? })        endSequence()
  startItem({ length, sourceSpan? })                     endItem()
  value(v, { index })            // one call per OBSERVED source value

Binary
  bulkDataReference({ uri, sourceContext })              // nothing fetched
  startBinary({ encapsulated, basicOffsetTable?, sourceSpan? })
  binaryFragment(chunk)                                  // boundaries preserved
  endBinary()
```

### Invariants
- **Loss preservation (§15.1):** emit every observed value and item regardless of
  declared VM. Cardinality enforcement is a *listener* concern (§15.2), never the stream's.
- **Well-formed nesting:** every `start*` balanced by its `end*`; source order preserved.
- **No functions as payloads (§24):** `openInlineBinary` is never emitted.
- **Diagnostics are out of band:** the stream stays purely loss-preserving.
- **`sourceSpan` is optional and ignorable.**

## Components (new directory `src/eventStream/`)

1. **Contract design doc** — `docs/superpowers/specs/<date>-event-stream-contract-design.md`,
   normative, versioned `CONTRACT_VERSION`. Committed first.
2. **`EventStreamListener.js`** — push core + `next`-middleware chain + `setDrain`/
   `awaitDrain`. *Reuse* the chain-builder and backpressure from
   `src/utilities/DicomMetadataListener.js` (191-219, 95-108). Filters stay first-class.
3. **`fromDataSet.js`** — reference generator. Walks the parser `DataSet` tree, emits the
   vocabulary. *Reuse* `src/ValueRepresentation.js` for decoding. Sequences →
   `startSequence`/`startItem`/`endItem`/`endSequence`; encapsulated pixel data →
   `startBinary`/`binaryFragment`(per `el.fragments`)/`endBinary`; group-0002 → FMI
   sub-stream first (meta test `tagValue >>> 16 === 0x0002`).
4. **`asyncIterator.js`** — pull adapter; `[Symbol.asyncIterator]` over a generator run
   (pooled event shape on the hot path; snapshot to retain).
5. **`CollectorListener.js`** — trivial reference consumer that rebuilds a tag tree, used
   only to validate the contract. *Not* the naturalized listener.
6. **Migration:** `DicomMetadataListener` and its consumers (`AsyncDicomReader` + 5 test
   files) stay untouched this slice; re-platforming onto the new vocabulary is a later
   slice (E / R6).

## Verification
Tests under `test/eventStream/`, following `test/lazy-equivalence.test.js` +
`test/helper/equivalence.js`:
1. **Round-trip equivalence (primary gate):** for every `discoverFixtures` file,
   `fromDataSet` → `CollectorListener` → deep-compare rebuilt tree vs.
   `DicomMessage.readFile`. Covers plain (explicit/implicit LE, big-endian),
   sequence-heavy, deflate, encapsulated/fragmented.
2. **Well-formedness:** balanced `start*`/`end*` across the corpus.
3. **Binary boundaries:** `binaryFragment` count/spans match `el.fragments` (§33).
4. **Loss preservation:** crafted VM-1-with-2-values and VM-1-sequence-with-2-items
   emit everything.
5. **Pull-adapter parity:** `for await` matches the push collector.
6. **Backpressure:** slow `setDrain` suspends only at the defined checkpoints.

Run: `pnpm exec jest test/eventStream`, then `pnpm test` and `DCMJS_CORE=eager pnpm test`
to confirm no regression in existing listener consumers.

## Done means
Generator emits the contract; collector rebuilds a tree byte-equivalent to today's parse
across the whole corpus; all six test groups green; contract doc published. No
naturalization semantics yet.

## Status — DONE
Implemented under `src/eventStream/` (`EventStreamListener`, `CollectorListener`,
`fromDataSet`, `asyncIterator`, `index`), exposed as `dcmjs.eventStream`. Tests under
`test/eventStream/` (79 passing): push-core + middleware + backpressure, collector,
generator vocabulary/order/payloads/bulk-ref, pull-adapter parity + error propagation,
corpus round-trip equivalence (30 fixtures: plain LE/BE/implicit, deflate, encapsulated
single/multi-frame), well-formed nesting, loss preservation (§15.1). Full suite green on
both cores (`pnpm test` and `DCMJS_CORE=eager pnpm test`: 959 tests).

Honest scope note: the reference generator walks the parser-derived **decoded** dataset
(reusing the lazy core's `ValueRepresentation` decode), exercising spec §32's "tag source
→ events" path. The from-raw-bytes Part 10 generator is **slice B**. `_rawValue` raw
retention is **slice D** and is intentionally not compared in the slice-A gate.

---

# Slice B — Part 10 (raw bytes) → event-stream generator  *(current)*

**Goal:** a genuine bytes→events generator `fromPart10(buffer, listener, options)` over
`@dcmjs/parser`'s offsets tree, reusing dcmjs's public decode primitives
(`ValueRepresentation.read`, `ReadBufferStream`, `encodingMapping`,
`DicomMessage.lookupTag`) plus faithful local copies of the small pure helpers
(`resolveVrInstance`, `shapeReadValues`). Emits raw encapsulated fragments (§33), not
frame-grouped buffers (frame grouping is naturalization, slice D).

**Scope (decided):** common path handled directly — explicit/implicit LE + big-endian,
sequences (defined + undefined length), encapsulated pixel data as raw fragments,
defined-length binary as a one-fragment sub-stream, SpecificCharacterSet decoding.
**Hard cases delegate** to the lazy core by falling back to
`fromDataSet(DicomMessage.readFile(buffer, options))` for the whole file: deflate
transfer syntax, and any per-element undefined-length non-SQ / `ParsedUnknownValue`
case the walker can't faithfully decode (detected mid-walk → abort → delegate).

**Follow-up (not slice B):** extract the trapped decode core out of `readFileLazy` into a
shared module so the lazy reader and this walker share one decode path
("one read core", roadmap goal). Tracked as a future slice.

**Status — DONE.** `src/eventStream/fromPart10.js` (exposed as
`dcmjs.eventStream.fromPart10`). Routes leaf elements by decoded value type (buffer →
binary sub-stream; else `value()`) — not by `isBinary()`, which is true for numeric VRs.
Tests in `test/eventStream/fromPart10.test.js`: a synthesized explicit-LE round-trip plus
the 31-fixture corpus gate (non-binary exact, binary at concatenated-fragment-byte level,
group-length + SpecificCharacterSet exempt). Deflate and hard undefined-length cases
delegate. Full suite green on both cores (990 tests).

**Verification:** corpus gate like slice A but from raw bytes —
`fromPart10(buffer)` → `CollectorListener` vs `DicomMessage.readFile(buffer)`:
non-binary tags exact (vr+Value, SQ-aware), binary tags compared at the
concatenated-fragment-bytes level, `SpecificCharacterSet` (0008,0005) exempted (readFile
rewrites it to ISO_IR 192 — a known eager-compat quirk the new path does not propagate).

# Slice C — DICOMweb JSON → event-stream generator  *(DONE)*

`src/eventStream/fromDicomWebJson.js` (exposed as `dcmjs.eventStream.fromDicomWebJson`).
Low-allocation visitor over the DICOM JSON model emitting the same contract — proves the
source-agnostic claim (§4.4) from a third source. Values emitted **as-is** (PN stays a
`{Alphabetic}` object, numbers stay numbers); cross-source value canonicalization is
deferred to the naturalized listener (slice D), per decision D10. Binary forms:
`BulkDataURI` → `bulkDataReference` (unfetched, §21); `InlineBinary` base64 → decoded
buffer fragment (§22/§24.1). Tests in `test/eventStream/fromDicomWebJson.test.js`:
vocabulary/round-trip incl. nested SQ + PN objects, both binary forms, backpressure, and a
source-agnostic structural check (DICOMweb JSON vs dcmjs dict produce identical
event/tag structure). Full suite green (995 tests). The exhaustive corpus-wide cross-source
*value* matrix is slice G.

# Slice D1 — Naturalized value model (core)  *(DONE)*

`src/eventStream/NaturalizedListener.js` (exposed as `dcmjs.eventStream.NaturalizedListener`).
An event-stream consumer that builds the application-facing naturalized object: canonical
keyword keys (§5, via `lookupTagHex`) and VM-driven cardinality (§7–§14). Because it
consumes the source-agnostic contract, the SAME object is produced from Part 10 bytes, a
dcmjs dict, or DICOMweb JSON.

Rules: scalar VM (1 / 0-1) → scalar; present-empty → null; multi VM (1-n, 2-n, …) →
always list-like; multi present-empty → []; single-item sequence → the item object with
hidden length 1 (reusing the shared `addAccessors` proxy); empty sequence → []; multi-item
sequence → array. Binary: fragments assembled to `{InlineBinary}`, `bulkDataReference` →
`{BulkDataURI}`. Cardinality-violation policy (§15.2) default **warnAndPreserve**
(configurable: preserve/discardExtra/warn*/record*/throw); violations also exposed on
`listener.violations`.

**Key interpretation:** a DICOM sequence's declared VM ("1") constrains attribute
occurrence, NOT item count — so multi-item sequences (PerFrameFunctionalGroupsSequence) are
normal, not violations. Violations apply only to non-SQ scalar VRs exceeding their VM.

**Deferred to D2:** PN proxy/`toString` sugar (§17, still an open spec decision), private-tag
grouping (§18), and precision/raw retention (§16/§27 — needs a contract extension to carry
raw values; the underlying PN `{Alphabetic}` value already matches across sources today).

Tests in `test/eventStream/NaturalizedListener.test.js` (43): the full §14 VM table,
sequences, binary/meta, a **generator-agnostic corpus gate** (fromPart10 vs fromDataSet
naturalize identically across all fixtures, modulo the known SpecificCharacterSet rewrite
and binary frame-grouping), and a three-source agreement check (dict vs DICOMweb JSON).
Full suite green on both cores (1038 tests).

# Slices D2–G — summaries

- **D2a. Naturalized Person Name proxy (§17)** — DONE. In `NaturalizedListener`, PN values
  get non-enumerable `toString()`/`toJSON()` via the existing `dicomJson.pnAddValueAccessors`:
  VM 1 → the `{Alphabetic,...}` object (so `PatientName.Alphabetic` works) with
  `String(name)` → raw PN string; VM n → array with `\`-joined `toString()`. Accessors are
  non-enumerable so the cross-source corpus gate is unaffected. Resolved the spec's open §17
  question (component access IS supported for VM 1; toJSON serializes to the DICOM JSON array
  form). 1051 tests green both cores.
- **D2b. Private-tag grouping (§18)** — DONE. In `NaturalizedListener`, private data is
  grouped under `"<slot>:<CREATOR>"` keys with `originalTagOffset` and block-relative
  (low-byte) element keys (§18.1); private creators are recorded per dataset level and not
  emitted as ordinary attributes (§18.5); creatorless private data keeps a full-tag
  `{vr, Value}` unknown shape (§18.4); grouping is scoped per dataset level (sequence items
  have their own creators). Registered private names (§18.2) are resolved via
  `lookupPrivateTag` with the creator-qualified key `(gggg,"CREATOR",ee)` and used as the
  nested key when known, meaningful (not "Unknown"), and non-colliding — e.g. SIEMENS CSA
  HEADER (0029,1010) → `CSAImageHeaderInfo`; otherwise the numeric block-relative offset.
  Applies identically across generators (cross-source gate stays green).
- **D2c. Precision / raw retention (§16/§27)** — DONE. The contract's `value` event gained an
  optional `rawValue` payload; `fromPart10` (via parallel raw shaping) and `fromDataSet`
  (via `_rawValue`) emit it. `NaturalizedListener` retains the raw source string whenever a
  numeric VR value's shortest decimal cannot reproduce the source (over-length DS, or an
  integer beyond the safe range) — a VR-agnostic round-trip check, so normal values keep
  their number. `fromDicomWebJson` carries no raw, so JSON-sourced numbers stay numbers
  (DICOMweb JSON has already chosen a number). Note: IS is capped at 12 chars so it never
  overflows; the real case is DS (≤16 chars). Default behavior matches §27 "inexact only".
- **§15.4 scale** — VALIDATED. `test/eventStream/scale.test.js` drives the naturalized
  listener with a 100k-item PerFrameFunctionalGroupsSequence (~76 ms) and 500-deep recursive
  ContentSequence (~16 ms). The depth-bounded frame stack scales linearly; no state-by-depth
  pooling needed at these sizes (deeper micro-optimization remains a future option if a real
  workload demands it).
- **E1. DICOMweb JSON writer** — DONE. `src/eventStream/DicomWebJsonWriter.js` (exposed as
  `dcmjs.eventStream.DicomWebJsonWriter`): the faithful inverse of `fromDicomWebJson`,
  making the contract a sink. Output `{vr, Value}` / `{vr, BulkDataURI}` /
  `{vr, InlineBinary base64}`; PN passes through as `{Alphabetic}`; binary source form
  preserved (§25). Tests: JSON→events→JSON identity, and end-to-end
  bytes→events→JSON→events→naturalized == direct naturalize (plain/implicit LE + deep SR).
  Full suite green both cores (1043 tests).
- **E2. Part 10 byte writer** — DONE. `src/eventStream/Part10Writer.js` (exposed as
  `dcmjs.eventStream.Part10Writer`; `DicomEventStream.toPart10()`). A thin LAYER over the
  canonical encoder, not a second encoder: it collects events into `{meta, dict}` (via
  CollectorListener) and delegates to the proven `DicomDict.write()` (all VRs,
  undefined-length SQ, deflate, padding, Big16, group-length recompute). Drops any collected
  group-length so it isn't double-counted; forwards write options (e.g.
  `allowInvalidVRLength` for malformed round-trips).

  **Architecture decision (D15):** byte-IDENTICAL Part 10 round-tripping (incl. re-emitting
  compressed pixel data verbatim) is a non-goal of the event/naturalized path (spec §4.5) and
  remains served by the lazy-read + R4 passthrough-write path. A true streaming + passthrough
  event encoder would *duplicate* the canonical encoder, not replace it, and is only worth it
  for streaming writes of giant datasets — deferred until that need is real.

  Tests: synthesized round-trip (scalars/PN/sequence/meta) + a 30-fixture corpus **semantic**
  round-trip (bytes → events → Part 10 → readback naturalizes identically). Full suite green
  on both cores (1122 tests).
- **F. Public API** — DONE. `src/eventStream/api.js` (exposed as
  `dcmjs.eventStream.{DicomEventStream, Naturalized, DicomWebJson}`). `DicomEventStream`
  wraps a re-runnable source with `.fromPart10/.fromDicomWebJson/.fromDataSet` factories and
  `.process(listener)` / `.toNaturalized()` / `.toDicomWebJson()` / `.toDataSet()` /
  `.asyncIterable()`; plus §32 sink helpers `Naturalized.from(events)` /
  `DicomWebJson.from(events)`. Sources are reusable (drive multiple sinks). Tests in
  `test/eventStream/api.test.js` (5). Full suite green (1048 tests). Compat wrappers over
  legacy `DicomMessage`/naturalize APIs remain a follow-up.
- **G. Equivalence suite** — semantic-consistency matrix across all source formats (§31).
