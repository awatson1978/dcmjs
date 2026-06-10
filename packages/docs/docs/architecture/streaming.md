---
title: Streaming (AsyncDicomReader)
---

`AsyncDicomReader` (exported as `dcmjs.async.AsyncDicomReader`) reads DICOM
from a stream of chunks instead of one contiguous buffer: it awaits data as
needed, frees consumed chunks, and delivers values to a listener as they are
parsed. Use it when the file does not fit comfortably in memory or arrives
incrementally (network, file streams).

:::caution Preliminary
The reader's own docblock says it best: the exact interface is still
preliminary and initially released for testing purposes. There is no support
for deflated streams (use [`DicomMessage.readFile`](../guides/deflate.md) for
those), and the architecture below is scheduled for a 1.x re-platform.
:::

## What it does today

```js
const { AsyncDicomReader } = dcmjs.async;
const { DicomMetadataListener } = dcmjs.utilities;

const reader = new AsyncDicomReader();
const listener = new DicomMetadataListener();

// feed chunks: from a Node stream...
const readPromise = reader.stream.fromAsyncStream(fs.createReadStream(path));
// ...or manually: reader.stream.addBuffer(chunk); reader.stream.setComplete();

const { meta, dict } = await reader.readFile({ listener });
listener.information.transferSyntaxUid; // tracked while parsing
```

- **Chunked input.** The reader's `ReadBufferStream` accepts buffers as they
  arrive (`addBuffer`, `fromAsyncStream`) over a `SplitDataView` -- a DataView
  facade across a list of chunks. `await stream.ensureAvailable(n)` suspends
  parsing until `n` bytes exist (or the stream is marked complete), and
  `stream.consume()` drops references to fully read chunks so memory stays
  bounded.
- **Listener model.** Parsing emits structural events to a listener
  (`startObject`/`value`/`pop`, `addTag`), letting applications transform or
  discard data on the fly. `DicomMetadataListener` additionally tracks a
  default set of top-level attributes (transfer syntax, UIDs, Rows/Columns,
  BitsAllocated, ...) in `listener.information`, which the reader itself uses
  for frame geometry. Listeners can request raw delivery per tag
  (`expectsRaw`) and apply backpressure via `awaitDrain`.
- **`maxFragmentSize`** (constructor option, default 128 MB) caps the size of
  any single delivered buffer: larger values and pixel-data frames are split
  into multiple `listener.value()` calls.
- **Part 10 and raw detection.** `readPreamble` handles three stream shapes:
  a full Part 10 file (preamble + `DICM`), Part 10 without preamble (stream
  starts with group `0002` meta -- the `PART10_NO_PREAMBLE` sentinel), and raw
  datasets with no meta at all, where `detectRawEncoding` sniffs implicit
  vs. explicit little endian from the first tag's VR bytes and validates that
  implicit lengths are even.
- **Pixel data.** Encapsulated pixel data is reassembled into frames using
  the Basic Offset Table when present (with video transfer syntaxes treated
  as a single stream), uncompressed pixel data is split into frames from the
  tracked geometry, and single-bit (`bitsAllocated === 1`) multi-frame data is
  unpacked per frame.
- **Charset handling** mirrors the synchronous path: (0008,0005) swaps the
  stream decoder via `encodingMapping` and the stored value is normalized to
  `["ISO_IR 192"]` (see [Character sets](../guides/character-sets.md)).

## Current architecture: not yet on the tokenizer

Unlike `DicomMessage.readFile`, which 1.0 re-platformed onto the offsets-only
tokenizer in [`packages/parser`](./parser-package.md), `AsyncDicomReader`
still runs its **own** header and element logic:

- `readTagHeader` duplicates the eager `DicomMessage._readTag` VR/length
  rules (with one streaming extra: implicit `xs` tags resolve signedness from
  the tracked `pixelRepresentation`);
- the meta group is still read by delegating to the eager
  `DicomMessage._read` -- which is the main reason the eager read loop
  survives in the 1.0-beta codebase;
- every primitive read goes through `SplitDataView.findView`, the
  chunk-spanning DataView lookup.

This is deliberate: the tokenizer assumes one contiguous buffer, while the
async reader works over chunk lists with `ensureAvailable`/`consume`, and the
re-platform was judged the hardest piece of the 1.0 rewiring. The reader is
self-contained and keeps working as-is.

## Scoped 1.0 fixes

Three targeted fixes landed for 1.0 without changing the architecture:

- **`readUint16Array` off-by-one** in `BufferStream` -- the loop indexed from
  1, so the result array's first slot was never filled and the last decoded
  value fell off the end; fixed and covered by tests.
- **Shared `TextDecoder`/`TextEncoder` singletons** -- streams are created per
  sequence item, fragment, and element, and constructing codecs per stream was
  measurable overhead; both are stateless as used, so module-level defaults
  are shared (`setDecoder` still installs per-stream decoders when the
  charset changes).
- **Cached-chunk fast path in `SplitDataView`** -- `findStart` remembers the
  last chunk hit and checks it (and its successor) before falling back to the
  linear scan, which makes sequential streaming reads O(1) per primitive
  instead of O(chunks).

## The 1.x re-platform plan

The eventual shape, deferred past 1.0 (see the
[roadmap](../development/roadmap.md)):

1. run the parser package's element readers over the contiguous windows
   `SplitDataView` can already guarantee (`hasData`), falling back to
   `ensureAvailable` awaits at element boundaries;
2. point the meta-group read at the parser's Part 10 header reader instead of
   `DicomMessage._read`;
3. confine `SplitDataView` to the streaming layer.

Once that lands, the legacy eager read loop (`DicomMessage._read`/`_readTag`)
-- kept in 1.0 both as the `DCMJS_CORE=eager` escape hatch and as this
reader's meta dependency -- can be deleted. Until then, treat
`AsyncDicomReader`'s API as subject to change.
