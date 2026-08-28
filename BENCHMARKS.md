# Benchmarks

Measured 2026-08-28 on an Apple M4 (16 GB RAM), Node v25.9.0, macOS.
Contenders:

- **this fork** — the built bundle (`build/dcmjs.js`), i.e. the shipped
  artifact, on the `development` branch after the issue-gap-fix arc
- **upstream** — `dcmjs@0.52.0`, the latest published to npm (installed
  as the `dcmjs-upstream` devDependency alias)
- **dicom-parser** `1.8.21` — parse-only reference; it indexes elements
  without materializing or converting values, so treat its column as the
  speed of light for tokenizing, not as an equivalent workload

Reproduce with:

```bash
pnpm install && pnpm run build
node scripts/bench.mjs                          # committed-fixture corpus
node scripts/bench.mjs --large path/to/big.dcm  # add large-file rows
```

Methodology: every cell runs in a fresh Node process
(`scripts/bench-worker.mjs`) so peak RSS is attributable and no
contender warms another's caches; median over N iterations after
warmup; RSS is the process's `resourceUsage().maxRSS`.

## Small-file corpus (committed fixtures)

Median per operation · peak process RSS. N = 30–100 per cell.

| Fixture | Workload | this fork | upstream 0.52 | dicom-parser |
|---|---|---|---|---|
| sample-dicom.dcm (528 KB CT image) | read | 0.3 ms · 77 MB | 0.3 ms · 77 MB | 0.1 ms · 52 MB |
| sample-dicom.dcm | read+naturalize | 0.3 ms · 77 MB | 0.3 ms · 76 MB | — |
| sample-dicom.dcm | write | **0.3 ms** · 89 MB | 1.0 ms · 97 MB | — |
| sample-dicom.dcm | roundtrip | **0.5 ms** · 87 MB | 1.2 ms · 100 MB | — |
| cine-test.dcm (1.0 MB multiframe) | read | 0.4 ms · 88 MB | 0.4 ms · 84 MB | 0.1 ms · 55 MB |
| cine-test.dcm | read+naturalize | 0.5 ms · 84 MB | 0.6 ms · 82 MB | — |
| cine-test.dcm | write | **0.4 ms** · 95 MB | 1.7 ms · 125 MB | — |
| cine-test.dcm | roundtrip | **0.9 ms** · 94 MB | 2.1 ms · 108 MB | — |
| sample-op.dcm (103 KB encapsulated) | read | 0.2 ms · 74 MB | 0.2 ms · 73 MB | 0.0 ms · 51 MB |
| sample-op.dcm | read+naturalize | 0.2 ms · 74 MB | 0.2 ms · 72 MB | — |
| sample-op.dcm | write | **0.2 ms** · 79 MB | 0.4 ms · 76 MB | — |
| sample-op.dcm | roundtrip | 0.4 ms · 80 MB | 0.5 ms · 77 MB | — |
| sample-sr.dcm (4.5 KB SR) | read | 0.3 ms · 72 MB | 0.3 ms · 71 MB | 0.0 ms · 54 MB |
| sample-sr.dcm | read+naturalize | 0.4 ms · 73 MB | 0.4 ms · 71 MB | — |
| sample-sr.dcm | write | **0.3 ms** · 72 MB | 0.6 ms · 72 MB | — |
| sample-sr.dcm | roundtrip | **0.6 ms** · 73 MB | 0.9 ms · 78 MB | — |

Read: **parity with upstream** — the 1.0 correctness work (charset
resolution, DS grammar validation, NUL stripping, view-boundary-safe
buffer ingest) costs nothing measurable. Write: **2–4× faster than
upstream** with lower peak memory, across every fixture. dicom-parser
reads 2–4× faster than either — expected, since it stops at tokenizing.

An incidental data point: upstream 0.52 printed `Invalid vr type xs -
using US` warnings on every `sample-dicom.dcm` parse during these runs —
that log spam is upstream issue #368, fixed in this fork.

## Large files (Supplement 225 video fixtures)

Full parse of the file: this fork streams (`fromPart10Stream` over an
8 MiB fs stream, backpressure-gated); upstream has no streaming reader,
so its cell is whole-file `readFile` — that asymmetry is the point.
Warm page cache; fork numbers are the median of 3, the 20.3 GB row is a
single cold run.

| File | this fork (streamed) | upstream 0.52 (whole-file) |
|---|---|---|
| video48-small.dcm — 1.3 GB, 6 fragments | **0.22 s · 771 MB peak** | 45.6 s · 4,089 MB peak |
| video48-h264-50mbps.dcm — 20.3 GB, 21 × 1 GiB fragments | **670 s (disk-bound) · 2,165 MB peak** | **FAILS** — `File size (21767820782) is greater than 2 GiB` |

Two things worth reading off that table:

- At 1.3 GB the streamed parse is ~200× faster and uses ~5× less
  memory than upstream on the *same warm-cached file*: the streaming
  parser walks fragment spans without materializing pixel bytes, while
  the eager path copies the whole file several times over (4 GB peak
  for a 1.3 GB input).
- Above Node's 2 GiB single-buffer limit the comparison ends: the
  whole-file model cannot open the file at all. The fork's peak memory
  is bounded by roughly **2× the largest pixel fragment** — 2.1 GB
  against this file's deliberately hostile 1 GiB fragments, ~750 MB
  against ordinary 256 MiB fragments — flat with respect to file size.

The full end-to-end story at this scale (encapsulate 21.8 GB of MP4 →
DICOM at 658 MB RSS, byte-identical extraction verified by an
independent SHA-256 oracle) is documented in the dcmjs-commands
EXAMPLES ("Trust, but verify — at 21.8 GB").

## A note on backpressure (methodology footnote)

The streaming numbers gate the reader with a drain checkpoint, exactly
as every real consumer does (the CLI wires the write-stream's `drain`;
the bench yields to the event loop). Running the same walk with NO gate
lets the reader queue chunks arbitrarily far ahead of consumption and
peak RSS then measures the queue, not the parser (~1.6 GB on the 1.3 GB
file). If you benchmark this library yourself: set a drain, because your
application will have one.
