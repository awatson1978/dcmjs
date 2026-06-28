---
title: Event-stream architecture
---

# Event-stream architecture

The event-stream layer (`dcmjs.eventStream`) is the canonical transformation model
for DICOM metadata. It separates four concerns so that readers, writers,
naturalizers, validators, and anonymizers all compose on one contract.

For the practical API and examples, see
[Event streams](../guides/event-streams.md). This page covers the model.

## Four layers

```
Source representation   →   Event stream   →   Listener / writer   →   Result
   (bytes, dict, JSON)       (the contract)     (a stream consumer)     (object/JSON/bytes)
```

1. **Source representations** — inputs that can generate events: Part 10 bytes
   (`fromPart10`), a parsed dcmjs dataset (`fromDataSet`), or DICOMweb JSON
   (`fromDicomWebJson`). Sources do not share an in-memory model.
2. **Event stream** — the single canonical interchange. Every reader produces it
   and every writer consumes it, so equivalent metadata yields equivalent events
   regardless of origin.
3. **Listeners and writers** — consumers of the stream. They may materialize
   objects (the naturalized listener), serialize output (the DICOMweb JSON and
   Part 10 writers), validate, or transform. Custom listeners are first-class.
4. **Retained representation** — the naturalized object is the preferred
   application-facing model. The event stream itself is not retained.

## The contract

The contract is a **hybrid**: a synchronous push core (a listener whose methods
are called as the stream is walked) with an async-iterator adapter layered on top.
The push core keeps the hot path allocation-free; the adapter offers `for await`
ergonomics.

The vocabulary:

```
Lifecycle   startDataSet / endDataSet
            startFileMetaInformation / endFileMetaInformation
Structural  startElement / endElement
            startSequence / endSequence
            startItem / endItem
            value(v, { index, rawValue? })
Binary      bulkDataReference                       (a reference, nothing fetched)
            startBinary / binaryFragment / endBinary (a fragment sub-stream)
```

### Invariants

- **Loss preservation.** A generator emits every observed value and every observed
  item, regardless of declared VM. Cardinality enforcement is a *listener* policy,
  never the stream's.
- **Well-formed nesting.** Every `start*` is balanced by its `end*`, in source
  order.
- **Transport-only binary.** Binary is carried as a fragment sub-stream or a
  `bulkDataReference`; functions and large buffers are never smuggled through as
  payloads. Inline binary is decoded to bytes; bulk references stay lazy.
- **Out-of-band diagnostics.** The stream stays purely loss-preserving; warnings
  (e.g. cardinality violations) belong to listeners.
- **Optional `sourceSpan`.** Structural events may carry source byte offsets for
  writers that want them; consumers that don't, ignore them.

Synchronous structural/value callbacks keep allocation low; backpressure is
applied out of band (`setDrain`/`awaitDrain`) and awaited only at defined
checkpoints — top-level element boundaries and binary-fragment emission.

## Relationship to the read/write cores

The event layer sits *on top of* the existing cores; it does not replace them:

- Generators reuse the [lazy read core](./lazy-core.md) and the
  [parser package](./parser-package.md) for decoding.
- The Part 10 writer layers over the canonical [writer](./writer.md)
  (`DicomDict.write`). Byte-identical Part 10 round-tripping (incl. verbatim
  compressed pixel data) is a deliberate non-goal of the event/naturalized path
  and remains served by the lazy read + passthrough writer.

## Source-agnostic equivalence

Because all sources emit the same contract, the naturalized object is identical
across origins. This is verified across the whole fixture corpus: each fixture is
naturalized from raw bytes, from a parsed dict, and from DICOMweb JSON
(round-tripped through the writer), and the three results must match.
