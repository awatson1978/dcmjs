/**
 * Byte-level synthetic Part 10 builders for the corpus reproducer suite
 * (test/corpus/). These tests pin behavior diagnosed against real-world
 * corpus files (paths under corpus-cache/, never copied into the repo, per
 * ISSUE_TEST_PLAN.md's tiered policy) using synthetic byte patterns with
 * JANE DOE identities.
 *
 * Unlike test/helper/sampleDicomPart10.js (which writes well-formed files
 * through the library's own writer), these helpers hand-roll element bytes
 * so tests can reproduce MALFORMED shapes: wrong group lengths, overrun
 * declared lengths, UN-encoded sequences, mixed VR encodings.
 */

export const IMPLICIT_LE = "1.2.840.10008.1.2";
export const EXPLICIT_LE = "1.2.840.10008.1.2.1";

const LONG_LENGTH_VRS = new Set([
    "OB",
    "OW",
    "OF",
    "SQ",
    "UC",
    "UR",
    "UT",
    "UN",
    "OD",
    "UV"
]);

export function ascii(str) {
    const out = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) {
        out[i] = str.charCodeAt(i) & 0xff;
    }
    return out;
}

export function u16le(v) {
    return new Uint8Array([v & 0xff, (v >> 8) & 0xff]);
}

export function u32le(v) {
    return new Uint8Array([
        v & 0xff,
        (v >> 8) & 0xff,
        (v >> 16) & 0xff,
        (v >>> 24) & 0xff
    ]);
}

export function concatBytes(...parts) {
    const arrays = parts.map(p =>
        p instanceof Uint8Array ? p : new Uint8Array(p)
    );
    const total = arrays.reduce((sum, a) => sum + a.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const a of arrays) {
        out.set(a, offset);
        offset += a.length;
    }
    return out;
}

/** Explicit-VR little-endian element. `value` is a Uint8Array or string. */
export function evrEl(group, element, vr, value, declaredLength = null) {
    const data = typeof value === "string" ? ascii(value) : value;
    const length = declaredLength === null ? data.length : declaredLength;
    const head = concatBytes(u16le(group), u16le(element), ascii(vr));
    if (LONG_LENGTH_VRS.has(vr)) {
        return concatBytes(head, u16le(0), u32le(length), data);
    }
    return concatBytes(head, u16le(length), data);
}

/** Implicit-VR little-endian element. `value` is a Uint8Array or string. */
export function ivrEl(group, element, value, declaredLength = null) {
    const data = typeof value === "string" ? ascii(value) : value;
    const length = declaredLength === null ? data.length : declaredLength;
    return concatBytes(u16le(group), u16le(element), u32le(length), data);
}

/** Sequence item (FFFE,E000) with a defined length around `content`. */
export function item(content, declaredLength = null) {
    const length = declaredLength === null ? content.length : declaredLength;
    return concatBytes(u16le(0xfffe), u16le(0xe000), u32le(length), content);
}

/**
 * Full Part 10 file: 128-byte preamble + "DICM" + FMI (explicit LE) + body.
 * The (0002,0000) group length is computed from the actual meta bytes;
 * `groupLengthDelta` skews it to reproduce wrong-group-length corpora.
 */
export function part10(
    transferSyntaxUID,
    bodyBytes,
    { groupLengthDelta = 0, extraMeta = null } = {}
) {
    const tsValue =
        transferSyntaxUID.length % 2
            ? transferSyntaxUID + "\0"
            : transferSyntaxUID;
    const meta = concatBytes(
        evrEl(0x0002, 0x0002, "UI", "1.2.840.10008.5.1.4.1.1.4\0"),
        evrEl(0x0002, 0x0003, "UI", "1.2.3.4.5.6.7.8.90"),
        evrEl(0x0002, 0x0010, "UI", tsValue),
        extraMeta || new Uint8Array(0)
    );
    return concatBytes(
        new Uint8Array(128),
        ascii("DICM"),
        evrEl(0x0002, 0x0000, "UL", u32le(meta.length + groupLengthDelta)),
        meta,
        bodyBytes
    );
}

/** ArrayBuffer copy (what DicomMessage.readFile expects). */
export function toArrayBuffer(bytes) {
    return bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength
    );
}

/** Async chunk iterator for fromPart10Stream. */
export async function* chunked(bytes, size = 64) {
    for (let offset = 0; offset < bytes.length; offset += size) {
        yield bytes.subarray(offset, Math.min(offset + size, bytes.length));
    }
}
