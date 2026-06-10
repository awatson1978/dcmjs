---
title: Roadmap
---

dcmjs is at `1.0.0-beta.0` (not yet published). The rewiring plan
(`docs/REWIRING-PLAN.md`, the engineering log for the 1.0 work) executed its
numbered steps through R8 step 6; what remains splits into a 1.x backlog and
four open API decisions that need owner sign-off before 1.0 final.

## 1.x backlog

From the plan's R8 checklist:

### Re-platform AsyncDicomReader onto the tokenizer (R6)

The streaming reader still runs its own header/element logic over
`SplitDataView` and still calls `DicomMessage._read` for the meta group. This
is the hardest remaining rewiring — the tokenizer assumes one contiguous
buffer while the async reader works over chunk lists — and was deliberately
deferred. Scoped fixes already landed (the `readUint16Array` off-by-one,
shared `TextDecoder`/`TextEncoder` singletons, a cached last-hit chunk index
for sequential reads). See [streaming](../architecture/streaming.md).

### Delete the eager read loop

`DicomMessage._read`/`_readTag` and the eager element classes are kept in the
beta as the `DCMJS_CORE=eager` escape hatch, and `AsyncDicomReader` still
depends on `_read`. Once the async reader is re-platformed and the beta has
soaked, the eager loop is deleted outright — not kept behind a flag — along
with the dual-core test requirement and the circular-dependency setters in
`index.js`.

### Packaging: subpath split and `sideEffects: false`

Subpath exports / a workspace-package split (data, dictionary, streaming,
features), `sideEffects: false`, and a types entry. Deferred because nothing
is being published yet; this is also where the public raw-tier parser subpath
for [dicom-parser migrants](../migration/from-dicom-parser.md) lands.

### TypeScript surface

A typed public API for dcmjs proper. A seed already exists at
`packages/parser/index.d.ts` (the element/dataSet/accessor shapes, including
the new `tagValue`/`startOffset`/`endOffset` fields).

### README and API docs

The README and API documentation still describe the 0.x pipeline; they need a
rewrite around the 1.0 lazy read-write pipeline. This site is part of that
work.

### ASCII fast path for charset passthrough

The writer's charset passthrough gate is conservative: only files whose
top-level `SpecificCharacterSet` is absent, empty, ASCII, or UTF-8 qualify, so
ISO_IR 100 sources always re-encode every string element. A per-element ASCII
fast path (pass through any string value that is pure ASCII regardless of the
declared charset) would widen the gate considerably. See
[character sets](../guides/character-sets.md).

## Open 1.0 API decisions

All four are still open as of 2026-06-10 and need owner sign-off. Verbatim
from the plan:

> scalar collapse → VM-driven? · keep ISO_IR 192 normalize-on-read? · binary
> values as views by default? · numeric vs string dict keys at the public
> boundary (plan assumes string keys stay, numeric stays internal).

Context for each:

1. **VM-driven scalar collapse.** Today `naturalizeDataset` collapses
   single-value arrays to scalars based on what the *instance* happens to
   contain; the proposal is to derive the shape from the dictionary VM
   instead (VM 1 → scalar, VM 1-n → always array), which is the thing 0.x
   could never fix — at the cost of breaking OHIF-familiar instance-driven
   shapes. The beta keeps 0.x behavior pending this decision.
2. **ISO_IR 192 normalize-on-read.** 0.x (and the beta) rewrite the stored
   `SpecificCharacterSet` to `["ISO_IR 192"]` and re-encode strings as UTF-8
   on write. The question is whether to keep that quirk as an explicit
   feature (with the original charset surfaced on the result) or drop it and
   round-trip the original encoding.
3. **Binary values as views by default.** The lazy core returns binary values
   (OB/OW/UN, pixel frames) as zero-copy views over the source buffer, which
   makes the old `noCopy` option obsolete — but means the source buffer stays
   alive as long as any value does, and mutating a view mutates "the file".
   The decision is whether views stay the 1.0 default with copies on request.
4. **Public dict key format.** Internally, tag identity is numeric
   (`(group << 16 | element) >>> 0`). The plan assumes public `DicomDict`
   keys remain clean uppercase strings (`"00100010"`) and the numeric form
   stays internal; the alternative is exposing numeric keys at the boundary
   too.

## How to follow along

`docs/REWIRING-PLAN.md` carries a per-section status table and per-section
STATUS notes that are updated as steps land; each executed step references its
commit. The [monorepo guide](monorepo.md) describes the gates every one of
these items has to pass.
