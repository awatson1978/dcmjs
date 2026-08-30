/**
 * Charset completion suite (v2.0 Workstream C, tranche 1).
 *
 * Covers the last verified decode gaps:
 *  - ISO_IR 203 / ISO 2022 IR 203 (Latin-9, ISO 8859-15) incl. the
 *    ESC 02/13 06/02 ("ESC - b") G1 designation,
 *  - ISO 2022 IR 159 (JIS X 0212) real decode via euc-jp SS3 re-encoding
 *    (previously U+FFFD through the WHATWG iso-2022-jp decoder),
 *  - the bare nonstandard "GB2312" defined term (lenient alias of GBK),
 *  - Thai (ISO_IR 166), GB18030, and the multi-byte-set-as-value-1 edge,
 *  - the PN component-delimiter (^ / =) ISO 2022 designation reset across
 *    all four read paths (eager, event-stream, lazy, async).
 *
 * Fixtures are committed synthetic Part 10 files in test/fixtures/charsets/
 * (regenerable via `node test/fixtures/charsets/make-fixtures.mjs`); the
 * expected values below mirror that generator. Identities are neutral
 * sample text / JANE DOE transliterations — no real names.
 *
 * Conventions follow test/data-encoding.test.js and
 * test/issues/issue454-iso2022-charsets.test.js.
 */

import fs from "fs";
import path from "path";
import dcmjs from "../src/index.js";
import {
    resolveCharsetDecoder,
    Iso2022Decoder,
    PN_DELIMITER_BYTES
} from "../src/charset/iso2022.js";

const { DicomMessage, DicomMetaDictionary } = dcmjs.data;
const { DicomEventStream } = dcmjs.eventStream;
const { AsyncDicomReader } = dcmjs.async;

const FIXTURE_DIR = path.join(__dirname, "fixtures", "charsets");

function fixtureBuffer(name) {
    const bytes = fs.readFileSync(path.join(FIXTURE_DIR, name));
    return bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength
    );
}

function naturalizeEager(name, options) {
    const dicomDict = DicomMessage.readFile(fixtureBuffer(name), options);
    return DicomMetaDictionary.naturalizeDataset(dicomDict.dict);
}

function naturalizeLazy(name) {
    const dicomDict = DicomMessage.readFile(fixtureBuffer(name), {
        core: "lazy"
    });
    return DicomMetaDictionary.naturalizeDataset(dicomDict.dict);
}

async function naturalizeStream(name) {
    return DicomEventStream.fromPart10(fixtureBuffer(name)).toNaturalized();
}

async function naturalizeAsync(name) {
    const reader = new AsyncDicomReader();
    reader.stream.addBuffer(fixtureBuffer(name));
    reader.stream.setComplete();
    const { dict } = await reader.readFile();
    return DicomMetaDictionary.naturalizeDataset(dict);
}

// Expected decoded values, mirroring make-fixtures.mjs.
const expected = {
    "thai-ir166.dcm": {
        patientName: "เจน^โด=JANE^DOE",
        institution: "โรงพยาบาลทดสอบ"
    },
    "latin9-ir203.dcm": {
        patientName: "DŒ^JANE",
        institution: "Hôpital Œuvre 5€ ŠšŽžŸ"
    },
    "latin9-2022-ir203.dcm": {
        patientName: "JANE^DOE=Œdipe€",
        institution: "Price €3"
    },
    "pn-delimiter-reset.dcm": {
        // ^ and = reset the ISO 2022 designations to the value-1 default
        // (no G1 -> latin1), so the un-re-designated 0xBD decodes as ½.
        patientName: "Œ^½=Ÿ",
        institution: "DELIMITER RESET PROBE"
    },
    "jisx0212-ir159.dcm": {
        patientName: "DOE^JANE=丂阢",
        institution: "瓛 TESTS"
    },
    "gb2312-literal.dcm": {
        patientName: "Wang^XiaoDong=王^小东",
        institution: "测试医院"
    },
    "gb18030.dcm": {
        patientName: "Wang^XiaoDong=王^小东",
        institution: "测试医院"
    },
    "mixed-order-edge.dcm": {
        patientName: "山田^TAROU",
        institution: "山田 TEST"
    }
};

describe("unit-level decoder resolution", () => {
    it("ISO_IR 203 resolves to a Latin-9 decoder (0xA4 is €, not ¤)", () => {
        const decoder = resolveCharsetDecoder(["ISO_IR 203"]);
        expect(decoder.decode(new Uint8Array([0xa4, 0xbc, 0xbd, 0xbe]))).toBe(
            "€ŒœŸ"
        );
    });

    it("ISO 2022 IR 203 in a code extension handles ESC - b (G1 <- 8859-15)", () => {
        const decoder = resolveCharsetDecoder([
            "ISO 2022 IR 6",
            "ISO 2022 IR 203"
        ]);
        expect(decoder).toBeInstanceOf(Iso2022Decoder);
        const bytes = new Uint8Array([
            0x41, // A
            0x1b,
            0x2d,
            0x62, // ESC - b
            0xbc, // Œ
            0xa4 // €
        ]);
        expect(decoder.decode(bytes)).toBe("AŒ€");
    });

    it("ISO 2022 IR 203 as value 1 seeds the initial G1 designation", () => {
        const decoder = resolveCharsetDecoder([
            "ISO 2022 IR 203",
            "ISO 2022 IR 6"
        ]);
        expect(decoder).toBeInstanceOf(Iso2022Decoder);
        // GR byte without any escape: initial state must already carry
        // the 8859-15 G1 half.
        expect(decoder.decode(new Uint8Array([0xbc, 0x41]))).toBe("ŒA");
    });

    it("ISO 2022 IR 159 (JIS X 0212) decodes ESC $ ( D runs (no U+FFFD)", () => {
        const decoder = resolveCharsetDecoder([
            "ISO 2022 IR 6",
            "ISO 2022 IR 159"
        ]);
        const bytes = new Uint8Array([
            0x1b,
            0x24,
            0x28,
            0x44, // ESC $ ( D
            0x30,
            0x21, // 丂 (U+4E02)
            0x66,
            0x46 // 阢 (U+9622)
        ]);
        const decoded = decoder.decode(bytes);
        expect(decoded).toBe("丂阢");
        expect(decoded).not.toMatch(/�/);
    });

    it("bare GB2312 resolves leniently to the GBK decoder", () => {
        const decoder = resolveCharsetDecoder(["GB2312"]);
        expect(decoder.decode(new Uint8Array([0xcd, 0xf5]))).toBe("王");
    });

    it("PN_DELIMITER_BYTES carries exactly ^ and =", () => {
        expect([...PN_DELIMITER_BYTES].sort()).toEqual([0x3d, 0x5e]);
    });
});

describe("fixture decode matrix — eager, event-stream, lazy", () => {
    for (const [name, { patientName, institution }] of Object.entries(
        expected
    )) {
        it(`${name}: eager readFile decodes PN and LO`, () => {
            const dataset = naturalizeEager(name, { ignoreErrors: true });
            expect(String(dataset.PatientName)).toBe(patientName);
            expect(dataset.InstitutionName).toBe(institution);
            expect(dataset.SpecificCharacterSet).toBe("ISO_IR 192");
        });

        it(`${name}: fromPart10 stream decodes PN and LO`, async () => {
            const dataset = await naturalizeStream(name);
            expect(String(dataset.PatientName)).toBe(patientName);
            expect(dataset.InstitutionName).toBe(institution);
        });

        it(`${name}: lazy core decodes PN and LO`, () => {
            const dataset = naturalizeLazy(name);
            expect(String(dataset.PatientName)).toBe(patientName);
            expect(dataset.InstitutionName).toBe(institution);
        });
    }

    it("strict eager read does not throw on any fixture (incl. GB2312 literal and value-1 edge)", () => {
        for (const name of Object.keys(expected)) {
            expect(() =>
                DicomMessage.readFile(fixtureBuffer(name))
            ).not.toThrow();
        }
    });

    it("mixed-order-edge: lenient and strict reads agree (multi-byte set as value 1)", () => {
        const strict = naturalizeEager("mixed-order-edge.dcm");
        const lenient = naturalizeEager("mixed-order-edge.dcm", {
            ignoreErrors: true
        });
        expect(String(strict.PatientName)).toBe(
            expected["mixed-order-edge.dcm"].patientName
        );
        expect(String(lenient.PatientName)).toBe(String(strict.PatientName));
    });
});

describe("PN component-delimiter reset across all four read paths", () => {
    // pn-delimiter-reset.dcm is only decoded correctly when the read path
    // threads PN's ^ / = delimiters into the ISO 2022 decoder: without the
    // reset the 0xBD after ^ would decode as œ instead of ½.
    const PN = expected["pn-delimiter-reset.dcm"].patientName;

    it("eager (DicomMessage.readFile) resets designations at ^ and =", () => {
        const dataset = naturalizeEager("pn-delimiter-reset.dcm");
        expect(String(dataset.PatientName)).toBe(PN);
    });

    it("event-stream (fromPart10Stream) resets designations at ^ and =", async () => {
        const dataset = await naturalizeStream("pn-delimiter-reset.dcm");
        expect(String(dataset.PatientName)).toBe(PN);
    });

    it("lazy (readFileLazy) resets designations at ^ and =", () => {
        const dataset = naturalizeLazy("pn-delimiter-reset.dcm");
        expect(String(dataset.PatientName)).toBe(PN);
    });

    it("async (AsyncDicomReader) resets designations at ^ and =", async () => {
        const dataset = await naturalizeAsync("pn-delimiter-reset.dcm");
        expect(String(dataset.PatientName)).toBe(PN);
    });
});
