<div align="center">
  <h1>dcmjs</h1>
  <p>JavaScript implementation of DICOM manipulation. This code is an outgrowth of several efforts to implement web applications for medical imaging.  the package should also work fine on node.</p>
</div>

<hr />

[![CI](https://github.com/dcmjs-org/dcmjs/actions/workflows/publish-package.yml/badge.svg)](https://github.com/dcmjs-org/dcmjs/actions?query=workflow:publish-package)

**Note: master is the 1.0.0-beta line — a major architecture release (not yet published to npm).**

This is a community effort so please help improve support for a wide range of DICOM data and use cases.

See [live examples here](https://master--dcmjs2.netlify.app/)

# What changed in 1.0

dcmjs 1.0 absorbs the dicom-parser tokenizer as its read core and is now a pnpm monorepo:

- **Lazy reading by default.** `DicomMessage.readFile` records element offsets and
  materializes values on first access. Set `DCMJS_CORE=eager` (or
  `readFile(buffer, { core: "eager" })`) to restore the 0.x reader during the beta.
- **Byte-faithful writing.** Untouched elements are written back as verbatim source
  bytes; a no-edit read-write round trip reproduces the body byte for byte. Deflate
  transfer syntax is now actually written deflated (a long-standing 0.x bug).
- **Monorepo.** The vendored tokenizer lives in `packages/parser` (private), the
  documentation site in `packages/docs`, and the main `dcmjs` package at the root.
- **Removed:** the deprecated `DicomMessage.read`/`readTag` statics and the legacy
  `DICOMWEB` class (use [dicomweb-client](https://github.com/dcmjs-org/dicomweb-client)).

Full details: the documentation site under `packages/docs` (run
`pnpm --filter @dcmjs/docs start`), the migration guide at
`packages/docs/docs/migration/from-0x.md`, and the step-by-step roadmap at
`packages/docs/docs/development/roadmap.md`.

# What's new on this fork (development branch)

This fork ([awatson1978/dcmjs](https://github.com/awatson1978/dcmjs)) adds
forward-migration primitives for legacy DICOM, arriving via PRs #52–#54.
The consuming CLI/MCP tooling lives in the sibling
[dcmjs-commands](https://github.com/awatson1978/dcmjs-commands) (see its
`architecture-design.md` for the layering and roadmap).

**`dcmjs.image` — instances from decoded pixels** (`DicomEventStream.fromImage`,
`buildImageDataset`). Codec-free: callers decode (Canvas in the browser,
pngjs in node) and hand over pixels + geometry; the library owns the
conformance rules — actual geometry always beats metadata claims, and when
the metadata identifies an original instance the result is a proper derived
instance (fresh SOPInstanceUID, `DERIVED\SECONDARY`, SourceImageSequence —
original UIDs are never reused for rebuilt pixel data).

```js
const events = DicomEventStream.fromImage(
    { pixels, rows: 256, columns: 256, bitsStored: 12 },
    { metadata: dicomWebJson, PatientName: "FOX^JANE" }
);
const part10 = await events.toPart10();
```

**`dcmjs.media` — DICOMDIR builder** (`buildDicomDirDataset`, `writeDicomDir`).
Builds a valid Media Storage Directory from a file-set description,
including exact byte offsets in the directory records (measure-then-write:
offsets are fixed-width UL, so one measurement pass yields the final
layout and the file is written once).

**`@dcmjs/fhir` — now both directions.** The existing sink (naturalized
datasets → FHIR Patient / ImagingStudy / DocumentReference) is joined by a
source: `patientToDataset(patient)` maps a FHIR Patient onto DICOM
patient-module attributes — official name over maiden, MR-typed identifier
preferred, and a deliberately narrow administrative-gender table
(`male→M`, `female→F`, other/unrecognized→`O`, unknown/absent→empty;
`Patient.gender` only, never profile extensions). Deterministic overwrite:
all four attributes are always returned, empty for absent fields, so
applying a Patient replaces the whole module.

# Goals

_Overall the code should:_

- Support reading and writing of correct DICOM objects in JavaScript for browser or node environments
- Provide a programmer-friendly JavaScript environment for using and manipulating DICOM objects
- Include a set of useful demos to encourage correct usage of dcmjs and modern DICOM objects
- Encourage correct referencing of instances and composite context when creating derived objects
- Current target is modern web browsers, but a set of node-based utilities also makes sense someday

_Architectural goals include:_

- Use modern JavaScript programming methods (currently ES6) but avoid heavy frameworks
- Leverage modern DICOM standards but avoid legacy parts
- Support straightforward integration with multiple JavaScript deployment targets (browser, node, etc) and frameworks.

_Parts of DICOM that dcmjs *will* focus on:_

- Enhanced Multiframe Images
- Segmentation Objects
- Parametric Maps
- Structured Reports

_Parts of DICOM that dcmjs *will not* focus on:_

- DIMSE (legacy networking like C-STORE, C-FIND, C-MOVE, etc). See the [dcmjs-dimse](https://github.com/PantelisGeorgiadis/dcmjs-dimse) project for that.
- Physical Media (optical disks). See [this FAQ](https://www.dclunie.com/medical-image-faq/html/index.html) if you need to work with those.
- Image rendering. See [dcmjs-imaging](https://github.com/PantelisGeorgiadis/dcmjs-imaging) for this.
- Encapsulated transfer syntax transcoding. See [dcmjs-codecs](https://github.com/PantelisGeorgiadis/dcmjs-codecs) for this.
- 3D rendering.  See [vtk.js](https://kitware.github.io/vtk-js/index.html).
- Radiology review application - see [OHIF](https://ohif.org).
- Deidentification and data organization - see [dcm-organize](https://github.com/bebbi/dcm-organize) for this.

# Usage

## In Browser

```html
<script type="text/javascript" src="https://unpkg.com/dcmjs"></script>
```

## In Node

Add **dcmjs** to your application (pnpm):

```bash
pnpm add dcmjs       # latest stable release
pnpm add dcmjs@dev   # latest code merged to master
```

The same versions can be installed with `npm install` or Yarn in **your** project; those clients are fine for consuming the published package. **Building this repository** is pnpm-only (see below).

## FHIR Sink (`dcmjs.fhir`)

The `@dcmjs/fhir` workspace package maps DICOM Part 10 elements into FHIR
R4B resources — deliberately simple: the DICOM patient module becomes a
`Patient`, the study/series/instance hierarchy becomes an `ImagingStudy`.
Standard FHIR only; resource ids, storage references, and `meta.tag`s are
the consumer's job.

```javascript
// One call from a .dcm ArrayBuffer to FHIR:
const { patient, imagingStudy } = dcmjs.fhir.fromPart10(arrayBuffer);

// Or from an already-naturalized dataset:
const dicomDict = dcmjs.data.DicomMessage.readFile(arrayBuffer);
const dataset = dcmjs.data.DicomMetaDictionary.naturalizeDataset(dicomDict.dict);
const { patient, imagingStudy } = dcmjs.fhir.toFhir(dataset);

// Many instances of one study -> a collection Bundle
// (one Patient + one aggregated ImagingStudy, instances grouped by series):
const bundle = dcmjs.fhir.toBundle([dataset1, dataset2, dataset3]);

// Attach a subject reference the caller resolved:
dcmjs.fhir.toFhir(dataset, {
    subject: { reference: "Patient/123", display: "Doe, John" }
});
```

API surface (all also importable from `@dcmjs/fhir` inside this repo):

| Function | Input | Output |
| --- | --- | --- |
| `fromPart10(arrayBuffer, options?)` | Part 10 ArrayBuffer | `{ patient, imagingStudy }` |
| `toFhir(dataset, options?)` | naturalized dataset | `{ patient, imagingStudy }` |
| `toBundle(datasets, options?)` | naturalized dataset array (one study) | FHIR `Bundle` (`type: collection`) |
| `patientFromDataset(dataset)` | naturalized dataset | FHIR `Patient` or `null` |
| `imagingStudyFromDataset(dataset, options?)` | naturalized dataset | FHIR `ImagingStudy` or `null` |
| `imagingStudyFromDatasets(datasets, options?)` | naturalized dataset array | one aggregated `ImagingStudy` or `null` |

Options: `fhirVersion` (`'R4'`/`'R4B'`, default `'R4B'` — anything else
throws), `subject` (FHIR Reference for `ImagingStudy.subject`),
`readOptions` (`fromPart10` only, passed to `DicomMessage.readFile`).

Mapping notes (per the IHE Radiology MADO mapping):

- `Patient`: `PatientID` -> MR identifier, `PatientName` (PN) -> `HumanName`,
  `PatientBirthDate` -> ISO `birthDate`, `PatientSex` -> `gender` plus
  US Core `birthsex` / `sex-for-clinical-use` extensions.
- `ImagingStudy`: `StudyInstanceUID` -> `urn:dicom:uid` identifier
  (`urn:oid:` value), `AccessionNumber` -> ACSN identifier,
  `StudyDate`/`Time` -> `started`, series `Modality` -> DCM ontology coding
  (with a study-level modality union), `SeriesNumber`/`InstanceNumber`
  (IS) emitted as numbers, `SOPClassUID` -> `urn:ietf:rfc:3986` sopClass.
- Absent elements are omitted entirely — no empty strings or nulls in the
  output (permissive in, strict out).

Tests: `pnpm exec jest packages/fhir`.

## Event Stream (`dcmjs.eventStream`)

A source-agnostic, SAX-style push parser. Sources emit a fixed vocabulary of
events (`startElement`, `value`, `startSequence`, `startItem`,
`bulkDataReference`, `binaryFragment`, …) to listeners/writers, with filter
middleware and backpressure — an alternative to the eager, in-place
`DicomMessage.readFile` reader that produces the same naturalized metadata by
streaming rather than materializing the whole dataset up front.

```javascript
// Part 10 bytes -> naturalized dataset, via the event stream.
// Equivalent to DicomMessage.readFile(...) + naturalizeDataset(...), streamed.
const dataset = await dcmjs.eventStream.DicomEventStream
    .fromPart10(arrayBuffer)
    .toNaturalized();

console.log(dataset.Modality, dataset.StudyInstanceUID, dataset.NumberOfFrames);
```

A `DicomEventStream` wraps a re-runnable source; choose a sink:

```javascript
const events = dcmjs.eventStream.DicomEventStream.fromPart10(arrayBuffer);

const dataset = await events.toNaturalized();    // naturalized { ...keywords }
const json    = await events.toDicomWebJson();   // DICOM JSON model
const tree    = await events.toDataSet();         // { meta, dict } tag tree
const bytes   = await events.toPart10();          // round-trip back to Part 10
```

Other sources — the same sinks apply to each:

```javascript
const { DicomEventStream } = dcmjs.eventStream;

DicomEventStream.fromPart10Stream(chunksOrReadableStream); // chunked bytes, bounded memory
DicomEventStream.fromDataSet({ meta, dict });              // an already-parsed dataset
DicomEventStream.fromDicomWebJson(dicomJson);              // DICOM JSON model
DicomEventStream.from(source);                             // auto-detect the above
```

For element-level work (progress, filtering, validation) without materializing
the whole dataset, consume the events directly:

```javascript
for await (const { type, args } of
        dcmjs.eventStream.DicomEventStream.fromPart10(arrayBuffer).asyncIterable()) {
    // type: 'startElement' | 'value' | 'startSequence' | 'startItem' | ...
}

// …or drive a custom EventStreamListener subclass with events.process(listener).
```

## For Developers

Building and testing this repository requires **[pnpm](https://pnpm.io/)** and **Node.js 22.13 or newer** (pnpm 11 and this repo’s tooling expect that baseline; Rollup’s dependency chain expects a modern `crypto` global). CI runs tests on Node 22 and 24, and runs the production Rollup build on Node 24. The pnpm version is pinned under `packageManager` in `package.json`. Enable [Corepack](https://nodejs.org/api/corepack.html) (`corepack enable`) and use pnpm for every install and script:

```bash
corepack enable
git clone https://github.com/dcmjs-org/dcmjs
cd dcmjs
pnpm install
pnpm run build
pnpm test
```

Other common tasks:

```bash
pnpm run build:examples         # Rollup build + copy bundles into examples/js
pnpm run lint                   # ESLint (writes fixes)
pnpm run format                 # Prettier (writes)
pnpm run format:check           # Prettier (check only)
pnpm run bench:parser           # parse non-regression gate vs published dicom-parser
pnpm run gate:parser-bundle     # parser package self-containment gate
pnpm --filter @dcmjs/docs start # documentation site dev server (packages/docs)
pnpm --filter @dcmjs/docs build # documentation site production build
```

This repository is a pnpm workspace: the main `dcmjs` package lives at the root,
the vendored read tokenizer at `packages/parser` (private, with its own jest
suite), and the Docusaurus documentation site at `packages/docs`.

**Yarn is no longer supported** for working in this repo: there is no `yarn.lock`, and installs, builds, and CI are aligned with `pnpm-lock.yaml` only. Use pnpm so dependency resolution matches lockfile and automation.

After changing dependencies in `package.json`, refresh the lockfile with `pnpm run install:update-lockfile` (or `pnpm install --no-frozen-lockfile`) before opening a PR.

## For Maintainers and Contributors

Publish new version automatically from commit:

Use the following "Commit Message Format" when drafting commit messages. If you're merging a 3rd party's PR, you have the ability to override the supplied commit messages by doing a "Squash & Merge":

- [Commit Message Format](https://semantic-release.gitbook.io/semantic-release/#commit-message-format)

Note: Be wary of `BREAKING_CHANGE` in commit message descriptions, as this can force a major version bump.

Be sure to use lower case for the first letter of your semantic commit message, so use `fix` not `Fix` or `feat` not `Feat`, have a space after the : and make the PR github review title follow the SAME rules.  It is the PR review title that determins the final commit message and will be used for semantic detection.

Note: a new package version will be published only if the commit comes from a PR.

### Optional Tooling

It is advised to use the git-cz, i.e.:

- install git-cz

```bash
pnpm add -g git-cz
# or: npm install -g git-cz
```

- how to commit

```
git-cz --non-interactive --type=fix --subject="commit message"
```

More info at [git-cz](https://www.npmjs.com/package/git-cz).

## DICOM Dictionary

The dcmjs library includes DICOM data dictionaries that map DICOM tags to their metadata (VR, VM, etc.). To optimize load performance, the library uses a pre-compiled "fast dictionary" format.

### Dictionary Files

- **`src/dictionary.fast.js`** - Pre-compiled fast dictionary (used at runtime)
- **`generate/dictionary.mjs`** - Source dictionary generator
- **`src/dictionary.private.data.js`** - Private tag definitions
- Since 1.0, `DicomMetaDictionary.nameMap` is built lazily on first access instead of at import time

### Updating the Dictionary

When DICOM standards are updated or new tags need to be added:

1. **Generate the dictionary from DICOM standards** (downloads latest PS3.6 and PS3.7 XML from dicom.nema.org):
   ```bash
   pnpm run generate-dictionary
   ```
   This creates/updates `generate/dictionary.js` with the latest tag definitions.

2. **Pack the dictionary into optimized format**:
   ```bash
   pnpm run pack-dictionary
   ```
   This generates the optimized `src/dictionary.fast.js` used at runtime.

### Why the Fast Dictionary?

The fast dictionary was introduced to significantly improve library load performance. The original dictionary format required complex runtime processing during module initialization, which added substantial overhead, especially in applications that frequently import dcmjs.

**Performance Benchmark Results (Bun):**

```
Old dictionary (generate/dictionary.mjs): 181.16 ms
New dictionary (src/dictionary.fast.js):    19.04 ms
Performance improvement: 9.52x faster

ESM main (dcmjs.es.js):         112.01 ms
ESM private (loadPrivateTags):    0.01 ms
ESM total:                      112.01 ms

UMD (dcmjs.js):                  72.11 ms
```

The fast dictionary reduces initial load time by over 9x, making it especially beneficial for:
- Server-side applications that spawn multiple workers
- Build tools and bundlers
- Applications with frequent module reloading during development
- Environments where startup time is critical

## Community Participation

Use this repository's issues page to report any bugs. Please follow [SSCCE](http://sscce.org/) guidelines when submitting issues.

Use github pull requests to make contributions.

## Unit Tests

Tests are written using the [Jest](https://jestjs.io) testing framework and live in the `test/` folder. Test file names must end with `.test.js`.

Pull requests should either update existing tests or add new tests in order to ensure good test coverage of the changes being made.

To run all tests use `pnpm test`. To only run specific tests use Jest's [`.only`](https://www.testim.io/blog/unit-testing-best-practices/) feature. If you're using VS Code, an extension such as [`firsttris.vscode-jest-runner`](https://marketplace.visualstudio.com/items?itemName=firsttris.vscode-jest-runner) can be used to step through specific tests in the debugger.

Read all about unit testing best practices [here](https://www.testim.io/blog/unit-testing-best-practices/).

# Status

dcmjs is production-tested (OHIF, Cornerstone adapters, ~15k weekly npm downloads) and is currently in its 1.0 beta cycle.

## Implemented

- Lazy, offset-based Part 10 reading (default since 1.0) with an equivalence-gated eager fallback
- Byte-faithful Part 10 writing with passthrough of untouched elements, length backpatching, and deflate-on-write
- Bidirectional conversion to and from part 10 binary DICOM and DICOM standard JSON encoding (as in [DICOMweb](http://dicomweb.org))
- Bidirectional conversion to and from DICOM standard JSON and a programmer-friendly high-level version (the "naturalized" form)
- Creation of derived DICOM objects such as Segmentations and Structured Reports
- Packed data dictionary with lazy initialization, character set support, anonymization, streaming reader

## In development (1.x backlog)

- Re-platforming the streaming `AsyncDicomReader` onto the offset tokenizer
- Removing the legacy eager read path after the beta soak
- Public subpath packaging (raw parser tier, dictionary) and a TypeScript surface
- See the docs site roadmap page (`packages/docs/docs/development/roadmap.md`, R8 checklist) for the full list

# History

- 2014
  - [DCMTK](dcmtk.org) cross compiled to javascript at [CTK Hackfest](http://www.commontk.org/index.php/CTK-Hackfest-May-2014). While this was useful and powerful, it was heavyweight for typical web usage.
- 2016
  - A [Medical Imaging Web Appliction meeting at Stanford](http://qiicr.org/web/outreach/Medical-Imaging-Web-Apps/) and [follow-on hackfest in Boston](http://qiicr.org/web/outreach/MIWS-hackfest/) helped elaborate the needs for manipulating DICOM in pure Javascript.
  - Based on [DICOM Part 10 read/write code](https://github.com/OHIF/dicom-dimse) initiated by Weiwei Wu of [OHIF](http://ohif.org), Steve Pieper [developed further features](https://github.com/pieper/sites/tree/gh-pages/dcmio) and [examples of creating multiframe and segmentation objects](https://github.com/pieper/sites/tree/gh-pages/DICOMzero) discussed with the community at RSNA
- 2017
  - At [NA-MIC Project Week 25](https://na-mic.org/wiki/Project_Week_25) Erik Ziegler and Steve Pieper [worked](https://na-mic.org/wiki/Project_Week_25/DICOM_Segmentation_Support_for_Cornerstone_and_OHIF_Viewer)
    with the community to define some example use cases to mix the pure JavaScript DICOM code with Cornerstone and [CornerstoneTools](https://github.com/chafey/cornerstoneTools).
- 2018-2022
  - Work continues to develop SR and SEG support to [OHIFViewer](http://ohif.org) allow interoperability with [DICOM4QI](https://legacy.gitbook.com/book/qiicr/dicom4qi/details)
- 2022-present
  - dcmjs is used by a number of projects and as of January 2025 has about 15,000 weekly [downloads from npm]([url](https://www.npmjs.com/package/dcmjs)).

# Support

The developers gratefully acknowledge their research support:

- Open Health Imaging Foundation ([OHIF](http://ohif.org))
- Quantitative Image Informatics for Cancer Research ([QIICR](http://qiicr.org))
- [Radiomics](http://radiomics.io)
- The [Neuroimage Analysis Center](http://nac.spl.harvard.edu)
- The [National Center for Image Guided Therapy](http://ncigt.org)
- The [NCI Imaging Data Commons](https://imagingdatacommons.github.io/) NCI Imaging Data Commons: contract number 19X037Q from Leidos Biomedical Research under Task Order HHSN26100071 from NCI
- dcmjs is being used and partially supported by [dicom-curate](https://github.com/bebbi/dicom-curate)

## Logging

This library uses [loglevel](https://github.com/pimterry/loglevel) for logging through a named child logger (`loglevel.getLogger("dcmjs")`). Since 1.0, importing dcmjs no longer calls `setLevel` on the global loglevel root logger, so host application logging configuration is left untouched. The dcmjs logger defaults to "warn"; change it with the `LOG_LEVEL` environment variable or `loglevel.getLogger("dcmjs").setLevel(...)` in your code.
