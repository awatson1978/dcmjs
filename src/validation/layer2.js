/**
 * Layer 2 — cross-field checks over the collector snapshot.
 *
 * Runs once at finish()/end-of-walk against the ValidationCollector: pixel
 * geometry vs PixelData byte length (native syntaxes), fragment coherence
 * (encapsulated), BitsStored/HighBit relations, palette LUT descriptor
 * coherence, transfer-syntax-vs-encapsulation coherence, the recomputed
 * file meta group length, and the declared-charset-vs-observed-bytes INFO.
 */

import { unencapsulatedTransferSyntaxes, TagHex } from "../constants/dicom.js";
import { Severity } from "./result.js";
import { impliesAscii } from "./layer1.js";

/** Explicit-VR long-form header VRs (12-byte headers in the meta group). */
const LONG_HEADER_VRS = new Set([
    "OB",
    "OD",
    "OF",
    "OL",
    "OV",
    "OW",
    "SQ",
    "SV",
    "UC",
    "UN",
    "UR",
    "UT",
    "UV"
]);

/** Fixed byte widths for non-string, non-binary VRs. */
const FIXED_VALUE_WIDTH = {
    AT: 4,
    FL: 4,
    FD: 8,
    SL: 4,
    SS: 2,
    SV: 8,
    UL: 4,
    US: 2,
    UV: 8
};

/**
 * Canonical encoded byte size of one meta element (explicit little endian,
 * even-padded), from decoded values / accumulated binary bytes. Returns
 * null when the element cannot be sized (e.g. SQ in meta, non-string
 * values for a string VR) — the group-length check is skipped then.
 * @param {{vr: string, values: Array, binaryBytes: number|null}} element
 */
export function metaElementSize(element) {
    const { vr, values, binaryBytes } = element;
    const headerSize = LONG_HEADER_VRS.has(vr) ? 12 : 8;
    if (binaryBytes !== null && binaryBytes !== undefined) {
        return headerSize + binaryBytes + (binaryBytes % 2);
    }
    if (vr === "SQ") {
        return null;
    }
    const width = FIXED_VALUE_WIDTH[vr];
    if (width) {
        return headerSize + width * values.length;
    }
    let length = 0;
    for (const value of values) {
        if (typeof value !== "string" && !(value instanceof String)) {
            return null;
        }
        length += String(value).length;
    }
    if (values.length > 1) {
        length += values.length - 1; // backslash separators
    }
    return headerSize + length + (length % 2);
}

/**
 * Recompute the meta group length from the recorded meta elements
 * (everything after (0002,0000)). Returns null when any element is
 * unsizable.
 * @param {Array<{tag: string, vr: string, values: Array, binaryBytes: number|null}>} metaElements
 */
export function computeMetaGroupLength(metaElements) {
    let total = 0;
    for (const element of metaElements) {
        if (element.tag === TagHex.FileMetaInformationGroupLength) {
            continue;
        }
        const size = metaElementSize(element);
        if (size === null) {
            return null;
        }
        total += size;
    }
    return total;
}

function asNumber(value) {
    if (value === null || value === undefined || value === "") {
        return null;
    }
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

/**
 * Run every layer-2 check against the collector snapshot.
 * @param {import("./collector.js").ValidationCollector} collector
 * @param {import("./result.js").IssueReporter} reporter
 */
export function runLayer2(collector, reporter) {
    checkFmiGroupLength(collector, reporter);
    checkBitsAndHighBit(collector, reporter);
    checkPixelData(collector, reporter);
    checkPalette(collector, reporter);
    checkObservedCharset(collector, reporter);
}

function checkFmiGroupLength(collector, reporter) {
    const { present, declaredGroupLength, computedGroupLength } = collector.fmi;
    if (
        !present ||
        declaredGroupLength === null ||
        computedGroupLength === null
    ) {
        return;
    }
    if (Number(declaredGroupLength) !== computedGroupLength) {
        reporter.report({
            severity: Severity.ERROR,
            tag: TagHex.FileMetaInformationGroupLength,
            rule: "fmi.groupLength",
            message:
                `declared FileMetaInformationGroupLength ${declaredGroupLength} ` +
                `does not match the recomputed meta group length ${computedGroupLength}`
        });
    }
}

function checkBitsAndHighBit(collector, reporter) {
    const bitsAllocated = asNumber(collector.scalars.bitsAllocated);
    const bitsStored = asNumber(collector.scalars.bitsStored);
    const highBit = asNumber(collector.scalars.highBit);

    if (bitsAllocated !== null && bitsStored !== null) {
        if (bitsStored > bitsAllocated) {
            reporter.report({
                severity: Severity.ERROR,
                tag: "00280101",
                keyword: "BitsStored",
                rule: "pixel.bitsStored",
                message: `BitsStored ${bitsStored} exceeds BitsAllocated ${bitsAllocated}`
            });
        }
    }
    if (bitsStored !== null && highBit !== null) {
        if (highBit !== bitsStored - 1) {
            reporter.report({
                severity: Severity.ERROR,
                tag: "00280102",
                keyword: "HighBit",
                rule: "pixel.highBit",
                message: `HighBit ${highBit} must equal BitsStored - 1 (${
                    bitsStored - 1
                })`
            });
        }
    }
}

function checkPixelData(collector, reporter) {
    const pixelData = collector.pixelData;
    if (!pixelData) {
        return;
    }
    const ts = collector.transferSyntaxUid;
    const tsIsNative = !!(ts && unencapsulatedTransferSyntaxes[ts]);

    // Transfer-syntax-vs-encapsulation coherence. Only an affirmative
    // encapsulated marker is trusted (the eager dict path cannot
    // distinguish "native" from "unknown", so the reverse direction is
    // not diagnosable path-independently).
    if (pixelData.encapsulated && tsIsNative) {
        reporter.report({
            severity: Severity.ERROR,
            tag: TagHex.PixelData,
            rule: "ts.encapsulation",
            message: `encapsulated PixelData under unencapsulated transfer syntax ${ts}`
        });
    }

    if (pixelData.encapsulated) {
        checkEncapsulatedCoherence(pixelData, reporter);
        return;
    }
    if (!tsIsNative || pixelData.bulkReference) {
        return;
    }

    const rows = asNumber(collector.scalars.rows);
    const columns = asNumber(collector.scalars.columns);
    const samples = asNumber(collector.scalars.samplesPerPixel) ?? 1;
    const bitsAllocated = asNumber(collector.scalars.bitsAllocated);
    const frames = asNumber(collector.scalars.numberOfFrames) ?? 1;
    if (
        rows === null ||
        columns === null ||
        bitsAllocated === null ||
        bitsAllocated < 8
    ) {
        // Sub-byte packing (BitsAllocated 1) has its own length rules —
        // out of scope for the byte-per-sample formula.
        return;
    }
    const expected =
        rows * columns * samples * Math.ceil(bitsAllocated / 8) * frames;
    const actual = pixelData.byteLength;
    // Allow the even-padding byte.
    if (actual !== expected && actual !== expected + 1) {
        reporter.report({
            severity: Severity.ERROR,
            tag: TagHex.PixelData,
            rule: "pixel.dataLength",
            message:
                `PixelData length ${actual} does not match Rows(${rows}) x ` +
                `Columns(${columns}) x SamplesPerPixel(${samples}) x ` +
                `${Math.ceil(
                    bitsAllocated / 8
                )} byte(s) x frames(${frames}) = ${expected}`
        });
    }
}

function checkEncapsulatedCoherence(pixelData, reporter) {
    if (!pixelData.fragmentCount) {
        reporter.report({
            severity: Severity.ERROR,
            tag: TagHex.PixelData,
            rule: "pixel.dataLength",
            message: "encapsulated PixelData carries no fragments"
        });
        return;
    }
    if (pixelData.zeroLengthFragments) {
        reporter.report({
            severity: Severity.WARNING,
            tag: TagHex.PixelData,
            rule: "pixel.dataLength",
            message: `${pixelData.zeroLengthFragments} zero-length fragment(s) in encapsulated PixelData`
        });
    }
    const bot = pixelData.basicOffsetTable;
    if (bot && bot.length) {
        let sane = bot[0] === 0;
        for (let i = 1; sane && i < bot.length; i++) {
            if (bot[i] <= bot[i - 1]) {
                sane = false;
            }
        }
        if (!sane) {
            reporter.report({
                severity: Severity.WARNING,
                tag: TagHex.PixelData,
                rule: "pixel.dataLength",
                message:
                    "Basic Offset Table is not a strictly increasing offset list starting at 0"
            });
        }
    }
}

function checkPalette(collector, reporter) {
    const { descriptors, dataLengths } = collector.palette;
    for (const channel of Object.keys(descriptors)) {
        const descriptor = descriptors[channel];
        const actual = dataLengths[channel];
        if (!Array.isArray(descriptor) || descriptor.length !== 3) {
            continue; // vm.count already covers a malformed triplet
        }
        if (actual === null || actual === undefined) {
            continue;
        }
        const entries =
            asNumber(descriptor[0]) === 0 ? 65536 : asNumber(descriptor[0]);
        const bits = asNumber(descriptor[2]);
        if (entries === null || bits === null) {
            continue;
        }
        const bytesPerEntry = bits <= 8 ? 1 : 2;
        const expected = entries * bytesPerEntry;
        const acceptable =
            actual === expected ||
            actual === expected + 1 ||
            // 8-bit LUT data is commonly stored one entry per 16-bit word.
            (bits <= 8 && actual === entries * 2);
        if (!acceptable) {
            reporter.report({
                severity: Severity.ERROR,
                tag: Object.keys(dataLengths).length
                    ? paletteDataTag(channel)
                    : undefined,
                rule: "palette.descriptor",
                message:
                    `${channel} palette LUT data length ${actual} does not match ` +
                    `descriptor [${descriptor.join(
                        ", "
                    )}] (expected ${expected} bytes)`
            });
        }
    }
}

function paletteDataTag(channel) {
    return { red: "00281201", green: "00281202", blue: "00281203" }[channel];
}

function checkObservedCharset(collector, reporter) {
    if (!collector.nonAsciiPath) {
        return;
    }
    if (impliesAscii(collector.charsetValues)) {
        reporter.report({
            severity: Severity.INFO,
            tag: TagHex.SpecificCharacterSet,
            path: collector.nonAsciiPath,
            rule: "charset.observed",
            message:
                "non-ASCII characters observed while SpecificCharacterSet declares or implies the default ASCII repertoire"
        });
    }
}
