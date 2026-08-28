/**
 * Issue-derived regression tests — ISO 2022 code-extension character sets
 * (multi-valued SpecificCharacterSet, escape-sequence switching).
 *
 * Upstream issues (all category B — network fixture):
 * - https://github.com/dcmjs-org/dcmjs/issues/373
 *   Symptom: readFile throws `Using multiple character sets is not
 *   supported: ,ISO 2022 IR 149` on any file whose (0008,0005) is
 *   multi-valued (e.g. "\ISO 2022 IR 149"), even though PS3.3 C.12.1.1.2
 *   explicitly allows multiple values when code extensions are used.
 * - https://github.com/dcmjs-org/dcmjs/issues/284
 *   Symptom: Korean datasets (ISO 2022 IR 149 / KS X 1001 via EUC-KR
 *   G1 designation) decode to mojibake like "Çã³²µµ" instead of hangul;
 *   pydicom reads the same files fine.
 * - https://github.com/dcmjs-org/dcmjs/issues/454
 *   Symptom: SR content that switches encodings mid-dataset via ISO 2022
 *   escape sequences renders with "Â " artifacts — the escape bytes are
 *   not interpreted, the text is decoded with a single fixed decoder.
 * - https://github.com/dcmjs-org/dcmjs/issues/484
 *   Symptom (follow-up to #454/#455): node-level charset handling must
 *   not clobber the global decoder; the ask is scoped, per-fragment
 *   ISO 2022 escape-aware transcoding.
 *
 * Fixture: the dclunie charset corpus, cached by test/data-encoding.test.js:
 *   https://github.com/dcmjs-org/data/releases/download/dclunie-charsets/dclunie-charsets.zip
 * unpacked to $TMPDIR/dcmjs-test/dclunie-charsets/charsettests/. Run with
 * DCMJS_NETWORK_TESTS=1 (or any prior run of data-encoding.test.js) to
 * populate the cache; the gated tests skip when it is absent.
 *
 * Existing coverage note: test/data-encoding.test.js already pins the
 * single-charset corpus files (SCSARAB/FREN/GERM/GREEK/HBRW/RUSS/X1/X2)
 * including the write→re-read-as-UTF-8 round trip, and explicitly lists
 * SCSH31/SCSH32/SCSI2 as unsupported ("multiple encodings"). This file
 * covers exactly that missing angle: the multi-valued (0008,0005) and
 * ISO 2022 escape-switching files.
 *
 * validationLog silenced: the lenient-mode tests deliberately push
 * unsupported charsets through the parser.
 */

import fs from "fs";
import os from "os";
import path from "path";
import dcmjs from "../../src/index.js";
import { validationLog } from "../../src/log.js";
import { itIfNetworkFixture } from "../testUtils.js";

validationLog.setLevel(5);

const { DicomMessage, DicomMetaDictionary } = dcmjs.data;
const { DicomEventStream } = dcmjs.eventStream;

const CORPUS_DIR = path.join(
    os.tmpdir(),
    "dcmjs-test",
    "dclunie-charsets",
    "charsettests"
);

function readCorpusFile(name) {
    return fs.readFileSync(path.join(CORPUS_DIR, name)).buffer;
}

function naturalizeLenient(name) {
    const dicomDict = DicomMessage.readFile(readCorpusFile(name), {
        ignoreErrors: true
    });
    return DicomMetaDictionary.naturalizeDataset(dicomDict.dict);
}

// Reference PatientName values from David Clunie's charset test corpus
// (verified against pydicom/DCMTK output for the same files).
const SCSI2_PN = "Hong^Gildong=洪^吉洞=홍^길동"; // "\ISO 2022 IR 149"
const SCSH31_PN = "Yamada^Tarou=山田^太郎=やまだ^たろう"; // "\ISO 2022 IR 87"
const SCSH32_PN = "ﾔﾏﾀﾞ^ﾀﾛｳ=山田^太郎=やまだ^たろう"; // "ISO 2022 IR 13\ISO 2022 IR 87"

describe("issue #373 — multi-valued SpecificCharacterSet must parse", () => {
    // KNOWN GAP: observed `Error: Using multiple character sets is not
    // supported: ,ISO 2022 IR 149` from DicomMessage.readFile (strict) on
    // SCSI2, whose (0008,0005) is the standard-conformant "\ISO 2022 IR
    // 149"; expected the file to parse without throwing — PS3.3
    // C.12.1.1.2 requires supporting multiple values when code extensions
    // are in use.
    it.skip("KNOWN GAP #373: strict readFile throws 'multiple character sets not supported' on \\ISO 2022 IR 149", () => {
        expect(() =>
            DicomMessage.readFile(readCorpusFile("SCSI2"))
        ).not.toThrow();
    });

    itIfNetworkFixture("dclunie-charsets")(
        "eager and event-stream paths converge on the same multiple-charset rejection (no path divergence)",
        async () => {
            const buffer = readCorpusFile("SCSI2");
            expect(() => DicomMessage.readFile(buffer)).toThrow(
                /multiple character sets/
            );
            await expect(
                DicomEventStream.fromPart10(buffer).toNaturalized()
            ).rejects.toThrow(/multiple character sets/);
        }
    );

    itIfNetworkFixture("dclunie-charsets")(
        "lenient readFile (ignoreErrors) degrades without crashing and keeps the ASCII PN component",
        () => {
            const dataset = naturalizeLenient("SCSI2");
            expect(String(dataset.PatientName)).toMatch(/^Hong\^Gildong=/);
            const dataset31 = naturalizeLenient("SCSH31");
            expect(String(dataset31.PatientName)).toMatch(/^Yamada\^Tarou=/);
        }
    );
});

describe("issue #284 — Korean (ISO 2022 IR 149) must decode to hangul", () => {
    // KNOWN GAP: observed (with ignoreErrors) PatientName
    // "Hong^Gildong=ESC$)Cûó^ESC$)CÑÎÔ×=…" — the ISO 2022 escape
    // sequences designating KS X 1001 are left in the value and the
    // EUC-KR bytes are decoded as latin1 mojibake (the reporter's
    // "Çã³²µµ" class of corruption); expected the pydicom-equivalent
    // decode "Hong^Gildong=洪^吉洞=홍^길동".
    it.skip("KNOWN GAP #284: SCSI2 PatientName decodes to latin1 mojibake instead of hangul", () => {
        const dataset = naturalizeLenient("SCSI2");
        expect(String(dataset.PatientName)).toBe(SCSI2_PN);
    });
});

describe("issues #454/#484 — ISO 2022 escape switching inside string values", () => {
    // KNOWN GAP: observed (with ignoreErrors) PatientName
    // "Yamada^Tarou=ESC$B;3EDESC(B^…" — the raw ESC sequences that
    // switch G0 to JIS X 0208 and back survive into the decoded string
    // and the kanji/kana bytes are decoded with the single active
    // decoder, producing exactly the "Â"-artifact class of corruption
    // reported for SR Findings nodes; expected escape-aware decoding
    // "Yamada^Tarou=山田^太郎=やまだ^たろう". #484's ask — switch the
    // decoder per escape scope without clobbering the dataset-global
    // decoder — is the fix shape for this and the SCSH32 case.
    it.skip("KNOWN GAP #454: SCSH31 (\\ISO 2022 IR 87) escape-switched PN not decoded (raw ESC bytes leak)", () => {
        const dataset = naturalizeLenient("SCSH31");
        expect(String(dataset.PatientName)).toBe(SCSH31_PN);
    });

    // KNOWN GAP: observed "ﾔﾏﾀﾞ^ﾀﾛｳ=ESC$B;3EDESC(J^…" — the first
    // component (JIS X 0201 katakana via ISO 2022 IR 13) happens to
    // survive, but every escape-switched JIS X 0208 segment keeps its ESC
    // bytes and mojibake; expected the full three-component name decoded.
    it.skip("KNOWN GAP #484: SCSH32 (ISO 2022 IR 13\\ISO 2022 IR 87) mixed-designation PN not decoded", () => {
        const dataset = naturalizeLenient("SCSH32");
        expect(String(dataset.PatientName)).toBe(SCSH32_PN);
    });

    itIfNetworkFixture("dclunie-charsets")(
        "lenient reads of the escape-switching files never emit replacement chars in the ASCII component",
        () => {
            for (const name of ["SCSH31", "SCSH32", "SCSI2"]) {
                const dataset = naturalizeLenient(name);
                const pn = String(dataset.PatientName);
                // The degraded value is stable and defined: it must not
                // corrupt the single-byte component before the first "=".
                expect(pn.split("=")[0]).not.toMatch(/�/);
                expect(dataset.SOPInstanceUID).toEqual(expect.any(String));
            }
        }
    );
});
