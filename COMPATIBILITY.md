# Transfer syntax compatibility matrix

What dcmjs actually does with each transfer syntax, with the test that
proves each claim. Three different verbs matter, and conflating them is
how compatibility tables lie:

- **Parse** — read the file's structure and metadata; expose pixel data
  bytes exactly as stored (encapsulated syntaxes: the compressed
  fragments, unmerged or per-frame per the BOT).
- **Carry** — write those bytes back out, structurally correct and
  byte-faithful to the stored pixel data. A read-edit-write cycle never
  transcodes.
- **Decode** — turn compressed pixel bytes into pixel values. **dcmjs
  deliberately ships no image codecs** (browser + Node portability);
  decoding is the consumer's job today and the pluggable codec
  registry's job in tranche 2 (see V2_ROADMAP.md, Gap 4).

| Transfer syntax | UID | Parse | Carry (write) | Decode | Evidence |
|---|---|---|---|---|---|
| Implicit VR Little Endian | 1.2.840.10008.1.2 | ✓ | ✓ | ✓ (native) | lossless-read-write, corpus sweep |
| Explicit VR Little Endian | 1.2.840.10008.1.2.1 | ✓ | ✓ | ✓ (native) | lossless-read-write, writer-backpatch |
| Deflated Explicit VR LE | 1.2.840.10008.1.2.1.99 | ✓ | ✓ (re-deflated) | ✓ (native) | write-deflate |
| Explicit VR Big Endian (retired) | 1.2.840.10008.1.2.2 | ✓ | ✓ | ✓ (native) | lossless-read-write |
| JPEG Baseline | 1.2.840.10008.1.2.4.50 | ✓ | ✓ | — | encapsulated suites; fromImage *encodes* by carrying consumer-supplied JPEG |
| JPEG Extended | 1.2.840.10008.1.2.4.51 | ✓ | ✓ | — | fromImage TS mapping (jpegInfo) |
| JPEG Lossless SV1 | 1.2.840.10008.1.2.4.70 | ✓ | ✓ | — | corpus sweep (gdcm); issue363 suite |
| JPEG-LS Lossless | 1.2.840.10008.1.2.4.80 | ✓ | ✓ | — | encapsulated suites, corpus sweep |
| JPEG 2000 Lossless | 1.2.840.10008.1.2.4.90 | ✓ | ✓ | — | corpus sweep (gdcm), issue-derived pins |
| JPEG 2000 | 1.2.840.10008.1.2.4.91 | ✓ | ✓ | — | corpus sweep |
| HTJ2K family | 1.2.840.10008.1.2.4.20x | ✓ | ✓ | — | structural (carry) path shared with all encapsulated syntaxes |
| MPEG2 / H.264 video family | 1.2.840.10008.1.2.4.100–.106 (+.1) | ✓ | ✓ | n/a (video streams) | fromVideo/toVideo suites — byte-identical MP4 recovery at 21.8 GB, oracle-verified |
| HEVC | 1.2.840.10008.1.2.4.107/.108 | ✓ | ✓ (carry) | — | encapsulated carry path; fromVideo rejects with the ffmpeg transcode message (no fragmentable HEVC syntax defined) |
| RLE Lossless | 1.2.840.10008.1.2.5 | ✓ | ✓ (one fragment per frame enforced) | — (encoder only: `rleSingleSamplePerPixel`) | issue293 suite (#340 fix), corpus sweep |

Notes:

- "✓ Parse/Carry" for encapsulated syntaxes is a *structural* claim:
  fragments and Basic Offset Tables round-trip correctly, verified by
  the lossless suites, the Supplement 225 video oracle, and the
  ecosystem corpus sweep (pydicom-data + gdcmData). It is **not** a
  claim that dcmjs can render those pixels.
- Known parse limitations, tracked as deliberate decisions: files
  mixing explicit VR for public elements with implicit VR for private
  elements (two gdcm corpus specimens) fail with corrective errors —
  supporting them is an open team question in V2_ROADMAP.md; UN-encoded
  sequences and undefined-length UN parse per PS3.5 §6.2.2.
- The validator (`dcmjs.validate`) checks transfer-syntax-vs-
  encapsulation coherence (`ts.encapsulation`) as a layer-2 rule.
