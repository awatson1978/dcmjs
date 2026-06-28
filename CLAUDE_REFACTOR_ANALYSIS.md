# CLAUDE_REFACTOR_ANALYSIS.md — Decision Log for the Unified dcmjs Refactor

This document records the questions asked during the brainstorming/planning session
and the answers given, so the reasoning behind `CLAUDE_REFACTOR_PLAN.md` is traceable.
It is a decision log, not a plan. Each entry: the question, the options considered,
the decision, and why.

Source material: the **Unified dcmjs Architecture Proposal** and the **Naturalized
DICOM Metadata Behavior Specification** (provided by the user). Section references
(§) point into the Naturalized spec unless noted.

---

## D0. Scope — is this one refactor or many?

**Question:** The request was "refactor all of it" against ~40 pages of specs. Is this
a single design/plan, or does it need decomposition?

**Decision:** Decompose. The specs describe a *platform* (4 layers), not a utility.
Per the brainstorming process, a request spanning multiple independent subsystems is
split into sub-projects, each with its own spec → plan → implementation cycle.

**Decomposition (dependency-ordered):**

| # | Sub-project | Depends on | Repo status at analysis time |
|---|---|---|---|
| **A** | Event-stream contract | — | partial (listener middleware exists) |
| B | Part 10 → event-stream generator | A | partial (lazy core done) |
| C | DICOMweb JSON → event-stream generator | A | not built |
| D | Naturalized listener + value model (bulk of metadata spec) | A, B | partial (roadmap R3) |
| E | Writers on event stream (Part 10 + DICOMweb) | A | partial (backpatch writer, R4) |
| F | Public source/sink API + compat wrappers | A–E | not built |
| G | Cross-source equivalence suite (§31) | A–F | not built |

**Confirmed:** the two pasted documents are the complete spec set (no more pages coming).

---

## D1. Which slice first?

**Question:** Which sub-project do we brainstorm and build first?

**Options:** A (event-stream contract) · D (naturalized value model — the meat) ·
B (Part 10 generator).

**Answer:** **A — Event-stream contract.**

**Why:** It is the keystone. B, C, D, and E are all *defined as* producers/consumers
of the contract (§4.3, §4.4). Settle the vocabulary first and the naturalized listener
(D) becomes a well-bounded consumer; start with D and we'd reverse-engineer the
contract anyway. It is also partly grounded already in
`src/utilities/DicomMetadataListener.js`, so slice A is "formalize + enrich + decide
the things the current code dodges" rather than green-field.

---

## D2. Push or pull model for the event stream?

**Question:** Is the canonical contract a push/callback listener or a pull/async-iterator?

**Options:** Push/callback · Pull/async-iterator · Hybrid (push core + pull adapter).

**Answer:** **Hybrid — push/callback is canonical, async-iterator layered on top.**

**Why:** §24/§24.1 require the stream to be transport-oriented (the `openInlineBinary`
function must never be a payload; parsed-JSON generation should call listener callbacks
directly "without constructing intermediate event objects"), and §15.4 requires low
allocation. That points to push/callback for the canonical path. The pull adapter is
kept for ergonomics (`for await`) without forcing event-object allocation on consumers
who don't want it.

---

## D3. How async is the push core?

**Question:** Should callbacks be awaitable, and where does backpressure happen?

**Options:** Sync calls + async checkpoints · Fully async callbacks · Fully sync,
no backpressure in the contract.

**Answer:** **Sync calls + async checkpoints.**

**Why:** Streaming/backpressure is a first-class goal (§4.3, §15.4) and the existing
code already has `setDrain`/`awaitDrain`. But putting a promise on every
`value()`/`startElement()` call would fight the allocation-free hot path. So
structural/value callbacks are synchronous; the generator awaits backpressure only at
defined points — top-level element boundaries and binary-fragment emission — matching
the existing `awaitDrain` usage in `AsyncDicomReader._emitSplitValues`.

---

## D4. How is binary / bulk / encapsulated pixel data represented?

**Question:** What events carry binary data, references, and fragment boundaries?

**Options:** Fragment sub-stream + reference event · Single buffer/reference value
event · Fragment sub-stream now, references deferred.

**Answer:** **Fragment sub-stream + reference event.**

**Why:** §33 requires fragment boundaries be preservable (lossless writers need them
for encapsulated transfer syntaxes); §26's `BinaryOutputMode`
(preserveReference/inline/stream/resolveAndInline) requires the stream to carry *either*
an unfetched reference *or* bytes; §24 requires the `openInlineBinary` function never be
emitted. So:
- `bulkDataReference({ uri, sourceContext })` — by-reference, nothing fetched (`BulkDataURI`)
- `startBinary` → `binaryFragment*` → `endBinary` — covers `InlineBinary` (one fragment),
  `openInlineBinary`, and encapsulated pixel data (many fragments, boundaries kept).

A single-buffer `value()` event was rejected because it collapses fragment boundaries
and pushes toward eager materialization, weakening §33/§26.

---

## D5. File Meta Information representation

**Question:** Is group-0002 inline, or a separate sub-stream?

**Answer (accepted via "continue"):** **Separate bracketed sub-stream**
(`startFileMetaInformation`/`endFileMetaInformation`) emitted first, so a listener knows
the transfer syntax before the main dataset arrives (§33). Replaces the ad-hoc `fmi`
field on today's listener.

---

## D6. Source-byte spans in the vocabulary

**Question:** Bake optional `sourceSpan {start,end}` into structural events now, or add later?

**Answer (accepted via "continue"):** **Bake it in now**, optional and ignorable.
The parser already produces `startOffset`/`endOffset` (roadmap R0, confirmed in
`packages/parser/src/readDicomElementExplicit.js`). The passthrough writer (slice E / R4)
needs it; retrofitting it into the vocabulary later would be a breaking change. The one
deliberate forward-looking concession.

---

## D7. Where does slice A's reference generator live?

**Question:** What proves the contract against real bytes?

**Options:** New standalone tree-walker over the parser `DataSet` · Adapt
`AsyncDicomReader`'s existing push calls · Both (standalone now, AsyncDicomReader later).

**Answer:** **New standalone tree-walker over the parser `DataSet`.**

**Why:** Exploration found two read paths — `AsyncDicomReader` (drives the listener, but
has the vocabulary gaps and still uses the eager `_read` for meta; its full re-platform
is deferred to 1.x/R6) and `LazyDicomReader` (pull/getter-based, no listener). A standalone
walker over the parser's already-parsed `DataSet` tree (offsets present, `items[].dataSet`,
`fragments`/`basicOffsetTable`) is the smallest blast radius and stays out of the deferred
streaming work, while reusing `ValueRepresentation` for decoding.

---

## D8. Slice B depth (raw-bytes Part 10 generator)

**Question:** How deep should the bytes→events generator go?

**Options:** Real walker reusing decode primitives · Reuse the lazy core's exact decode ·
Thin adapter over the lazy core.

**Answer:** **Real walker, reuse decode primitives.** A genuine bytes→events path and the
streaming foundation, validated against the same corpus gate.

## D9. Slice B approach (decode core is trapped)

**Finding:** exploration revealed the decode core (`materializeElement`,
`resolveVrInstance`, charset/ctx setup, deflate dual-buffer) is **closures trapped inside
`readFileLazy`** — only `readFileLazy` is exported. Faithful "reuse primitives" therefore
means re-deriving ~30–40% of the lazy core, which converges with extracting it.

**Options:** Scoped walker now + extract core later · Extract shared decode core now ·
Independent walker reproducing routing.

**Answer:** **Scoped walker now, extract core later.** Ship the common path (explicit/
implicit LE + big-endian, sequences, raw encapsulated fragments, defined-length binary,
charset) reusing public primitives; **delegate** hard cases (deflate, undefined-length
non-SQ / unknown-VR) to `fromDataSet(readFile(...))` for the whole file. The shared-core
extraction ("one read core", roadmap goal) is a scheduled follow-up.

**Implementation gotcha found during TDD:** dcmjs's `isBinary()` is true for *numeric* VRs
(`FL/FD/SL/SS/UL/US/AT/UV`) which decode to **numbers**, not byte blobs; the byte-blob VRs
(OB/OW/OF/OD) are not in `binaryVRs`. So the walker routes by the **decoded value type**
(ArrayBuffer → binary sub-stream; else → `value()`), not by `isBinary()`.

## Grounding facts established during exploration

- Parser element shape (confirmed): `tag`, `tagValue` (numeric), `vr`, `length`,
  `dataOffset`, `startOffset`, `endOffset`, `hadUndefinedLength`, `items`, `fragments`,
  `basicOffsetTable`, `encapsulatedPixelData`. Sequence items carry `dataSet`.
- The de-facto event vocabulary today: `addTag` / `startObject` / `pop` / `value`
  threaded through a `next`-middleware chain (`DicomMetadataListener._createMethodChains`,
  lines 191-219). Sequences and items are both "objects" — not distinguished.
- Backpressure already exists: `setDrain`/`awaitDrain` (DicomMetadataListener 95-108),
  used in `AsyncDicomReader._emitSplitValues` (~line 367).
- Binary today: fragmented `ArrayBuffer`s via `value()`, expanded by
  `ArrayBufferExpanderFilter` into `startObject([])`/`value`*/`pop`.
- Listener consumers to preserve: `AsyncDicomReader` + 5 test files
  (`ArrayBufferExpanderListener.test.js`, `information-filter.test.js`,
  `defined-length-sequence.test.js`, `async-data.test.js`, plus `video-test-dict.js`).
- Test conventions: Jest; corpus via `discoverFixtures` over `packages/parser/testImages/`
  + `test/*.dcm|.lei`; deep-compare via `test/helper/equivalence.js`; dual-core gate
  `DCMJS_CORE=eager pnpm test`; existing `test/lazy-equivalence.test.js` is the template.
