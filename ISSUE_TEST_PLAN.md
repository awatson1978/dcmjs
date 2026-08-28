# Issue-driven test plan

The upstream [dcmjs-org/dcmjs issue tracker](https://github.com/dcmjs-org/dcmjs/issues)
is a decade of field-reported edge cases — 172 issues (76 open, 96 closed
at harvest time). This document tracks the pipeline that converts them
into regression tests against the rewritten 1.0 library: every testable
issue becomes either a pinned green test or a documented known-gap with a
skipped reproducer. **No fixes land in this arc** — the gap table at the
bottom is the input to a later, prioritized fix pass.

## The pipeline

1. **Harvest.** `node scripts/harvest-issues.mjs` pulls every issue into
   [`test/issues/catalog.json`](test/issues/catalog.json) — metadata plus
   our triage fields. Re-running refreshes metadata and preserves triage.
   `--table` regenerates the triage table below; the catalog is the
   source of truth and the table is never edited by hand.
2. **Triage.** Each issue gets a category:
   - **A — synthetic**: reproducible with the in-repo synthesizers
     (`test/helper/sampleDicomPart10.js`,
     `test/helper/DicomDataReadBufferStreamBuilder.js`, direct
     `ValueRepresentation` / `DicomMetaDictionary` calls).
   - **B — fixture**: needs a real file — the dcmjs-org/data network
     corpus (gated by `itIfNetworkFixture`, cached in
     `$TMPDIR/dcmjs-test`) or a PHI-vetted issue attachment cached the
     same way (never committed; provenance noted in the test docblock).
   - **C — contract**: behavior the 1.0 rewrite deliberately defined or
     changed (single-item-SQ naturalization, IS/DS as JSON numbers,
     rawValue retention, PN proxies …). The test asserts the NEW
     contract; the docblock states the delta from the upstream report.
   - **covered**: the existing suite already pins it — the row cites the
     exact test.
   - **D — wave 2**: adapters / SR templates / SEG derivations. Fully
     cataloged with a reproducer sketch; test-writing is a separate
     later wave.
   - **E — n/a**: docs, CI, demos, questions, release chores.
3. **Author.** One `test/issues/issueNNN-slug.test.js` per issue or per
   tight cluster (per-issue `describe` blocks; the catalog records which
   file covers which issue). Docblock links the upstream URL and states
   the symptom. `validationLog.setLevel(5)` where garbage input is fed
   deliberately.
4. **Disposition.** Green → pinned regression. Red → the assertion stays
   intact under `it.skip("KNOWN GAP #NNN: …")` with a `// KNOWN GAP:`
   comment (observed vs expected), plus a row in the gap table below.
   `npm test` therefore stays green throughout, and no skip is silent.
5. **Fix pass (separate arc).** Work the gap table by severity; flipping
   a skip to green is the acceptance test for each fix.

## Status counts

Regenerate with `node scripts/harvest-issues.mjs --table` after any
catalog change. Current triage: **50 A · 8 B · 16 C · 11 covered ·
30 wave-2 · 57 n/a** (= 172). Testable this arc: **74** (A+B+C).

## Known gaps

Populated as tests are authored. Each row: upstream issue, observed
behavior in this library, the skipped test that reproduces it, severity.

| Issue | Symptom in 1.0 | Skipped test | Severity |
|---|---|---|---|
| _(pending — filled during authoring)_ | | | |

## Triage table

_(generated — do not edit by hand)_

<!-- TRIAGE-TABLE-START -->
### A — synthetic reproducer (50)

| # | Title | State | Area | Disposition | Test | Status |
|---|---|---|---|---|---|---|
| [10](https://github.com/dcmjs-org/dcmjs/issues/10) | iterate through dataset with forEach instead of for...in | closed | naturalizer | polluted Object.prototype must not corrupt naturalize/denaturalize/write (forEach-not-for-in) |  | triaged |
| [42](https://github.com/dcmjs-org/dcmjs/issues/42) | Ungraceful errors when undefined values comes to DicomMetaDictionary.denaturalizeValue | closed | values | denaturalizeValue on [null]/undefined arrays: graceful, actionable error (not TypeError) |  | triaged |
| [46](https://github.com/dcmjs-org/dcmjs/issues/46) | LT does not allow multiple | closed | values | LT is single-valued: backslash inside LT text must round-trip as ONE value |  | triaged |
| [61](https://github.com/dcmjs-org/dcmjs/issues/61) | UIDs with root 2.25 should be derived from UUID | open | uid | DicomMetaDictionary.uid(): 2.25 UIDs must be UUID-derived per PS3.5 B.2 (not random digit strings) |  | triaged |
| [84](https://github.com/dcmjs-org/dcmjs/issues/84) | toUTF8Array will convert ° into Â° | closed | charset | UTF-8 write must not double-encode (deg sign -> 0xC2 0xB0 exactly once) with ISO_IR 192 |  | triaged |
| [91](https://github.com/dcmjs-org/dcmjs/issues/91) | Text encoding, how to do it? | open | charset | upsertTag with non-ASCII + SpecificCharacterSet ISO_IR 192 round-trips (write side of #84) |  | triaged |
| [93](https://github.com/dcmjs-org/dcmjs/issues/93) | Is there a way to force-read a file if the DICM Tag in the header is missing? | open | reader | missing preamble/DICM: readFile option or corrective error (sampleDicomPart10.stripPreamble) |  | triaged |
| [95](https://github.com/dcmjs-org/dcmjs/issues/95) | writing dicom to file results in corrupted pixel data | open | writer | multi-frame RGB: edit strings then write; pixels byte-identical after round trip |  | triaged |
| [96](https://github.com/dcmjs-org/dcmjs/issues/96) | DecimalString are not correctly written to buffer | closed | values | DS 4.8 (Number) writes a value, not empty (DS/IS cluster) |  | triaged |
| [111](https://github.com/dcmjs-org/dcmjs/issues/111) | Naturalize and DenaturalizeDataset failed image result | open | naturalizer | naturalize->denaturalize->write->read round trip on synthetic multiframe stays valid + equal |  | triaged |
| [115](https://github.com/dcmjs-org/dcmjs/issues/115) | PixelRepresentation tag lost when saving an image  | closed | writer | PixelRepresentation (US, value 0) survives read->naturalize->denaturalize->write->read |  | triaged |
| [130](https://github.com/dcmjs-org/dcmjs/issues/130) | Null terminated strings are not read correctly | open | charset | NUL-padded strings (PN/CS/LO) strip trailing 0x00 on read |  | triaged |
| [145](https://github.com/dcmjs-org/dcmjs/issues/145) | Reading encapsulated pixel data? | open | reader | encapsulated multiframe: every frame surfaced, not only the first (fragments->frames via BOT) |  | triaged |
| [159](https://github.com/dcmjs-org/dcmjs/issues/159) | writeBytes is crashing the browser when using encapsulated files with lots of frames | closed | writer | many-frame encapsulated write: 120+ frames complete correctly (no per-frame quadratic blowup) |  | triaged |
| [161](https://github.com/dcmjs-org/dcmjs/issues/161) | DicomDict.write fails when a Sequence tag a OW type. | closed | writer | OW element inside SQ item writes without error and round-trips |  | triaged |
| [167](https://github.com/dcmjs-org/dcmjs/issues/167) | File size keep increasing | closed | writer | read->write cycles: byte size stabilizes after first rewrite (no unbounded growth) |  | triaged |
| [175](https://github.com/dcmjs-org/dcmjs/issues/175) | DecimalString values that use exponential notation are converted when reading a DICOM | closed | values | DS exponential notation round-trips within 16 chars (write re-formats, no throw) |  | triaged |
| [196](https://github.com/dcmjs-org/dcmjs/issues/196) | Error adding dicom headerError: Request more than currently allocated buffer | closed | writer | upsert PN then write: buffer growth handles size increase (no 'more than allocated' error) |  | triaged |
| [204](https://github.com/dcmjs-org/dcmjs/issues/204) | can't read an encapsulated frame whose size is greater than fragment size | closed | reader | frame larger than fragment size: read merges fragments per frame (BOT-aware) |  | triaged |
| [215](https://github.com/dcmjs-org/dcmjs/issues/215) | Support using custom dictionary in DicomMetaDictionary | closed | naturalizer | private/custom tags survive naturalize->denaturalize via private dictionary registration |  | triaged |
| [231](https://github.com/dcmjs-org/dcmjs/issues/231) | TypeError: Cannot redefine property: Alphabetic | open | naturalizer | naturalizing twice / re-naturalizing PN values must not throw 'Cannot redefine property: Alphabetic' |  | triaged |
| [242](https://github.com/dcmjs-org/dcmjs/issues/242) | Invalid VR of the private creator tag of the "Implicit VR Endian" typed DICOM file | open | reader | implicit-VR private creator tag resolves VR LO (PS3.5 7.8.1), not UN |  | triaged |
| [263](https://github.com/dcmjs-org/dcmjs/issues/263) | naturalizeDataset in v0.18.11 creates in memory objects of 300mb+  | closed | naturalizer | naturalized output contains no injected null padding (0.18.11 300MB regression class) |  | triaged |
| [282](https://github.com/dcmjs-org/dcmjs/issues/282) | Bug: Fragment merging results in zero value arraybuffer | closed | reader | fragment merge uses byte-correct typed copy (no zero-filled result) |  | triaged |
| [287](https://github.com/dcmjs-org/dcmjs/issues/287) | Pixel Spacing parsing with comma as decimal separator is returning incorrect value | closed | values | DS with comma decimal separator: defined, non-garbage behavior (raw preserved; no wrong number) |  | triaged |
| [293](https://github.com/dcmjs-org/dcmjs/issues/293) | Encapsulated pixel data of odd-length writes padding byte in incorrect location | closed | writer | odd-length encapsulated frames: pad byte per frame's final fragment, not tag end (pydicom parity) |  | triaged |
| [297](https://github.com/dcmjs-org/dcmjs/issues/297) | ReadBufferStream not support latine 1 on Mobile | open | charset | latin1 TextDecoder unavailable (mobile): graceful fallback (monkeypatch TextDecoder in test) |  | triaged |
| [315](https://github.com/dcmjs-org/dcmjs/issues/315) | Changing instance UID corrupts file, Invalid DICOM file, expected header is missing | open | writer | naturalize -> change SOPInstanceUID -> denaturalize -> write yields valid Part 10 with updated meta |  | triaged |
| [324](https://github.com/dcmjs-org/dcmjs/issues/324) | NaN and Infinity number values cause write to fail | closed | values | NaN/Infinity in FD/FL/DS: read succeeds; write has defined behavior (value or corrective error), never bare throw |  | triaged |
| [338](https://github.com/dcmjs-org/dcmjs/issues/338) | DicomMessage.readFile failes if GroupLength parameter is wrong calculated | closed | reader | wrong FileMetaInformationGroupLength tolerated: body still parsed (sampleDicomPart10 patched length) |  | triaged |
| [340](https://github.com/dcmjs-org/dcmjs/issues/340) | US cine loops with Transfer Syntax RLE Lossless are corrupted after DicomMessage.write when fragmentMultiframe option is enabled  | open | writer | RLE transfer syntax: fragmentMultiframe must not re-fragment frames (one fragment per frame preserved) |  | triaged |
| [345](https://github.com/dcmjs-org/dcmjs/issues/345) | anonymizer uses incorrect tag names | open | anonymizer | every name in getTagsNameToEmpty resolves to a real dictionary keyword (list the wrong ones) |  | triaged |
| [356](https://github.com/dcmjs-org/dcmjs/issues/356) | private Tags take element wrong into account | open | values | Tag.isPrivateCreator range per PS3.5 7.8: creator element 0x10-0xFF; 0x01-0x0F excluded |  | triaged |
| [365](https://github.com/dcmjs-org/dcmjs/issues/365) | Order of tags gets messed up when edition DICOM SEG | open | writer | edited dataset writes with ascending tag order regardless of naturalized key insertion order |  | triaged |
| [366](https://github.com/dcmjs-org/dcmjs/issues/366) | Length of Decimal String larger than 16 characters | open | values | DS 16-char formatting: 0.99990081787109 writes within 16 chars (DS/IS cluster) |  | triaged |
| [368](https://github.com/dcmjs-org/dcmjs/issues/368) | Lots of 'Invalid vr type... ' log messages in dcmjs release 0.29.11 | open | reader | dictionary VR 'xs' resolves silently to US/SS by PixelRepresentation (no log spam) |  | triaged |
| [374](https://github.com/dcmjs-org/dcmjs/issues/374) | Getting ERROR: Value exceeds max length for some DICOM tags | closed | values | garbage over-length AS/TM values read leniently (rawValue kept), strict only on write |  | triaged |
| [388](https://github.com/dcmjs-org/dcmjs/issues/388) | Fail to denaturalize a sequence having private tags. | open | naturalizer | SQ items containing private tags denaturalize without numeric-key/accessor collision |  | triaged |
| [417](https://github.com/dcmjs-org/dcmjs/issues/417) | Tag value [undefined] causing unable to write a dicomDict | closed | writer | element with Value [undefined] writes with defined behavior (skip/empty/corrective error, not TypeError) |  | triaged |
| [418](https://github.com/dcmjs-org/dcmjs/issues/418) | Tag consistency issue during roundtrip file loading/saving/loading | closed | writer | round trip preserves full element set of encapsulated-PDF fixture (dcmjs-dimse regression class) |  | triaged |
| [437](https://github.com/dcmjs-org/dcmjs/issues/437) | When converting Philip MR files to JSON using json generate.js, Invalid tag in sequence error. | closed | reader | dictionary VR 'ox' resolves silently to OW/OB (fold with #368) |  | triaged |
| [451](https://github.com/dcmjs-org/dcmjs/issues/451) | DicomMessage._read() Sets Decoder Too Late in Some Cases | open | charset | decoder applies to strings parsed after 00080005 wherever it appears; nested content uses dataset charset (fold #503) |  | triaged |
| [458](https://github.com/dcmjs-org/dcmjs/issues/458) | Bug : Empty dicom file writen by 0.45 | closed | writer | pixel data never silently lost on write (allowInvalidVRLength path; 0.45 regression class; with #466) |  | triaged |
| [466](https://github.com/dcmjs-org/dcmjs/issues/466) | DCMTK Error after passing in DcmJs write | closed | writer | written output re-parses strictly (our own strict re-read as DCMTK proxy; fold with #458) |  | triaged |
| [477](https://github.com/dcmjs-org/dcmjs/issues/477) | AsyncDicomReader().readFile() creates wrongly nested pixel data element | open | stream | AsyncDicomReader.readFile: pixel data element not wrongly nested (+ docs setData mismatch) |  | triaged |
| [478](https://github.com/dcmjs-org/dcmjs/issues/478) | AsyncDicomReader().read({ untilTag: TAG, includeUntilTag: false }) is broken | open | stream | AsyncDicomReader.read({untilTag, includeUntilTag:false}) honors the flag without crash |  | triaged |
| [479](https://github.com/dcmjs-org/dcmjs/issues/479) | Handling raw values with AsyncDicomReader | open | stream | AsyncDicomReader preserves rawValue like DicomMessage._readTag |  | triaged |
| [487](https://github.com/dcmjs-org/dcmjs/issues/487) | `CodeString.writeBytes()` throws on valid multivalued CS tag when individual value exceeds maxLength of 16 | open | values | multivalued/private CS: per-component >16 chars has an escape hatch (lenient read; write option), not hard throw |  | triaged |
| [503](https://github.com/dcmjs-org/dcmjs/issues/503) | Sequence-nested string content decoded with Latin-1 instead of SpecificCharacterSet (UTF-8 mojibake) | open | charset | SQ-nested strings decode with dataset SpecificCharacterSet, not hard-coded latin1 (eager + stream paths) |  | triaged |
| [505](https://github.com/dcmjs-org/dcmjs/issues/505) | unit2CodingValue has no entry for "cm" — centimetre measurements become [arb'U]{cm} | open | sr-utilities | unit2CodingValue('cm') maps to UCUM cm, not [arb'U]{cm} (pure function; cheap despite SR area) |  | triaged |

### B — needs fixture (8)

| # | Title | State | Area | Disposition | Test | Status |
|---|---|---|---|---|---|---|
| [78](https://github.com/dcmjs-org/dcmjs/issues/78) | Some RLE encoded segmentations cannot be read with readFile | open | reader | some RLE-encoded SEGs unreadable (fixture: dcmjs-org/data or vetted attachment) |  | triaged |
| [86](https://github.com/dcmjs-org/dcmjs/issues/86) | readFile failing on (some?) images with palette color LUTs | open | reader | readFile on palette-color-LUT images (OHIF #1350 file) |  | triaged |
| [284](https://github.com/dcmjs-org/dcmjs/issues/284) | [Question] Dataset in different language  | closed | charset | Korean (ISO 2022 IR 149) decode — dclunie charset corpus |  | triaged |
| [347](https://github.com/dcmjs-org/dcmjs/issues/347) | The saved image file is inconsistent with the source file. | closed | writer | positioning lines (overlay in pixel high bits?) lost after read->save (fixture link likely dead; note only) |  | triaged |
| [363](https://github.com/dcmjs-org/dcmjs/issues/363) | Invalid tag in sequence : Unable to parse MR Dicom file in dcmjs. Cornerstone able to parse and works fine | open | reader | MR file with 'invalid tag in sequence' unreadable (ZIP attached upstream — vetted-attachment candidate) |  | triaged |
| [373](https://github.com/dcmjs-org/dcmjs/issues/373) | Reading dicom file | open | charset | multi-valued SpecificCharacterSet with code extensions ('\ISO 2022 IR 149') parses (dclunie corpus) |  | triaged |
| [454](https://github.com/dcmjs-org/dcmjs/issues/454) | Wrong decoding from ISO 2022 IR 100 to ISO IR 192 (UTF-8)? | open | charset | ISO 2022 IR 100 escape-switching inside SR text decodes without mojibake (dclunie corpus) |  | triaged |
| [484](https://github.com/dcmjs-org/dcmjs/issues/484) | Handle SR node encoding without overriding global encoding. | open | charset | SR node-level charset without clobbering global decoder (family #454/#503; dclunie corpus) |  | triaged |

### C — contract assertion (16)

| # | Title | State | Area | Disposition | Test | Status |
|---|---|---|---|---|---|---|
| [3](https://github.com/dcmjs-org/dcmjs/issues/3) | Handle MappingResource and MappingResourceUID | closed | naturalizer | MappingResource vs MappingResourceUID must naturalize to distinct keywords (no UID-suffix dropping) |  | triaged |
| [6](https://github.com/dcmjs-org/dcmjs/issues/6) | create NDD compatible JSON objects | closed | naturalizer | NDD naming contract: keywords keep UID/Sequence suffixes; no UID value auto-naming (fold with #3) |  | triaged |
| [52](https://github.com/dcmjs-org/dcmjs/issues/52) | UN odd to even padding | closed | values | UN odd-length pads with NUL to even (current PS3.5 contract); assert round-trip preserves declared length |  | triaged |
| [53](https://github.com/dcmjs-org/dcmjs/issues/53) | IntegerString (IS) and maybe other VRs should be Number not String | closed | values | IS/DS emit as JSON Numbers in the DICOM JSON model (dcm4chee parity) |  | triaged |
| [90](https://github.com/dcmjs-org/dcmjs/issues/90) | DICOM Tag Length are Modified using dcmjs | open | writer | defined-length SQ rewritten as undefined length: legal, semantically equal round trip (byte-identity non-goal; document) |  | triaged |
| [114](https://github.com/dcmjs-org/dcmjs/issues/114) | Should natruralizing datasets unpack Overlay data/ RedPaletteColorLookupTableData, etc. | open | naturalizer | contract: naturalizer does NOT unpack OverlayData/palette bulk (document shape via test) |  | triaged |
| [162](https://github.com/dcmjs-org/dcmjs/issues/162) | Enable a force write option for files with abnormal VRs | open | writer | abnormal-VR force write via writeOptions (allowInvalidVRLength) — assert option contract both ways |  | triaged |
| [172](https://github.com/dcmjs-org/dcmjs/issues/172) | Expose the `cleanTags` function from anonymizer | closed | anonymizer | cleanTags + getTagsNameToEmpty exported and functional (assert public surface) |  | triaged |
| [218](https://github.com/dcmjs-org/dcmjs/issues/218) | naturalizeDataset make sequences of length 1 into an object, which makes it hard to write generic code - replaced with #219 | closed | naturalizer | single-item SQ naturalization contract (array-with-proxy; PerFrameFunctionalGroupsSequence[0] works) |  | triaged |
| [273](https://github.com/dcmjs-org/dcmjs/issues/273) | Inconsistent data from SR generate report and naturalizing the dataset | closed | naturalizer | proxy single-item array consistency between naturalize and SR generate (fold with #218) |  | triaged |
| [311](https://github.com/dcmjs-org/dcmjs/issues/311) | Trouble doing basic loading | closed | reader | Node Buffer (pooled view) passed to readFile: works or corrective error — the .buffer footgun (with #370) |  | triaged |
| [381](https://github.com/dcmjs-org/dcmjs/issues/381) | PN tags interpretation as union between object and string breaks DIMSE functionality | closed | naturalizer | PN union contract: naturalized PN object + toString/DIMSE-compatible access (with #413) |  | triaged |
| [398](https://github.com/dcmjs-org/dcmjs/issues/398) | Loss of precision when serializing Decimal String (DS) and Integer String (IS)  | closed | values | DS/IS precision: rawValue retention preserves 1.0000/+1.234/large-int on round trip (cite or extend precision tests) |  | triaged |
| [404](https://github.com/dcmjs-org/dcmjs/issues/404) | Can it optionally apply formatting? | open | values | DICOM JSON model output is schema-clean: no _rawValue keys leak into DicomWebJsonWriter output |  | triaged |
| [413](https://github.com/dcmjs-org/dcmjs/issues/413) | Garbled character of transformed DCM file | closed | naturalizer | PN [{Alphabetic}] shape writes back to valid PN bytes (fold with #381) |  | triaged |
| [457](https://github.com/dcmjs-org/dcmjs/issues/457) | VRInstances missing OL, OV, SV, and UV value representation (VR) types | open | values | UV VRinstance real (video arc); OL/OV/SV fall back to UN safely with single warning — assert both halves |  | triaged |

### already covered by the existing suite (11)

| # | Title | State | Area | Disposition | Test | Status |
|---|---|---|---|---|---|---|
| [65](https://github.com/dcmjs-org/dcmjs/issues/65) | Convert JSON TO dicom object | closed | reader | DICOM JSON -> dataset -> Part 10 covered by fromDicomWebJson/denaturalize suites (cite exact tests) | existing: test/eventStream/fromDicomWebJson.test.js (DICOM JSON → events → Part 10) | covered |
| [125](https://github.com/dcmjs-org/dcmjs/issues/125) | dcmjs.data.DicomMessage.readFile() fails for certain dicom SR | closed | reader | SR readFile covered by sample-sr round-trip suites (cite; issue file unavailable) | existing: test/data.test.js:1007 (sample-sr.dcm read + round trip) | covered |
| [222](https://github.com/dcmjs-org/dcmjs/issues/222) | pdf2dcm | closed | writer | pdf2dcm exists: encapsulatePdf round-trip suite (cite encapsulatedPdf.test.js) | existing: test/encapsulatedPdf.test.js + test/eventStream/fhirPdfEventStream.test.js | covered |
| [290](https://github.com/dcmjs-org/dcmjs/issues/290) | Reading a big sized DICOM: RangeError: Offset is outside the bounds of the DataView | closed | reader | 1 GB+ reads: streaming path is the answer; cite fromPart10Stream large-file tests + bounded-memory design | existing: test/eventStream/fromPart10Stream.test.js (chunked bounded-memory parse; 21.8 GB verified live in the video arc) | covered |
| [300](https://github.com/dcmjs-org/dcmjs/issues/300) |  Offset is outside the bounds of the DataView | open | reader | Encapsulated PDF ELE read covered by encapsulatedPdf round-trip suite (cite) | existing: test/encapsulatedPdf.test.js (Encapsulated PDF ELE round trip) | covered |
| [326](https://github.com/dcmjs-org/dcmjs/issues/326) | Reading malformed DICOM file causes infinite loop | closed | reader | missing meta group length: no infinite loop (no-meta-length-test.dcm fixture; cite hardening test) | existing: test/data.test.js:949,975 (no-meta-length-test.dcm) + fromPart10Stream K2 no-meta-length gate | covered |
| [375](https://github.com/dcmjs-org/dcmjs/issues/375) | Write issue for JPEG2000Loseless images | open | writer | encapsulated (J2K) edit->write covered by lossless read-write suite (cite; else A) | existing: test/lossless-read-write.test.js (encapsulated edit→write round trips) | covered |
| [377](https://github.com/dcmjs-org/dcmjs/issues/377) | Change in PixelSequence value | open | writer | fragment structure preserved on no-edit rewrite (byte-faithful 1.0 write; cite lossless suite) | existing: test/lossless-read-write.test.js (fragment-structure-preserving passthrough write) | covered |
| [378](https://github.com/dcmjs-org/dcmjs/issues/378) | Support for reading from a readable stream | open | stream | readable-stream reading IS 1.0's fromPart10Stream (cite suite + bounded-memory tests) | existing: test/eventStream/fromPart10Stream.test.js (ReadableStream/AsyncIterable sources) | covered |
| [434](https://github.com/dcmjs-org/dcmjs/issues/434) | TrackingIdentifier constructor calls super(options) and injects raw options into the ContentSequence | closed | sr-seg | TrackingIdentifier super(options) regression — test/TrackingIdentifier.test.js | existing: test/TrackingIdentifier.test.js | covered |
| [500](https://github.com/dcmjs-org/dcmjs/issues/500) | Add AsyncDicomWriter to allow writing DICOM files | open | stream | AsyncDicomWriter ask is met by StreamingPart10Writer + event sources (cite suite) | existing: test/eventStream/StreamingPart10Writer.test.js (+ event sources = the requested writer) | covered |

### D — wave 2 (adapters / SR / SEG) (30)

| # | Title | State | Area | Disposition | Test | Status |
|---|---|---|---|---|---|---|
| [2](https://github.com/dcmjs-org/dcmjs/issues/2) | Labeling output as research | closed | sr-seg | derived SEG should default ContentQualification RESEARCH — assert on Segmentation derivation output |  | triaged |
| [4](https://github.com/dcmjs-org/dcmjs/issues/4) | Inconsistencies in referenced instances | open | sr-seg | SEG referenced-instance consistency between shared and per-frame sequences |  | triaged |
| [5](https://github.com/dcmjs-org/dcmjs/issues/5) | DerivationCodeSequence not populated correctly | closed | sr-seg | DerivationCodeSequence CodeMeaning correctness in derivations |  | triaged |
| [11](https://github.com/dcmjs-org/dcmjs/issues/11) | bad display for bit packed seg with odd dimensions | closed | sr-seg | bit-packed SEG with odd dimensions displays wrong — needs SEG fixture |  | triaged |
| [12](https://github.com/dcmjs-org/dcmjs/issues/12) | Change SR procedure reported form 99 code to generic standard code | open | sr-seg | SR procedure-reported code default should be standard code, not 99-prefixed |  | triaged |
| [26](https://github.com/dcmjs-org/dcmjs/issues/26) | Segmentation derivation, add/remove Segments. | closed | sr-seg | Segmentation addSegment/removeSegment implemented and consistent |  | triaged |
| [29](https://github.com/dcmjs-org/dcmjs/issues/29) | Slice Thickness Field is absent in created SEGs. | closed | sr-seg | derived SEG must carry SliceThickness when FrameOfReferenceUID present (type 1C) |  | triaged |
| [30](https://github.com/dcmjs-org/dcmjs/issues/30) | Referenced Series Sequence is missing required fields | closed | sr-seg | derived SEG ReferencedSeriesSequence must include StudyInstanceUID + ReferencedInstanceSequence |  | triaged |
| [34](https://github.com/dcmjs-org/dcmjs/issues/34) | Linear measurements SR has duplicate image reference entries | open | sr-seg | SR: duplicate image reference entries in evidence + image library for multiple measurements |  | triaged |
| [38](https://github.com/dcmjs-org/dcmjs/issues/38) | Spacing Between Slices is equating to zero in the normalizer implementation. | closed | normalizer | SpacingBetweenSlices dot-product = 0 in normalizer multiframe construction |  | triaged |
| [54](https://github.com/dcmjs-org/dcmjs/issues/54) | create Segementation does not work for single frame images. | closed | sr-seg | Segmentation creation from single-frame source images |  | triaged |
| [66](https://github.com/dcmjs-org/dcmjs/issues/66) | PixelData for DICOMSEG is encoded incorrectly when frame length is not divisible by 8 for > 1 segment | closed | sr-seg | SEG bit-packing when frame length not divisible by 8 with >1 segment |  | triaged |
| [70](https://github.com/dcmjs-org/dcmjs/issues/70) | Normalization makes writing adapters fiddly for multi-volume series | open | normalizer | multi-volume series interspliced by position-sort in Normalizer |  | triaged |
| [77](https://github.com/dcmjs-org/dcmjs/issues/77) | Support for single frame segmentation  | open | normalizer | single-frame segmentation rejected by NormalizeMultiframe |  | triaged |
| [177](https://github.com/dcmjs-org/dcmjs/issues/177) | displaysegmentation example unable to parse segmentation | closed | sr-seg | Segmentation_4X getSegmentIndex undefined ReferencedSegmentNumber |  | triaged |
| [184](https://github.com/dcmjs-org/dcmjs/issues/184) | checkSEGsOverlapping throwing Uncaught RangeError for examples/displaySegmentation/index.html | closed | sr-seg | checkSEGsOverlapping RangeError |  | triaged |
| [192](https://github.com/dcmjs-org/dcmjs/issues/192) | Segmentation metadata inconsistent | open | sr-seg | labelmap metadata shape inconsistency (metadata vs metadata.data) |  | triaged |
| [193](https://github.com/dcmjs-org/dcmjs/issues/193) | Images are sorted in Normalizer, but Labelmap are not | closed | normalizer | Normalizer sorts images but labelmaps not re-ordered to match |  | triaged |
| [194](https://github.com/dcmjs-org/dcmjs/issues/194) | should overlay data also be encapsulated like pixel data depending on transfer syntax? | closed | writer | OverlayData under encapsulated transfer syntaxes: encapsulate or not (needs design decision) |  | triaged |
| [211](https://github.com/dcmjs-org/dcmjs/issues/211) | Cannot read property 'Rows' of undefined | closed | sr-seg | RLE SEG roundtrip via Cornerstone adapter |  | triaged |
| [232](https://github.com/dcmjs-org/dcmjs/issues/232) | Potentially incorrect assumption while parsing SEG | closed | sr-seg | SEG parsing assumes equal frames per segment |  | triaged |
| [255](https://github.com/dcmjs-org/dcmjs/issues/255) | adapters/Cornerstone/Segmentation: generateToolState sets incorrect segmentsOnFrame for 4D Volumes (worked correctly in previous versions!) | closed | sr-seg | generateToolState segmentsOnFrame wrong for 4D volumes |  | triaged |
| [272](https://github.com/dcmjs-org/dcmjs/issues/272) | Cannot read properties of undefined (reading 'forEach') | closed | sr-seg | TID300 Polyline handles missing points input with corrective error |  | triaged |
| [302](https://github.com/dcmjs-org/dcmjs/issues/302) | JS exception while saving report | closed | sr-seg | adapter throws on missing cachedStats |  | triaged |
| [306](https://github.com/dcmjs-org/dcmjs/issues/306) | [Cornerstone adapters] Tool is undefined when saving FreehandRoi tool in structured report | closed | sr-seg | FreehandRoi tool undefined in MeasurementReport |  | triaged |
| [339](https://github.com/dcmjs-org/dcmjs/issues/339) | use SegmentNumber from the segment metadata exporting DICOM SEG. | closed | sr-seg | SEG export should honor provided SegmentNumber |  | triaged |
| [358](https://github.com/dcmjs-org/dcmjs/issues/358) | Segmentation loading with wadors not working | closed | sr-seg | SEG wadors metadata provider regression |  | triaged |
| [380](https://github.com/dcmjs-org/dcmjs/issues/380) | Test failing due to missing image referenced by seg | open | sr-seg | adapter test needs valid referenced image |  | triaged |
| [439](https://github.com/dcmjs-org/dcmjs/issues/439) | dcmjs don't have option to add mean values for annotations for SR generation | open | sr-seg | TID300 mean/stdev metrics for annotations |  | triaged |
| [459](https://github.com/dcmjs-org/dcmjs/issues/459) | [Feature Request] Save additional metrics to SR report for all annotations | open | sr-seg | additional metrics in SR annotations |  | triaged |

### E — not testable (docs / CI / demos / questions) (57)

| # | Title | State | Area | Disposition | Test | Status |
|---|---|---|---|---|---|---|
| [1](https://github.com/dcmjs-org/dcmjs/issues/1) | License and home | closed | infra | license/org housekeeping |  | n/a |
| [9](https://github.com/dcmjs-org/dcmjs/issues/9) | Demo example does not work with a non-square image | open | infra | demo-site issue |  | n/a |
| [15](https://github.com/dcmjs-org/dcmjs/issues/15) | Example of anonymising a dicom | closed | docs | how-to: anonymizer example (capability exists; anonymizer.test.js) |  | n/a |
| [19](https://github.com/dcmjs-org/dcmjs/issues/19) | code needs to be refactored | open | infra | refactor wishlist |  | n/a |
| [28](https://github.com/dcmjs-org/dcmjs/issues/28) | Cant require from nodejs, window is not defined | closed | infra | ancient packaging (window undefined) — whole suite runs on node today |  | n/a |
| [32](https://github.com/dcmjs-org/dcmjs/issues/32) | "QIICR segmentation data" example is no longer working | closed | infra | example broken |  | n/a |
| [40](https://github.com/dcmjs-org/dcmjs/issues/40) | DICOM SEG IO is still quite rudimentary. | closed | sr-seg | meta-TODO list, no single testable claim |  | n/a |
| [64](https://github.com/dcmjs-org/dcmjs/issues/64) | modifying dicom tags | closed | docs | how-to: modify tags |  | n/a |
| [69](https://github.com/dcmjs-org/dcmjs/issues/69) | [Question] Is dcmjs production ready? | closed | docs | question: production readiness |  | n/a |
| [76](https://github.com/dcmjs-org/dcmjs/issues/76) | JPEG (STR Base64) to DICOM object | closed | docs | question: base64 JPEG to DICOM (capability now exists via fromImage) |  | n/a |
| [85](https://github.com/dcmjs-org/dcmjs/issues/85) | Convert jpeg file ( .jpeg ) to dicom file ( .dcm ) | closed | docs | how-to: jpeg to dcm (fromImage covers) |  | n/a |
| [89](https://github.com/dcmjs-org/dcmjs/issues/89) | Insert DICOM Tag | closed | docs | how-to: upsert + 'tag description' (not a DICOM element) |  | n/a |
| [100](https://github.com/dcmjs-org/dcmjs/issues/100) | Release cycle/notes | closed | infra | release process |  | n/a |
| [108](https://github.com/dcmjs-org/dcmjs/issues/108) | Typo in Package module name (dcmje) | closed | infra | package.json typo |  | n/a |
| [109](https://github.com/dcmjs-org/dcmjs/issues/109) | We need a default export | closed | infra | default export exists (any import proves it) |  | n/a |
| [113](https://github.com/dcmjs-org/dcmjs/issues/113) | STOW-RS is not encoding the "Content-Type" according to standard | open | infra | STOW Content-Type — legacy DICOMWEB class removed in 1.0 |  | n/a |
| [120](https://github.com/dcmjs-org/dcmjs/issues/120) | json test failing | open | infra | ancient test harness failure |  | n/a |
| [131](https://github.com/dcmjs-org/dcmjs/issues/131) | Should I add ArrowAnnotate into index.js? | closed | sr-seg | question: ArrowAnnotate readiness |  | n/a |
| [137](https://github.com/dcmjs-org/dcmjs/issues/137) | Implement Adapter of Cornerstone Rectangle Annotation  | closed | sr-seg | how-to: implement adapter |  | n/a |
| [141](https://github.com/dcmjs-org/dcmjs/issues/141) | Does dcmjs support the modification of DICOM file tags?  And ,Is there any more detailed documentation about dcmjs? | open | docs | question |  | n/a |
| [143](https://github.com/dcmjs-org/dcmjs/issues/143) | Need Some Clue for Implement Adapter of Cornerstone Rectangle Annotation | open | sr-seg | how-to: TID300 rectangle |  | n/a |
| [144](https://github.com/dcmjs-org/dcmjs/issues/144) | _image.data is undefined | open | sr-seg | example environment issue |  | n/a |
| [157](https://github.com/dcmjs-org/dcmjs/issues/157) | inPlane undefined | open | sr-seg | dead variable in Segmentation_4X (lint-level) |  | n/a |
| [158](https://github.com/dcmjs-org/dcmjs/issues/158) | writeBytes using encapsulated files with lots of frames crashes the browser | closed | writer | duplicate of #159 |  | n/a |
| [163](https://github.com/dcmjs-org/dcmjs/issues/163) | JSDoc and typescript declaration file (*.d.ts) | open | infra | typescript declarations request |  | n/a |
| [169](https://github.com/dcmjs-org/dcmjs/issues/169) | [Question] DICOM Pixel data manipulation | open | docs | question: pixel manipulation |  | n/a |
| [170](https://github.com/dcmjs-org/dcmjs/issues/170) | "require is not defined" issue in the browser | closed | infra | bundling require() leak |  | n/a |
| [206](https://github.com/dcmjs-org/dcmjs/issues/206) | Post Studies | open | infra | STOW usage question |  | n/a |
| [213](https://github.com/dcmjs-org/dcmjs/issues/213) | am I missing something ? | closed | docs | question |  | n/a |
| [214](https://github.com/dcmjs-org/dcmjs/issues/214) | Convert DICOS/DCM file to Png | closed | docs | question: DICOM->PNG (rendering out of scope) |  | n/a |
| [226](https://github.com/dcmjs-org/dcmjs/issues/226) | API documentation | open | docs | API documentation request |  | n/a |
| [227](https://github.com/dcmjs-org/dcmjs/issues/227) | broken displaysegmentation example | open | infra | demo broken |  | n/a |
| [238](https://github.com/dcmjs-org/dcmjs/issues/238) | Dependency issues for babel/polyfill | open | infra | babel/polyfill dependency |  | n/a |
| [248](https://github.com/dcmjs-org/dcmjs/issues/248) | Bug Dose Report | open | sr-seg | link-only OHIF dose report, no reproducer |  | n/a |
| [249](https://github.com/dcmjs-org/dcmjs/issues/249) | structured report for measurements with google healthcare API | closed | docs | usage question (SR + GCP) |  | n/a |
| [250](https://github.com/dcmjs-org/dcmjs/issues/250) | Export image as DICOM file  | closed | docs | usage question |  | n/a |
| [252](https://github.com/dcmjs-org/dcmjs/issues/252) | storing pixel data locally | closed | docs | usage question |  | n/a |
| [259](https://github.com/dcmjs-org/dcmjs/issues/259) | Add coverage and wire it to deploy preview configuration | open | infra | coverage CI |  | n/a |
| [262](https://github.com/dcmjs-org/dcmjs/issues/262) | Need to disable circleci now that we use github actions | closed | infra | CI |  | n/a |
| [265](https://github.com/dcmjs-org/dcmjs/issues/265) | CI Issues. | closed | infra | CI |  | n/a |
| [286](https://github.com/dcmjs-org/dcmjs/issues/286) | Integration with cornerstoneWADOloader | closed | docs | integration question (encapsulation detection) |  | n/a |
| [289](https://github.com/dcmjs-org/dcmjs/issues/289) | move "eslint-config-prettier" to devDependencies | open | infra | devDependencies |  | n/a |
| [319](https://github.com/dcmjs-org/dcmjs/issues/319) | Crash due to no TextEncoder on nodejs | open | infra | TextEncoder on old node (node>=22 baseline) |  | n/a |
| [333](https://github.com/dcmjs-org/dcmjs/issues/333) | [mutiple Qs]: convert .jpg to .dcm, no dicom header, could't not find declaration module ''dcmjs",... | closed | docs | multiple questions |  | n/a |
| [361](https://github.com/dcmjs-org/dcmjs/issues/361) | dcmjs-imaging | open | docs | dcmjs-imaging question |  | n/a |
| [370](https://github.com/dcmjs-org/dcmjs/issues/370) | modifying dicom meta-data | open | reader | duplicate of #311 Buffer footgun |  | n/a |
| [376](https://github.com/dcmjs-org/dcmjs/issues/376) | Issue with pixel redaction for JPEGLoseless type | open | docs | pixel redaction on compressed data (user must decode first; note) |  | n/a |
| [387](https://github.com/dcmjs-org/dcmjs/issues/387) | Can use to load dicom segment? | closed | docs | question |  | n/a |
| [389](https://github.com/dcmjs-org/dcmjs/issues/389) | Netlify-deployed docs site (https://dcmjs.netlify.com/) is down | open | infra | docs site down |  | n/a |
| [411](https://github.com/dcmjs-org/dcmjs/issues/411) | TypeError: log.create is not a function | closed | infra | loglevel packaging |  | n/a |
| [416](https://github.com/dcmjs-org/dcmjs/issues/416) | XMLHttpRequest is not defined (Should Import xhr2) | closed | infra | XHR in node (legacy DICOMWEB removed) |  | n/a |
| [423](https://github.com/dcmjs-org/dcmjs/issues/423) | Release version 1.0 with API updates | open | infra | the 1.0 release plan itself |  | n/a |
| [430](https://github.com/dcmjs-org/dcmjs/issues/430) | Can I use this project to perform de-identification of DICOM files? | closed | docs | capability question (de-identification) |  | n/a |
| [431](https://github.com/dcmjs-org/dcmjs/issues/431) | Broken Demo | open | infra | demo data moved |  | n/a |
| [440](https://github.com/dcmjs-org/dcmjs/issues/440) | Request: Better Documentation for Writing DICOM Files | open | docs | documentation request |  | n/a |
| [465](https://github.com/dcmjs-org/dcmjs/issues/465) | The automated release is failing 🚨 | closed | infra | semantic-release failure |  | n/a |
| [480](https://github.com/dcmjs-org/dcmjs/issues/480) | Refactor of ValueRepresentation. | open | values | refactor request — this arc's VR tests are the prerequisite it asks for |  | n/a |

<!-- TRIAGE-TABLE-END -->
