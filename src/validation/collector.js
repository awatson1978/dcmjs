/**
 * Minimal layer-3 collector (v2.0 Workstream B).
 *
 * Records exactly what IOD/module validation (PR 4) and the layer-2
 * cross-field checks need — presence/non-emptiness per sequence path, the
 * SOP Class / transfer syntax UIDs, roughly a dozen top-level scalars, and
 * the accumulated PixelData byte length. NO element values are retained
 * (the scalar snapshot below is the deliberate, bounded exception), so
 * streaming memory stays O(paths).
 *
 * Path semantics are bare-hex dot paths matching the packed IOD module
 * tables ("00400275.00081080"): sequence tags joined with ".", no item
 * indices — an attribute present in ANY item marks the path present.
 */

/** Top-level scalar tags captured for layer 2 (and layer 3's context). */
export const SCALAR_TAGS = {
    "00080016": "sopClassUid",
    "00280002": "samplesPerPixel",
    "00280004": "photometricInterpretation",
    "00280008": "numberOfFrames",
    "00280010": "rows",
    "00280011": "columns",
    "00280100": "bitsAllocated",
    "00280101": "bitsStored",
    "00280102": "highBit"
};

/** Palette Color LUT descriptor tags -> channel key. */
export const PALETTE_DESCRIPTOR_TAGS = {
    "00281101": "red",
    "00281102": "green",
    "00281103": "blue"
};

/** Palette Color LUT data tags -> channel key. */
export const PALETTE_DATA_TAGS = {
    "00281201": "red",
    "00281202": "green",
    "00281203": "blue"
};

export class ValidationCollector {
    constructor() {
        /** @type {Map<string, {present: boolean, nonEmpty: boolean}>} */
        this.paths = new Map();
        this.sopClassUid = null;
        this.transferSyntaxUid = null;
        /** Top-level scalar snapshot (SCALAR_TAGS values as keys). */
        this.scalars = {};
        /** PixelData (7FE0,0010) accounting — set at top-level endElement. */
        this.pixelData = null;
        this.palette = { descriptors: {}, dataLengths: {} };
        /** File meta accounting for fmi.groupLength. */
        this.fmi = {
            present: false,
            declaredGroupLength: null,
            computedGroupLength: null
        };
        /** Top-level (0008,0005) values as declared in the stream. */
        this.charsetValues = null;
        /** First path where non-ASCII text was observed (or null). */
        this.nonAsciiPath = null;
        this._sequenceStack = [];
    }

    /** Current sequence nesting depth (0 = top-level dataset). */
    get depth() {
        return this._sequenceStack.length;
    }

    /** Dot path for an element tag at the current position. */
    pathFor(tag) {
        return this._sequenceStack.length
            ? `${this._sequenceStack.join(".")}.${tag}`
            : tag;
    }

    /** Dot path of the sequence currently being walked ("" at top level). */
    currentSequencePath() {
        return this._sequenceStack.join(".");
    }

    enterSequence(tag) {
        this._sequenceStack.push(tag);
    }

    exitSequence() {
        this._sequenceStack.pop();
    }

    /** Record an element (or sequence) at its current path. */
    markPath(path, nonEmpty) {
        const entry = this.paths.get(path);
        if (!entry) {
            this.paths.set(path, { present: true, nonEmpty: !!nonEmpty });
        } else if (nonEmpty) {
            entry.nonEmpty = true;
        }
    }
}
