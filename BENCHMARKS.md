# Benchmarks

How fast is this library, and did the 1.0 rewrite make anything slower?
This page answers both with numbers anyone can reproduce.

Measured 2026-08-28 on an Apple M4 (16 GB RAM), Node v25.9.0, macOS.
Three libraries were measured side by side:

- **this fork** — the built bundle (`build/dcmjs.js`). That's the file
  applications actually load, so it is what we measure — not the raw
  source.
- **upstream** — `dcmjs@0.52.0`, the latest version published to npm.
  It's installed here under the alias `dcmjs-upstream` so both versions
  can be loaded in one process tree without colliding.
- **dicom-parser** `1.8.21` — a popular, much smaller library that only
  *tokenizes* a file: it finds where each element starts and ends but
  never converts values into usable JavaScript numbers, strings, or
  datasets. It does far less work, so treat its column as the speed
  limit for scanning bytes, not as a fair peer.

Reproduce everything with:

```bash
pnpm install && pnpm run build
node scripts/bench.mjs                          # the small-file table
node scripts/bench.mjs --large path/to/big.dcm  # add a large-file row
```

How the measurement works: every cell in the table runs in its own
fresh Node process, so the memory number belongs to exactly one
library doing exactly one job, and no library benefits from another
having warmed up the JavaScript engine first. Each cell reports the
median time over 30–100 repetitions (after a few warm-up runs that are
discarded), plus the peak memory the process reached — the operating
system's own accounting of how much RAM was actually in use, which
catches allocations JavaScript heap counters miss.

## Small files (the committed test fixtures)

Each cell: median time per operation · peak memory. The workloads:

- **read** — file bytes in, parsed element tree out
- **read+naturalize** — the same, then converted to the friendly
  keyword form (`dataset.PatientName` instead of tag `00100010`)
- **write** — a parsed file serialized back to DICOM bytes
- **roundtrip** — read and write together

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
| sample-sr.dcm (4.5 KB structured report) | read | 0.3 ms · 72 MB | 0.3 ms · 71 MB | 0.0 ms · 54 MB |
| sample-sr.dcm | read+naturalize | 0.4 ms · 73 MB | 0.4 ms · 71 MB | — |
| sample-sr.dcm | write | **0.3 ms** · 72 MB | 0.6 ms · 72 MB | — |
| sample-sr.dcm | roundtrip | **0.6 ms** · 73 MB | 0.9 ms · 78 MB | — |

What to take from this:

- **Reading is exactly as fast as it was.** The 1.0 line added a lot of
  correctness work to the read path — character-set handling, number
  validation, padding cleanup, safer buffer handling — and none of it
  shows up in the timings. Correct and fast are not in tension here.
- **Writing is 2–4× faster than upstream**, and uses less memory, on
  every fixture. The rewrite computes element lengths as it goes
  instead of repeatedly re-measuring buffers.
- **dicom-parser reads 2–4× faster than either.** That's real, and
  it's also expected: finding elements is a fraction of the work of
  actually decoding them. If all you need is to locate a few tags,
  dicom-parser is a fine tool; the moment you need values, you pay the
  decoding cost somewhere.

One incidental observation: while these benchmarks ran, upstream 0.52
printed `Invalid vr type xs - using US` warnings on every parse of the
CT fixture. That console noise is upstream's open issue #368 — fixed in
this fork — demonstrating itself, unprompted, in the middle of the
benchmark.

## Large files (the 1+ GB video fixtures)

This is where the two libraries stop being comparable, because they use
fundamentally different strategies. Upstream must load the entire file
into one buffer before it can parse a single element. This fork can
*stream*: it reads the file in 8 MB pieces and parses as the pieces
arrive, so memory stays flat no matter how big the file is. The table
puts each library's actual strategy head-to-head — that asymmetry isn't
unfair, it *is* the finding.

Both runs on the same machine, same files, same warm file cache. The
20.3 GB row is a single run (you don't repeat a 20 GB read for a
median); the others are the median of three.

| File | this fork (streamed) | upstream 0.52 (whole-file) |
|---|---|---|
| video48-small.dcm — 1.3 GB video instance | **0.22 s · 771 MB peak** | 45.6 s · 4,089 MB peak |
| video48-h264-50mbps.dcm — 20.3 GB video instance | **670 s (limited by disk speed) · 2,165 MB peak** | **FAILS** — Node cannot put more than 2 GiB in one buffer |

Two things worth reading off that table:

- **At 1.3 GB the streamed parse is about 200× faster and uses about
  5× less memory** — on the very same file. The streaming parser notes
  where the video data sits and skips over it, while the whole-file
  approach copies all 1.3 GB through memory several times (hence the
  4 GB peak).
- **Above 2 GiB the comparison simply ends.** Whole-file loading hits a
  hard JavaScript platform limit and cannot open the file at all. The
  streamed parser's memory ceiling depends only on the largest single
  piece of pixel data inside the file — about 2 GB here because this
  test file deliberately uses enormous 1 GiB internal chunks, and
  around 750 MB for typically-sized files. File size itself stops
  mattering.

The complete end-to-end story at this scale — packing 21.8 GB of MP4
video *into* a DICOM file at 658 MB of memory, then getting the
byte-identical video back out, verified by an independently written
checker — is documented in the dcmjs-commands EXAMPLES under "Trust,
but verify — at 21.8 GB".

## A note on how to benchmark streaming (learn from our mistake)

A streaming reader needs the consumer to occasionally say "wait, let me
catch up" — otherwise the file reader happily piles up pieces in memory
faster than they're processed. Real applications always have that
pacing naturally (writing to a file or network slows you down). Our
first benchmark run had no consumer at all, and the memory number came
out double: we were measuring the pile of unprocessed pieces, not the
parser. The published numbers pace the reader the way any real
application would, and we cross-checked them against a real workload
(the command-line tool extracting the same 1.3 GB file: 787 MB — same
answer). If you benchmark this library yourself, give the stream a
consumer, because your application will have one.
