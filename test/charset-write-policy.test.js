import fs from "fs";
import path from "path";

import dcmjs from "../src/index.js";
import { log } from "../src/log.js";

const { DicomDict, DicomMessage, DicomMetaDictionary } = dcmjs.data;

const FIXTURE_DIR = path.join(__dirname, "fixtures", "charsets");

function fixtureBuffer(name) {
    const bytes = fs.readFileSync(path.join(FIXTURE_DIR, name));
    return bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength
    );
}

const naturalize = dict => DicomMetaDictionary.naturalizeDataset(dict);

/**
 * Builds a minimal Part 10 file through the public API so a subsequent
 * readFile yields eager entries with `_rawValue` populated (including the
 * original (0008,0005) terms). Identities are neutral JANE DOE samples.
 */
function buildFile({ charset, patientName, institution }) {
    const dicomDict = new DicomDict({});
    dicomDict.upsertTag("00080005", "CS", [charset]);
    dicomDict.upsertTag("00080016", "UI", ["1.2.840.10008.5.1.4.1.1.7"]);
    dicomDict.upsertTag("00080018", "UI", ["1.2.826.0.1.3680043.8.498.77.1"]);
    dicomDict.upsertTag("00080080", "LO", [institution]);
    dicomDict.upsertTag("00100010", "PN", [patientName]);
    // Author the legacy declaration deliberately: the default write policy
    // (correctly) normalizes (0008,0005) to ISO_IR 192, so fixture files
    // that must DECLARE a legacy charset are written in preserve mode —
    // their values are pure ASCII, so the policy vetting passes.
    return dicomDict.write({ preserveSpecificCharacterSet: true });
}

// Decoded values of the committed ISO 2022 IR 159 fixture, mirroring
// test/fixtures/charsets/make-fixtures.mjs (JIS X 0212 GL pairs).
const JISX0212_PN = "DOE^JANE=丂阢";

describe("charset write policy — default (transcode to UTF-8)", () => {
    it("round-trip still rewrites (0008,0005) to ISO_IR 192 and re-encodes text", () => {
        const dicomDict = DicomMessage.readFile(
            fixtureBuffer("jisx0212-ir159.dcm")
        );
        const roundTripped = DicomMessage.readFile(dicomDict.write());
        const dataset = naturalize(roundTripped.dict);
        expect(dataset.SpecificCharacterSet).toBe("ISO_IR 192");
        expect(String(dataset.PatientName)).toBe(JISX0212_PN);
        // The written element really carries ISO_IR 192 (the re-read
        // rewrite site would mask a stale value; _rawValue shows the terms
        // as present in the written bytes).
        expect(roundTripped.dict["00080005"]._rawValue).toEqual(["ISO_IR 192"]);
    });
});

describe("charset write policy — preserveSpecificCharacterSet", () => {
    it("keeps a declared latin1 charset when every affected value is pure ASCII", () => {
        const buffer = buildFile({
            charset: "ISO_IR 100",
            patientName: "DOE^JANE",
            institution: "ACME HOSPITAL"
        });
        const dicomDict = DicomMessage.readFile(buffer);
        // Reader rewrote the stored Value but retained the original terms.
        expect(dicomDict.dict["00080005"].Value).toEqual(["ISO_IR 192"]);
        expect(dicomDict.dict["00080005"]._rawValue).toEqual(["ISO_IR 100"]);

        const out = dicomDict.write({ preserveSpecificCharacterSet: true });
        const reRead = DicomMessage.readFile(out);
        expect(reRead.dict["00080005"]._rawValue).toEqual(["ISO_IR 100"]);
        const dataset = naturalize(reRead.dict);
        expect(String(dataset.PatientName)).toBe("DOE^JANE");
        expect(dataset.InstitutionName).toBe("ACME HOSPITAL");
    });

    it("keeps ISO_IR 192 with non-ASCII values (UTF-8 original is byte-representable)", () => {
        const buffer = buildFile({
            charset: "ISO_IR 192",
            patientName: "DOE^JÁNE",
            institution: "HÔPITAL ŒUVRE"
        });
        const dicomDict = DicomMessage.readFile(buffer);
        const out = dicomDict.write({ preserveSpecificCharacterSet: true });
        const reRead = DicomMessage.readFile(out);
        expect(reRead.dict["00080005"]._rawValue).toEqual(["ISO_IR 192"]);
        const dataset = naturalize(reRead.dict);
        expect(String(dataset.PatientName)).toBe("DOE^JÁNE");
        expect(dataset.InstitutionName).toBe("HÔPITAL ŒUVRE");
    });

    it("strict mode throws a corrective error naming the first non-representable element", () => {
        const dicomDict = DicomMessage.readFile(
            fixtureBuffer("jisx0212-ir159.dcm")
        );
        // First offender in sorted tag order is the LO institution
        // (00080080), before the PN (00100010).
        expect(() =>
            dicomDict.write({ preserveSpecificCharacterSet: true })
        ).toThrow(/00080080/);
        expect(() =>
            dicomDict.write({ preserveSpecificCharacterSet: true })
        ).toThrow(/lenient/);
    });

    it("lenient mode warns and falls back to UTF-8 + ISO_IR 192; output parses", () => {
        const warnSpy = jest.spyOn(log, "warn").mockImplementation(() => {});
        try {
            const dicomDict = DicomMessage.readFile(
                fixtureBuffer("jisx0212-ir159.dcm")
            );
            const out = dicomDict.write({
                preserveSpecificCharacterSet: "lenient"
            });
            expect(warnSpy).toHaveBeenCalledWith(
                expect.stringContaining("falling back to UTF-8")
            );
            const reRead = DicomMessage.readFile(out);
            expect(reRead.dict["00080005"]._rawValue).toEqual(["ISO_IR 192"]);
            const dataset = naturalize(reRead.dict);
            expect(String(dataset.PatientName)).toBe(JISX0212_PN);
        } finally {
            warnSpy.mockRestore();
        }
    });
});
