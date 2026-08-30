/**
 * One-off generator for the committed charset fixtures in this directory.
 * Rerun with `node test/fixtures/charsets/make-fixtures.mjs` if the fixture
 * set ever needs to change; the .dcm outputs are committed so tests never
 * depend on running this.
 *
 * Each fixture is a minimal Explicit VR Little Endian Part 10 file with a
 * SpecificCharacterSet (0008,0005) and raw legacy-encoded PN (0010,0010) /
 * LO (0008,0080) bytes. Identities are neutral sample text (JANE DOE
 * transliterations); no real names. Expected decoded values are printed on
 * generation and mirrored in test/charset-completion.test.js.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const OUT_DIR = path.dirname(fileURLToPath(import.meta.url));

const ESC = 0x1b;
const TRANSFER_SYNTAX = "1.2.840.10008.1.2.1"; // Explicit VR LE
const SOP_CLASS = "1.2.840.10008.5.1.4.1.1.7"; // Secondary Capture

// ---------------------------------------------------------------- encoders

/** TIS 620 / ISO-IR 166: Thai block U+0E01..U+0E5B at 0xA1.. by offset. */
function encodeTis620(text) {
    return [...text].map(ch => {
        const cp = ch.codePointAt(0);
        if (cp < 0x80) return cp;
        if (cp >= 0x0e01 && cp <= 0x0e5b) return cp - 0x0e01 + 0xa1;
        throw new Error(`not TIS 620 encodable: ${ch}`);
    });
}

/** ISO 8859-15 (Latin-9): Latin-1 with 8 replaced code positions. */
const LATIN9_REPLACEMENTS = {
    "€": 0xa4, // €
    Š: 0xa6,
    š: 0xa8,
    Ž: 0xb4,
    ž: 0xb8,
    Œ: 0xbc,
    œ: 0xbd,
    Ÿ: 0xbe
};
const LATIN9_REPLACED_POSITIONS = new Set(Object.values(LATIN9_REPLACEMENTS));
function encodeLatin9(text) {
    return [...text].map(ch => {
        if (ch in LATIN9_REPLACEMENTS) return LATIN9_REPLACEMENTS[ch];
        const cp = ch.codePointAt(0);
        if (cp <= 0xff && !LATIN9_REPLACED_POSITIONS.has(cp)) return cp;
        throw new Error(`not Latin-9 encodable: ${ch}`);
    });
}

// ------------------------------------------------------------ part10 build

function asciiBytes(str) {
    return [...str].map(ch => {
        const cp = ch.codePointAt(0);
        if (cp > 0x7f) throw new Error(`not ASCII: ${ch}`);
        return cp;
    });
}

/** One Explicit VR LE element. `value` is a byte array (already encoded). */
function element(group, elem, vr, value, padByte) {
    const bytes = [...value];
    if (bytes.length % 2 === 1) bytes.push(padByte);
    const out = [];
    out.push(group & 0xff, group >> 8, elem & 0xff, elem >> 8);
    out.push(vr.charCodeAt(0), vr.charCodeAt(1));
    if (vr === "OB" || vr === "OW" || vr === "UN" || vr === "SQ") {
        out.push(0, 0); // reserved
        out.push(
            bytes.length & 0xff,
            (bytes.length >> 8) & 0xff,
            (bytes.length >> 16) & 0xff,
            (bytes.length >> 24) & 0xff
        );
    } else {
        out.push(bytes.length & 0xff, (bytes.length >> 8) & 0xff);
    }
    out.push(...bytes);
    return out;
}

const uiElement = (g, e, uid) => element(g, e, "UI", asciiBytes(uid), 0x00);

/**
 * Builds a Part 10 buffer. `spec` = { charset, patientName, institution,
 * sopInstanceUid } where patientName / institution are raw byte arrays.
 */
function buildPart10({ charset, patientName, institution, sopInstanceUid }) {
    const meta = [
        ...element(0x0002, 0x0001, "OB", [0x00, 0x01], 0x00),
        ...uiElement(0x0002, 0x0002, SOP_CLASS),
        ...uiElement(0x0002, 0x0003, sopInstanceUid),
        ...uiElement(0x0002, 0x0010, TRANSFER_SYNTAX)
    ];
    const groupLength = element(
        0x0002,
        0x0000,
        "UL",
        [
            meta.length & 0xff,
            (meta.length >> 8) & 0xff,
            (meta.length >> 16) & 0xff,
            (meta.length >> 24) & 0xff
        ],
        0x00
    );
    const dataset = [
        ...element(0x0008, 0x0005, "CS", asciiBytes(charset), 0x20),
        ...uiElement(0x0008, 0x0016, SOP_CLASS),
        ...uiElement(0x0008, 0x0018, sopInstanceUid),
        ...element(0x0008, 0x0080, "LO", institution, 0x20),
        ...element(0x0010, 0x0010, "PN", patientName, 0x20)
    ];
    const preamble = new Array(128).fill(0);
    return Uint8Array.from([
        ...preamble,
        ...asciiBytes("DICM"),
        ...groupLength,
        ...meta,
        ...dataset
    ]);
}

// ---------------------------------------------------------------- fixtures

const escSeq = (...finals) => [ESC, ...asciiBytes(finals.join(""))];
const ESC_LATIN9_G1 = escSeq("-b"); // ESC 02/13 06/02 -> G1 ISO 8859-15
const ESC_JISX0212_G0 = escSeq("$(D");
const ESC_JISX0208_G0 = escSeq("$B");
const ESC_ASCII_G0 = escSeq("(B");

// GB2312/GBK bytes (also valid GB18030): 王 小 东 测 试 医 院
const GBK = {
    王: [0xcd, 0xf5],
    小: [0xd0, 0xa1],
    东: [0xb6, 0xab],
    测: [0xb2, 0xe2],
    试: [0xca, 0xd4],
    医: [0xd2, 0xbd],
    院: [0xd4, 0xba]
};
const gbkBytes = text =>
    [...text].flatMap(ch =>
        ch.codePointAt(0) < 0x80 ? [ch.codePointAt(0)] : GBK[ch]
    );

// JIS X 0212 GL pairs (row-cell bytes; decoded via euc-jp SS3):
//   0x30 0x21 -> 丂 (U+4E02), 0x66 0x46 -> 阢 (U+9622), 0x4C 0x71 -> 瓛 (U+74DB)
const JISX0212_PAIR_1 = [0x30, 0x21];
const JISX0212_PAIR_2 = [0x66, 0x46];
const JISX0212_PAIR_3 = [0x4c, 0x71];
// JIS X 0208 GL pairs: 0x3B 0x33 -> 山, 0x45 0x44 -> 田
const JISX0208_YAMA_DA = [0x3b, 0x33, 0x45, 0x44];

const fixtures = {
    // Thai — absent from the dclunie corpus. PN "เจน^โด" (Jane^Do).
    "thai-ir166.dcm": {
        charset: "ISO_IR 166",
        patientName: encodeTis620("เจน^โด=JANE^DOE"),
        institution: encodeTis620("โรงพยาบาลทดสอบ"), // "test hospital"
        sopInstanceUid: "1.2.826.0.1.3680043.8.498.166.1"
    },
    // Latin-9 as the sole (single-byte) charset.
    "latin9-ir203.dcm": {
        charset: "ISO_IR 203",
        patientName: encodeLatin9("DŒ^JANE"),
        institution: encodeLatin9("Hôpital Œuvre 5€ ŠšŽžŸ"),
        sopInstanceUid: "1.2.826.0.1.3680043.8.498.203.1"
    },
    // Latin-9 designated to G1 via ISO 2022 escape switching.
    "latin9-2022-ir203.dcm": {
        charset: "ISO 2022 IR 6\\ISO 2022 IR 203",
        patientName: [
            ...asciiBytes("JANE^DOE="),
            ...ESC_LATIN9_G1,
            ...encodeLatin9("Œdipe€")
        ],
        institution: [...asciiBytes("Price "), ...ESC_LATIN9_G1, 0xa4, 0x33], // "Price €3"
        sopInstanceUid: "1.2.826.0.1.3680043.8.498.203.2"
    },
    // PN component-delimiter reset probe: ^ and = must reset designations
    // to the value-1 default (no G1 -> latin1 passthrough), so the
    // un-re-designated 0xBD after ^ decodes as ½ (windows-1252), NOT œ.
    "pn-delimiter-reset.dcm": {
        charset: "ISO 2022 IR 6\\ISO 2022 IR 203",
        patientName: [
            ...ESC_LATIN9_G1,
            0xbc, // Œ
            0x5e, // ^ resets designations
            0xbd, // -> ½ via default latin1, not œ
            0x3d, // = resets designations
            ...ESC_LATIN9_G1,
            0xbe // Ÿ (re-designated)
        ],
        institution: asciiBytes("DELIMITER RESET PROBE"),
        sopInstanceUid: "1.2.826.0.1.3680043.8.498.203.3"
    },
    // JIS X 0212 via ESC $ ( D (previously decoded to U+FFFD).
    "jisx0212-ir159.dcm": {
        charset: "ISO 2022 IR 6\\ISO 2022 IR 159",
        patientName: [
            ...asciiBytes("DOE^JANE="),
            ...ESC_JISX0212_G0,
            ...JISX0212_PAIR_1,
            ...JISX0212_PAIR_2,
            ...ESC_ASCII_G0 // conformant: restore default before value end
        ],
        institution: [
            ...ESC_JISX0212_G0,
            ...JISX0212_PAIR_3,
            ...ESC_ASCII_G0,
            ...asciiBytes(" TESTS")
        ],
        sopInstanceUid: "1.2.826.0.1.3680043.8.498.159.1"
    },
    // Bare "GB2312" — nonstandard defined term seen in real files.
    "gb2312-literal.dcm": {
        charset: "GB2312",
        patientName: gbkBytes("Wang^XiaoDong=王^小东"),
        institution: gbkBytes("测试医院"), // "test hospital"
        sopInstanceUid: "1.2.826.0.1.3680043.8.498.58.1"
    },
    "gb18030.dcm": {
        charset: "GB18030",
        patientName: gbkBytes("Wang^XiaoDong=王^小东"),
        institution: gbkBytes("测试医院"),
        sopInstanceUid: "1.2.826.0.1.3680043.8.498.18030.1"
    },
    // Edge: multi-byte set as VALUE 1 (nonconforming ordering; lenient
    // read expected). Initial G0 is JIS X 0208, so the leading kanji run
    // carries no escape; the encoder re-designates ASCII after ^.
    "mixed-order-edge.dcm": {
        charset: "ISO 2022 IR 87\\ISO 2022 IR 6",
        patientName: [
            ...JISX0208_YAMA_DA, // 山田 (no escape: value-1 default is 0208)
            ...ESC_ASCII_G0,
            0x5e, // ^
            ...ESC_ASCII_G0, // re-designate after the delimiter reset
            ...asciiBytes("TAROU")
        ],
        institution: [
            ...JISX0208_YAMA_DA,
            ...ESC_ASCII_G0,
            ...asciiBytes(" TEST")
        ],
        sopInstanceUid: "1.2.826.0.1.3680043.8.498.87.1"
    }
};

for (const [name, spec] of Object.entries(fixtures)) {
    const bytes = buildPart10(spec);
    if (bytes.length >= 5 * 1024) {
        throw new Error(`${name} exceeds the 5 KB fixture budget`);
    }
    fs.writeFileSync(path.join(OUT_DIR, name), bytes);
    console.log(`${name}: ${bytes.length} bytes`);
}
