# QA report — v2.0-development

A point-in-time answer to "how do we know this library works?", written
for readers who were not in the room. Every number below comes from a
run executed on the date shown, on the branch shown, and every claim
says how to reproduce it. Last full run: **2026-08-30**, branch
`v2.0-development`, Apple M4 / Node v25.9.0.

## The short version

- The full test suite is green: **136 of 137 suites passed (1
  skipped), 1,998 of 2,001 tests passed (3 skipped), zero failures**
  (exit 0, 728 s wall clock — dominated by the streamed-versus-eager
  equivalence suite, which re-reads every fixture both ways).
- The strict TypeScript gate is green (`pnpm run check:types`, exit 0):
  the generated schema types and the per-IOD dataset types compile
  under `--strict` against real consumer code.
- The generated artifacts are deterministic: regenerating the
  dictionary, the naturalized schema, and the IOD catalog from their
  sources reproduces the committed files byte-for-byte, enforced as
  ordinary jest tests so CI fails if generation drifts.
- 329 hostile files from other projects' test corpora parse through
  all three read paths; the 28 that still fail are cataloged, and most
  fail *correctly* (truncated or spec-violating files rejected with
  corrective errors).
- Speed is unchanged since the 1.x benchmarks; bundle-load memory grew
  and is filed as a tranche 2 item (see BENCHMARKS.md).

## What the suite actually covers

Run it yourself: `pnpm install && pnpm test` (jest, 60 s per-test
timeout). The suite divides into layers:

**Unit and round-trip tests** — the classic core: read, write,
naturalize, denaturalize, anonymize, DICOMDIR, FHIR mapping, the event
stream (vocabulary, filters, backpressure), the streaming Part 10
writer, and lossless read-edit-write cycles across the committed
fixtures.

**Issue-derived tests** — the dcmjs-org issue tracker, datamined:
82 of the 172 total issues (39 of the 76 open ones) have named
reproducer tests, built from synthetic files or verified-anonymized
derivatives under the tiered attachment policy in ISSUE_TEST_PLAN.md.
These pin down real-world failures the way users actually hit them.

**Validation engine tests** — layer 1 (field well-formedness), layer 2
(cross-field arithmetic: pixel geometry, bit depths, transfer-syntax
coherence), layer 3 (the Part 3 IOD rulebook), plus a parity gate
proving the streaming validator (`ValidationListener`) and the eager
`validate()` produce identical reports on the same bytes.

**Character set tests** — decode fixtures for the ISO 2022 escape
family (Japanese, Korean, Chinese, the Latin variants), verified
against dclunie's reference files, plus the write-side policy tests:
by default dcmjs never writes a file whose declared character set
disagrees with its bytes.

**Corpus regression tests** — synthetic reconstructions of the
hostile-file classes found in ecosystem corpora (length overruns,
short meta group lengths, missing preambles, UN-encoded sequences,
invalid UID characters), committed as ordinary fixtures so the fixes
cannot regress.

**Determinism gates** — the generated dictionary, schema, and IOD
catalog are rebuilt in-test and compared byte-for-byte to the
committed artifacts.

## The ecosystem corpus sweep (not in CI)

329 files from the pydicom-data and gdcm test collections — files
contributed over two decades precisely because they broke somebody's
parser — are swept through all three read paths (eager, streaming,
lazy) by `scripts/corpus-runner.mjs`, each file in its own subprocess.
State at tranche 1 close: failures reduced from 38 to 28 over four
waves, cross-path divergences from 4 to 1 (the remaining one is a
palette file where dcmjs is right and the comparison library is
wrong). The 28 remaining failures are cataloged with per-file causes;
most are deliberate rejections of files that violate the spec. These
corpora are not redistributable, so this sweep runs locally, not in
CI — redistribution is an open question in V2_ROADMAP.md.

## What is *not* covered (honestly)

- **Pixel decoding** — dcmjs ships no image codecs by design; the
  compressed-syntax claims in COMPATIBILITY.md are parse/carry claims,
  verified structurally, not rendering claims.
- **Layer 3 severity calibration** — IOD validation is complete but
  young; it is opt-in (`layers: [1,2,3]`) until its verdicts have been
  compared against dciodvfy across a broad corpus.
- **Mixed explicit/implicit VR files** — two known gdcm specimens fail
  by choice; supporting them is an open team question.
- **Adapters (Cornerstone/VTK) and SR/SEG builders** — cataloged in
  ISSUE_TEST_PLAN.md as ~30 sketched work orders, not yet built.

## Reproduce everything

```bash
pnpm install
pnpm test                 # the full suite
pnpm run check:types      # strict TypeScript gate
pnpm run build            # the bundle applications load
node scripts/bench.mjs    # the benchmark table (see BENCHMARKS.md)
node scripts/corpus-runner.mjs <corpus-dir>   # if you have corpora locally
```
