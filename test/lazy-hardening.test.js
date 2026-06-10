import fs from "fs";
import path from "path";
import { parseDicom } from "@dcmjs/parser";
import dcmjs from "../src/index.js";
import { log } from "../src/log.js";
import { compareSection } from "./helper/equivalence.js";

const { DicomMessage, DicomDict } = dcmjs.data;

/**
 * Regression tests for the lazy-core hardening fixes (H2, M1-M4), including
 * the divergence-pinning tests for the documented error-timing differences
 * (see the docblock in src/lazy/LazyDicomReader.js).
 */

const FIXTURE_DIR = path.join(
    __dirname,
    "..",
    "packages",
    "parser",
    "testImages"
);

function toStandaloneArrayBuffer(data) {
    return data.buffer.slice(
        data.byteOffset,
        data.byteOffset + data.byteLength
    );
}

function readFixture(name) {
    return toStandaloneArrayBuffer(
        fs.readFileSync(path.join(FIXTURE_DIR, name))
    );
}

function readEager(buffer, options = {}) {
    return DicomMessage.readFile(buffer.slice(0), {
        ...options,
        core: "eager"
    });
}

function readLazy(buffer, options = {}) {
    return DicomMessage.readFile(buffer.slice(0), {
        ...options,
        core: "lazy"
    });
}

/**
 * log.warn call counter. jest.setup.js replaces the whole loglevel module
 * with persistent jest.fn() mocks whose history spans the test file, so
 * the assertions below count matching calls AFTER a recorded baseline
 * instead of spying fresh.
 */
function warnCallsContaining(needle, from) {
    return log.warn.mock.calls
        .slice(from)
        .filter(args => args.map(String).join(" ").includes(needle)).length;
}

// ---------------------------------------------------------------------------
// H2 - ignoreErrors during materialization
// ---------------------------------------------------------------------------
describe("H2: ignoreErrors honored during materialization", () => {
    /**
     * A file whose only defect is an unsupported SpecificCharacterSet
     * ('BOGUS!') INSIDE a sequence item. Eager hits it mid-scan while
     * reading the SQ element; lazy hits it when the SQ entry materializes.
     */
    function buildBadInItemCharsetFile() {
        const dicomDict = new DicomDict({});
        dicomDict.dict = {
            "00080050": { vr: "SH", Value: ["ACC1"] },
            "00081110": {
                vr: "SQ",
                Value: [
                    {
                        "00080005": { vr: "CS", Value: ["BOGUS!"] },
                        "00081150": { vr: "UI", Value: ["1.2.3"] }
                    }
                ]
            },
            "00100020": { vr: "LO", Value: ["P1"] }
        };
        return dicomDict.write();
    }

    test("ignoreErrors:false - eager throws at readFile, lazy throws the same error at first access (documented divergence)", () => {
        const buffer = buildBadInItemCharsetFile();

        expect(() => readEager(buffer)).toThrow(
            /Unsupported character set: bogus!/
        );

        // lazy returns the dict - the error surfaces at access, not before
        const lazy = readLazy(buffer);
        expect(Object.keys(lazy.dict).sort()).toEqual([
            "00080050",
            "00081110",
            "00100020"
        ]);
        expect(() => lazy.dict["00081110"].Value).toThrow(
            /Unsupported character set: bogus!/
        );
        expect(() => lazy.dict["00081110"]._rawValue).toThrow(
            /Unsupported character set: bogus!/
        );
        // entries the eager core never even reached remain readable
        expect(lazy.dict["00080050"].Value).toEqual(["ACC1"]);
        expect(lazy.dict["00100020"].Value).toEqual(["P1"]);
    });

    test("ignoreErrors:true - eager truncates the dict, lazy warns and never throws at access (documented divergence)", () => {
        const buffer = buildBadInItemCharsetFile();

        // eager: the nested item read throws, the outer read catches (and
        // warns) and returns everything BEFORE the failing SQ element
        const eager = readEager(buffer, { ignoreErrors: true });
        expect(Object.keys(eager.dict).sort()).toEqual(["00080050"]);

        const warnBase = log.warn.mock.calls.length;

        // lazy: full dict; the in-item charset resolves with eager's own
        // top-level warn-and-continue semantics - access never throws
        const lazy = readLazy(buffer, { ignoreErrors: true });
        expect(Object.keys(lazy.dict).sort()).toEqual([
            "00080050",
            "00081110",
            "00100020"
        ]);
        const items = lazy.dict["00081110"].Value;
        expect(items).toHaveLength(1);
        expect(String(items[0]["00080005"].Value[0])).toBe("ISO_IR 192");
        expect(items[0]["00081150"].Value).toEqual(["1.2.3"]);

        const charsetWarns = () =>
            warnCallsContaining("Unsupported character set", warnBase);
        expect(charsetWarns()).toBe(1);

        // materialization is cached: repeated access does not re-warn
        void lazy.dict["00081110"].Value;
        void lazy.dict["00081110"]._rawValue;
        expect(charsetWarns()).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// M1 - FileMetaInformationGroupLength VALUE drives the meta/dict partition
// ---------------------------------------------------------------------------
describe("M1: meta group length value windows the meta group", () => {
    /**
     * Shrinks the (0002,0000) value by the size of the LAST meta element,
     * so the eager core's value-windowed meta read ends one element early
     * and that element parses as the first BODY element instead.
     */
    function buildPatchedMetaLengthFile() {
        const buffer = readFixture("CT1_UNC.explicit_little_endian.dcm");
        const bytes = new Uint8Array(buffer);
        const dataSet = parseDicom(new Uint8Array(buffer.slice(0)));
        const groupLength = dataSet.elements.x00020000;
        expect(groupLength).toBeDefined();

        const metaElements = Object.values(dataSet.elements).filter(
            el => el.tagValue >>> 16 === 0x0002 && el.tag !== "x00020000"
        );
        const last = metaElements.reduce((a, b) =>
            b.startOffset > a.startOffset ? b : a
        );
        // the transfer syntax must stay inside the shrunken window
        expect(last.tag).not.toBe("x00020010");

        const view = new DataView(bytes.buffer);
        const original = view.getUint32(groupLength.dataOffset, true);
        view.setUint32(
            groupLength.dataOffset,
            original - (last.endOffset - last.startOffset),
            true
        );
        return {
            buffer: bytes.buffer,
            displacedTag: last.tag.slice(1).toUpperCase()
        };
    }

    test("both cores agree on which section every element lands in", () => {
        const { buffer, displacedTag } = buildPatchedMetaLengthFile();

        const eager = readEager(buffer);
        const lazy = readLazy(buffer);

        // the partition really moved: the last meta element is now a body
        // element in BOTH cores
        expect(eager.meta[displacedTag]).toBeUndefined();
        expect(eager.dict[displacedTag]).toBeDefined();
        expect(lazy.meta[displacedTag]).toBeUndefined();
        expect(lazy.dict[displacedTag]).toBeDefined();

        compareSection(eager.meta, lazy.meta, "meta");
        compareSection(eager.dict, lazy.dict, "dict");
    });

    test("the boundary mismatch routes the whole file through the eager fallback", () => {
        const { buffer } = buildPatchedMetaLengthFile();
        const lazy = readLazy(buffer);
        // fallback entries are plain data properties, not lazy getters
        const descriptor = Object.getOwnPropertyDescriptor(
            lazy.dict["00080060"],
            "Value"
        );
        expect(descriptor.get).toBeUndefined();
        expect(descriptor.value).toBeDefined();
    });

    test("a correct group length keeps the lazy path engaged", () => {
        const buffer = readFixture("CT1_UNC.explicit_little_endian.dcm");
        const lazy = readLazy(buffer);
        const descriptor = Object.getOwnPropertyDescriptor(
            lazy.dict["00080060"],
            "Value"
        );
        expect(typeof descriptor.get).toBe("function");
    });
});

// ---------------------------------------------------------------------------
// M2 - malformed encapsulated pixel data must not silently succeed
// ---------------------------------------------------------------------------
describe("M2: malformed encapsulated pixel data", () => {
    /**
     * Patches the second fragment's item tag to garbage (0008,0001) in a
     * no-BOT fragmented fixture with nothing after the pixel data element.
     * The garbage item's length field is widened to span the rest of the
     * file so the tokenizer's clamped-fragment recovery consumes the tail
     * cleanly and parsing SUCCEEDS with just a warning - the eager core
     * throws on the tag itself and never reads that length.
     */
    function buildMalformedEncapsulatedFile() {
        const buffer = readFixture(
            "encapsulated/multi-frame/CT0012.fragmented_no_bot_jpeg_lossless.70.dcm"
        );
        const bytes = new Uint8Array(buffer);
        const dataSet = parseDicom(new Uint8Array(buffer.slice(0)));
        const pixelEl = dataSet.elements.x7fe00010;
        expect(pixelEl.basicOffsetTable).toHaveLength(0);
        expect(pixelEl.fragments.length).toBeGreaterThan(1);
        // nothing after the pixel data element in this fixture
        expect(pixelEl.endOffset).toBe(bytes.length);

        const secondFragment = pixelEl.fragments[1];
        const view = new DataView(bytes.buffer);
        view.setUint16(secondFragment.position - 8, 0x0008, true);
        view.setUint16(secondFragment.position - 6, 0x0001, true);
        view.setUint32(
            secondFragment.position - 4,
            bytes.length - secondFragment.position,
            true
        );
        return bytes.buffer;
    }

    test("the tokenizer parses the malformed file with a warning (precondition)", () => {
        const buffer = buildMalformedEncapsulatedFile();
        const dataSet = parseDicom(new Uint8Array(buffer));
        expect(
            dataSet.warnings.some(
                warning =>
                    warning.includes("unexpected tag") &&
                    warning.includes(
                        "while searching for end of pixel data element"
                    )
            )
        ).toBe(true);
    });

    test("ignoreErrors:false - eager throws at readFile, lazy throws the eager-equivalent error at access (documented divergence)", () => {
        const buffer = buildMalformedEncapsulatedFile();

        expect(() => readEager(buffer)).toThrow(/Invalid tag in sequence/);

        const lazy = readLazy(buffer);
        expect(lazy.dict["7FE00010"]).toBeDefined();
        expect(() => lazy.dict["7FE00010"].Value).toThrow(
            /Invalid tag in sequence/
        );
        expect(() => lazy.dict["7FE00010"]._rawValue).toThrow(
            /Invalid tag in sequence/
        );
        // unaffected entries still materialize
        expect(lazy.dict["00080060"].Value).toBeDefined();
    });

    test("ignoreErrors:true - eager truncates, lazy yields undefined with one warning (documented divergence)", () => {
        const buffer = buildMalformedEncapsulatedFile();

        // eager catches (and warns) mid-scan: the pixel data element is lost
        const eager = readEager(buffer, { ignoreErrors: true });
        expect(eager.dict["7FE00010"]).toBeUndefined();
        expect(eager.dict["00080060"]).toBeDefined();

        const warnBase = log.warn.mock.calls.length;

        // lazy keeps the entry; access resolves to undefined + warning
        const lazy = readLazy(buffer, { ignoreErrors: true });
        expect(lazy.dict["7FE00010"]).toBeDefined();
        expect(lazy.dict["7FE00010"].Value).toBeUndefined();
        expect(lazy.dict["7FE00010"]._rawValue).toBeUndefined();

        const errorWarns = () =>
            warnCallsContaining("Invalid tag in sequence", warnBase);
        expect(errorWarns()).toBe(1);

        // cached: repeated access does not re-warn
        void lazy.dict["7FE00010"].Value;
        expect(errorWarns()).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// M3 - untilTag parity with the eager core
// ---------------------------------------------------------------------------
describe("M3: untilTag parity", () => {
    const ELE_FIXTURE = "CT1_UNC.explicit_little_endian.dcm";

    test("non-canonical (lowercase) untilTag is ignored, exactly like eager", () => {
        const buffer = readFixture(ELE_FIXTURE);
        const options = { untilTag: "7fe00010" };

        const eager = readEager(buffer, options);
        const lazy = readLazy(buffer, options);

        // eager compares against the UPPERCASE clean tag, so a lowercase
        // untilTag never matches and the whole file parses - in both cores
        expect(eager.dict["7FE00010"]).toBeDefined();
        expect(lazy.dict["7FE00010"]).toBeDefined();
        expect(lazy.dict["7FE00010"].Value).toBeDefined();
        compareSection(eager.meta, lazy.meta, "meta");
        compareSection(eager.dict, lazy.dict, "dict");
    });

    test("untilTag 00020010 with includeUntilTagValue:false replicates eager (stub entry, body read as explicit little endian)", () => {
        const buffer = readFixture(ELE_FIXTURE);
        const options = { untilTag: "00020010", includeUntilTagValue: false };

        const eager = readEager(buffer, options);
        const lazy = readLazy(buffer, options); // must not throw

        // eager stores the stub { vr: undefined, Value: 0 } for the
        // transfer syntax, derives mainSyntax undefined -> normalized to
        // explicit little endian, and parses the whole body
        expect(lazy.meta["00020010"].Value).toBe(0);
        expect(lazy.meta["00020010"].vr).toBeUndefined();
        expect(lazy.meta["00020012"]).toBeUndefined(); // meta truncated
        expect(lazy.dict["7FE00010"]).toBeDefined(); // body fully parsed
        compareSection(eager.meta, lazy.meta, "meta");
        compareSection(eager.dict, lazy.dict, "dict");
    });

    test("untilTag 00020000 is ignored, exactly like eager (the group length element is consumed before the windowed meta read)", () => {
        const buffer = readFixture(ELE_FIXTURE);
        const options = { untilTag: "00020000", includeUntilTagValue: false };

        const eager = readEager(buffer, options);
        const lazy = readLazy(buffer, options);

        expect(lazy.meta["00020016"]).toBeDefined(); // meta NOT truncated
        expect(lazy.dict["7FE00010"]).toBeDefined();
        compareSection(eager.meta, lazy.meta, "meta");
        compareSection(eager.dict, lazy.dict, "dict");
    });

    test("untilTag strictly inside (00020000, 00020010) keeps the refusal (eager genuinely TypeErrors)", () => {
        const buffer = readFixture(ELE_FIXTURE);
        const options = { untilTag: "00020001", includeUntilTagValue: true };

        expect(() => readEager(buffer, options)).toThrow(TypeError);
        expect(() => readLazy(buffer, options)).toThrow(
            /not supported by the lazy core/
        );
    });
});

// ---------------------------------------------------------------------------
// M4 - implicit-VR sequence-guess desync
// ---------------------------------------------------------------------------
describe("M4: implicit-VR dictionary framing (vrCallback)", () => {
    /**
     * Implicit-LE file with a defined-length element whose dictionary VR is
     * OB - (0028,2000) ICCProfile - and whose first 8 value bytes spell an
     * FFFE,E000 item tag plus a length that (when misread as a sequence)
     * swallows the following PixelData element. Without the dictionary
     * vrCallback the tokenizer's peek heuristic misframes it and the lazy
     * dict silently loses (7FE0,0010).
     */
    function buildItemMimicImplicitFile() {
        const bytes = [];
        const pushU8 = (...vals) => bytes.push(...vals);
        const pushU16 = v => pushU8(v & 0xff, (v >> 8) & 0xff);
        const pushU32 = v =>
            pushU8(
                v & 0xff,
                (v >> 8) & 0xff,
                (v >> 16) & 0xff,
                (v >>> 24) & 0xff
            );
        const pushTag = (group, element) => {
            pushU16(group);
            pushU16(element);
        };
        const pushAscii = s => {
            for (let i = 0; i < s.length; i++) {
                pushU8(s.charCodeAt(i));
            }
        };

        // preamble + DICM
        for (let i = 0; i < 128; i++) {
            pushU8(0);
        }
        pushAscii("DICM");

        // meta (explicit LE): (0002,0000) UL, (0002,0010) UI implicit-LE
        const transferSyntax = "1.2.840.10008.1.2\0";
        pushTag(0x0002, 0x0000);
        pushAscii("UL");
        pushU16(4);
        pushU32(8 + transferSyntax.length);
        pushTag(0x0002, 0x0010);
        pushAscii("UI");
        pushU16(transferSyntax.length);
        pushAscii(transferSyntax);

        // body (implicit LE)
        // (0008,0060) Modality CS
        pushTag(0x0008, 0x0060);
        pushU32(2);
        pushAscii("OT");
        // (0028,2000) ICCProfile, defined length 16; value mimics an item
        pushTag(0x0028, 0x2000);
        pushU32(16);
        pushTag(0xfffe, 0xe000); // value bytes 0-3: item tag mimic
        pushU32(16); // value bytes 4-7: "item length" overrunning the value
        pushTag(0x0008, 0x0000); // value bytes 8-11: plausible inner element
        pushU32(0); // value bytes 12-15: inner element length 0
        // (7FE0,0010) PixelData, 8 bytes - swallowed by the misframe
        pushTag(0x7fe0, 0x0010);
        pushU32(8);
        pushU8(1, 2, 3, 4, 5, 6, 7, 8);

        return new Uint8Array(bytes).buffer;
    }

    test("eager and lazy dicts are equal on the item-mimicking implicit file", () => {
        const buffer = buildItemMimicImplicitFile();

        const eager = readEager(buffer);
        const lazy = readLazy(buffer);

        expect(Object.keys(lazy.dict).sort()).toEqual([
            "00080060",
            "00282000",
            "7FE00010"
        ]);
        // the mimic element reads as plain OB bytes, not as a sequence
        expect(lazy.dict["00282000"].vr).toBe("OB");
        expect(
            new Uint8Array(lazy.dict["00282000"].Value[0]).slice(0, 4)
        ).toEqual(new Uint8Array([0xfe, 0xff, 0x00, 0xe0]));
        expect(new Uint8Array(lazy.dict["7FE00010"].Value[0])).toEqual(
            new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
        );
        compareSection(eager.meta, lazy.meta, "meta");
        compareSection(eager.dict, lazy.dict, "dict");
    });

    test("the lazy path (not the whole-file fallback) handles the implicit file", () => {
        const buffer = buildItemMimicImplicitFile();
        const lazy = readLazy(buffer);
        const descriptor = Object.getOwnPropertyDescriptor(
            lazy.dict["7FE00010"],
            "Value"
        );
        expect(typeof descriptor.get).toBe("function");
    });
});
