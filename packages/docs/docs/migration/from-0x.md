---
title: Migrating from dcmjs 0.x
---

dcmjs 1.0 is a breaking release. The read path was re-platformed onto a lazy,
offsets-only tokenizer (the vendored dicom-parser engine, see
[the parser package](../architecture/parser-package.md)), and the writer was
rebuilt around byte-faithful passthrough and length backpatching. Most 0.x
code keeps working unchanged; this page lists everything that does not, plus
the behavior shifts you should know about even when your code compiles.

:::note
This page describes `1.0.0-beta.0`. The eager 0.x read core still ships in the
beta as an escape hatch and is scheduled for deletion in 1.x — see the
[roadmap](../development/roadmap.md).
:::

## The lazy core is now the default

`DicomMessage.readFile` defaults to the lazy core: the file is tokenized into
offsets up front, and each entry's `Value` / `_rawValue` materialize on first
access. The resulting `DicomDict` has the same shape as before — same `meta` /
`dict` split, same clean uppercase string keys (`"00100010"`), same
`{ vr, Value, _rawValue }` entries — and the full 635-test suite passes
identically on both cores.

If you need the 0.x eager behavior during the beta soak, there are two escape
hatches:

```js
// Per call:
const dicomDict = dcmjs.data.DicomMessage.readFile(arrayBuffer, {
    core: "eager" // default is "lazy"
});
```

```bash
# Globally, e.g. to bisect a suspected lazy-core difference in CI:
DCMJS_CORE=eager npm test
```

`options.core` accepts `"lazy"` or `"eager"`; anything else throws.

## Error timing changed (lazy core)

Because values are decoded on first access instead of during the read loop,
errors that 0.x raised *mid-scan* now surface *later*:

- **`ignoreErrors: false`** — if an element's bytes fail to materialize (for
  example an unsupported `SpecificCharacterSet` inside a sequence item, or
  encapsulated pixel data with a garbage tag in its fragment stream), 0.x threw
  during `readFile`. 1.0 returns the `DicomDict` and throws the equivalent
  error at the **first access** of that entry's `Value` or `_rawValue`.
- **`ignoreErrors: true`** — 0.x caught the error mid-scan and returned a dict
  **truncated** at the failing element: everything at and after it was silently
  lost. 1.0 returns the **full** dict; only the failing entry resolves to
  `Value`/`_rawValue` of `undefined`, with one logged warning per entry. You
  get strictly more data back than 0.x did.

If your error handling wrapped `readFile` in a `try`/`catch`, extend it to
cover the first traversal of the dataset (or `naturalizeDataset`, which
touches everything).

## Removed APIs

- **`DicomMessage.read` and `DicomMessage.readTag`** — the deprecated statics
  (warned since 0.24) are gone. Use `DicomMessage.readFile`.
- **`DICOMWEB`** — the legacy `DICOMWEB` class was deleted. Use the dedicated
  [dicomweb-client](https://github.com/dcmjs-org/dicomweb-client) package.

```js
// 0.x
const dicomData = dcmjs.data.DicomMessage.read(bufferStream, syntax);

// 1.0
const dicomData = dcmjs.data.DicomMessage.readFile(arrayBuffer);
```

## Logging no longer touches your root logger

0.x called `log.setLevel(...)` on the global `loglevel` root logger at import
time, clobbering the host application's log level. 1.0 uses a named child
logger instead:

```js
import { log } from "dcmjs";
// `log` is loglevel.getLogger("dcmjs") — configure it without
// affecting the rest of your application:
log.setLevel("debug");
```

Importing dcmjs no longer reconfigures any logger you own. If you previously
relied on dcmjs setting the root level, set it yourself.

## Deflate is now real on write

If a dataset's meta declared the deflated transfer syntax
(`1.2.840.10008.1.2.1.99`), 0.x **silently wrote an uncompressed body** while
keeping the deflated UID in the meta — producing non-conformant files. 1.0
writes an uncompressed meta group followed by a raw-deflated body, as the
standard requires. Reading deflated files works as before (pako is the default
inflater). See the [deflate guide](../guides/deflate.md).

If you depended on the 0.x bug (for example, a downstream consumer that never
inflated the body), you must now either change the `TransferSyntaxUID` before
writing or inflate on read.

## Editing rules under the passthrough writer

The 1.0 writer emits the original source bytes verbatim for entries that were
never modified ([writer architecture](../architecture/writer.md)). Dirtiness
is **assignment-based**: setting `entry.Value = [...]`, item entry assignments
like `item["00081150"].Value = [...]`, and `DicomDict.upsertTag` all mark the
entry dirty and force a re-encode.

**In-place mutation of a materialized value is undetectable**:

```js
// WRONG under 1.0 — the entry still looks clean, and the writer
// emits the ORIGINAL bytes:
dicomDict.dict["00081115"].Value.push(newItem);
dicomDict.dict["0008103E"].Value[0] = "edited";

// RIGHT — assignment marks the entry dirty:
dicomDict.dict["00081115"].Value = [...dicomDict.dict["00081115"].Value, newItem];
dicomDict.dict["0008103E"].Value = ["edited"];
// or:
dicomDict.upsertTag("0008103E", "LO", ["edited"]);
```

One safety net exists for sequences: structural edits to materialized SQ items
(added/removed keys, added/removed items) are re-verified at write time and
re-encoded on mismatch. Leaf-level in-place mutation remains undetectable by
design. See [writing and editing](../guides/writing-and-editing.md) for the
full rules.

## `nameMap` is built lazily

`DicomMetaDictionary.nameMap` used to be built at import time (~5000 objects).
It is now constructed on first access. The contents are identical; only code
that depended on import-time side effects (there should be none) can notice.

## What did *not* change

- **`DicomDict` shape** — `meta` / `dict`, clean uppercase string keys, entry
  shape `{ vr, Value, _rawValue }`, `upsertTag`, `write()`.
- **`readFile` options** — `ignoreErrors`, `untilTag`, `includeUntilTagValue`,
  `noCopy`, `forceStoreRaw` are all still accepted with the same semantics.
- **Naturalization** — `naturalizeDataset` / `denaturalizeDataset` produce the
  same shapes as 0.x in this beta, including the instance-driven scalar
  collapse. (A switch to VM-driven shapes is an open 1.0 decision — see the
  [roadmap](../development/roadmap.md).) Naturalizing a lazy dataset simply
  materializes everything it touches, which is what it always meant
  semantically. See [naturalized datasets](../guides/naturalized-datasets.md).
- **Character set handling** — the ISO_IR 192 normalize-on-read rewrite is
  kept; per-sequence-item character sets now actually work (an improvement
  over 0.x's single top-level charset). See
  [character sets](../guides/character-sets.md).
- **`AsyncDicomReader`** and the streaming path — unchanged in this release
  (re-platforming onto the tokenizer is 1.x work).
- **Adapters, SR, anonymizer, derivations** — untouched by the rewiring.

## Bonus guarantees you get for free

- Read → write with zero edits reproduces the input **byte-for-byte** — a
  guarantee 0.x never had (enforced by a byte-identity suite over the corpus).
- Parsing cost is now independent of value sizes, and rewrites of mostly-clean
  files are near-memcpy. See [performance](../performance.md) for measured
  numbers.
