/**
 * test/eventStream/fromPart10Stream.test.js
 *
 * TDD suite for fromPart10Stream (slice K, stages 1–3).
 *
 * K1 groups (1–6): input normalisation, equivalence, options threading
 * K2 groups (7–9): FMI incremental streaming gate, no-meta-length, error parity
 * K3 groups (10–13): body incremental gate, native-path spy, truncation,
 *                    synthesized defined-length SQ
 */

import fs from "fs";
import path from "path";
import { fromPart10 } from "../../src/eventStream/fromPart10.js";
import { fromPart10Stream } from "../../src/eventStream/fromPart10Stream.js";
import { CollectorListener } from "../../src/eventStream/CollectorListener.js";
import { DicomEventStream } from "../../src/eventStream/api.js";
import { deepCompare } from "../helper/equivalence.js";

const REPO_ROOT = path.join(__dirname, "..", "..");

function readBuffer(rel) {
    const data = fs.readFileSync(path.join(REPO_ROOT, rel));
    return data.buffer.slice(
        data.byteOffset,
        data.byteOffset + data.byteLength
    );
}

// Two well-known fixtures: one explicit-LE scalar, one encapsulated JPEG.
const FIXTURE_ELE =
    "packages/parser/testImages/CT1_UNC.explicit_little_endian.dcm";
const FIXTURE_ENC =
    "packages/parser/testImages/encapsulated/single-frame/CT1_UNC.explicit_little_endian.dcm";

// ---------------------------------------------------------------------------
// Comparison helpers (adapted from fromPart10.test.js; inlined to keep the
// test self-contained — no cross-test-file imports of private helpers).
// ---------------------------------------------------------------------------

const EXEMPT = new Set(["00080005"]); // readFile rewrites SpecificCharacterSet
const isGroupLength = tag => tag.slice(4) === "0000";

function isBinaryValue(values) {
    return (
        Array.isArray(values) &&
        values.some(v => v instanceof ArrayBuffer || ArrayBuffer.isView(v))
    );
}

function concatBytes(values) {
    const parts = values.map(v =>
        v instanceof ArrayBuffer
            ? new Uint8Array(v)
            : new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
    );
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
        out.set(p, off);
        off += p.length;
    }
    return out;
}

function isItemDict(v) {
    return (
        v &&
        typeof v === "object" &&
        !Array.isArray(v) &&
        !(v instanceof ArrayBuffer) &&
        !ArrayBuffer.isView(v) &&
        v.vr === undefined &&
        v.BulkDataURI === undefined
    );
}

function compareEntry(a, b, where, problems) {
    deepCompare(a.vr, b.vr, `${where}.vr`, problems);
    const av = a.Value || [];
    const bv = b.Value || [];
    if (isBinaryValue(av) || isBinaryValue(bv)) {
        const ab = concatBytes(av);
        const bb = concatBytes(bv);
        if (ab.length !== bb.length) {
            problems.push(
                `${where}.Value: binary length ${ab.length} !== ${bb.length}`
            );
            return;
        }
        for (let i = 0; i < ab.length; i++) {
            if (ab[i] !== bb[i]) {
                problems.push(
                    `${where}.Value: binary bytes differ at index ${i}`
                );
                return;
            }
        }
        return;
    }
    if (av.some(isItemDict)) {
        if (av.length !== bv.length) {
            problems.push(
                `${where}.Value: SQ items ${av.length} !== ${bv.length}`
            );
            return;
        }
        for (let i = 0; i < av.length; i++) {
            compareSection(av[i], bv[i], `${where}.Value[${i}]`, problems);
        }
        return;
    }
    deepCompare(av, bv, `${where}.Value`, problems);
}

function compareSection(src, dst, where, problems) {
    const sTags = Object.keys(src)
        .filter(t => !isGroupLength(t))
        .sort();
    const dTags = Object.keys(dst)
        .filter(t => !isGroupLength(t))
        .sort();
    if (sTags.join(",") !== dTags.join(",")) {
        problems.push(`${where}: tags differ [${sTags}] vs [${dTags}]`);
        return;
    }
    for (const tag of sTags) {
        if (EXEMPT.has(tag)) continue;
        compareEntry(src[tag], dst[tag], `${where}.${tag}`, problems);
    }
}

/** Run the buffered reference path. */
async function runBuffered(buffer, options = {}) {
    const listener = new CollectorListener();
    await fromPart10(buffer, listener, options);
    return listener.result;
}

/** Run fromPart10Stream with any input form. */
async function runStream(input, options = {}) {
    const listener = new CollectorListener();
    await fromPart10Stream(input, listener, options);
    return listener.result;
}

/** Async generator that yields `chunkSize`-byte Uint8Array slices. */
async function* chunked(buffer, chunkSize) {
    const bytes =
        buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer;
    let offset = 0;
    while (offset < bytes.length) {
        yield bytes.slice(offset, Math.min(offset + chunkSize, bytes.length));
        offset += chunkSize;
    }
}

// ---------------------------------------------------------------------------
// Test 1: Single-chunk ArrayBuffer input
// ---------------------------------------------------------------------------

describe("fromPart10Stream — single-chunk ArrayBuffer input", () => {
    test.each([
        ["explicit-LE scalars", FIXTURE_ELE],
        ["encapsulated JPEG single-frame", FIXTURE_ENC]
    ])("%s: events deep-equal buffered fromPart10", async (_label, rel) => {
        const buffer = readBuffer(rel);
        const expected = await runBuffered(buffer.slice(0));
        const actual = await runStream(buffer.slice(0)); // ArrayBuffer input

        const problems = [];
        compareSection(
            expected.meta || {},
            actual.meta || {},
            "meta",
            problems
        );
        compareSection(
            expected.dict || {},
            actual.dict || {},
            "dict",
            problems
        );
        expect(problems).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// Test 2: AsyncIterable input (37-byte chunks)
// ---------------------------------------------------------------------------

describe("fromPart10Stream — AsyncIterable<Uint8Array> input (37-byte chunks)", () => {
    test.each([
        ["explicit-LE scalars", FIXTURE_ELE],
        ["encapsulated JPEG single-frame", FIXTURE_ENC]
    ])("%s: events deep-equal buffered fromPart10", async (_label, rel) => {
        const buffer = readBuffer(rel);
        const expected = await runBuffered(buffer.slice(0));
        const actual = await runStream(chunked(buffer.slice(0), 37));

        const problems = [];
        compareSection(
            expected.meta || {},
            actual.meta || {},
            "meta",
            problems
        );
        compareSection(
            expected.dict || {},
            actual.dict || {},
            "dict",
            problems
        );
        expect(problems).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// Test 3: ReadableStream input (1024-byte chunks)
// Skipped gracefully if ReadableStream is not available in the test env.
// ---------------------------------------------------------------------------

const HAS_READABLE_STREAM = typeof ReadableStream !== "undefined";

describe("fromPart10Stream — ReadableStream input (1024-byte chunks)", () => {
    const maybeTest = HAS_READABLE_STREAM ? test : test.skip;

    maybeTest(
        "explicit-LE scalars: events deep-equal buffered fromPart10",
        async () => {
            const buffer = readBuffer(FIXTURE_ELE);
            const expected = await runBuffered(buffer.slice(0));

            const bytes = new Uint8Array(buffer.slice(0));
            const stream = new ReadableStream({
                start(controller) {
                    const chunkSize = 1024;
                    let offset = 0;
                    while (offset < bytes.length) {
                        controller.enqueue(
                            bytes.slice(
                                offset,
                                Math.min(offset + chunkSize, bytes.length)
                            )
                        );
                        offset += chunkSize;
                    }
                    controller.close();
                }
            });

            const actual = await runStream(stream);

            const problems = [];
            compareSection(
                expected.meta || {},
                actual.meta || {},
                "meta",
                problems
            );
            compareSection(
                expected.dict || {},
                actual.dict || {},
                "dict",
                problems
            );
            expect(problems).toEqual([]);
        }
    );
});

// ---------------------------------------------------------------------------
// Test 4: Re-runnability via DicomEventStream.fromPart10Stream factory
// ---------------------------------------------------------------------------

describe("fromPart10Stream — re-runnability (DicomEventStream.fromPart10Stream)", () => {
    test("buffer input: two .process() calls both succeed and agree", async () => {
        const buffer = readBuffer(FIXTURE_ELE);
        const events = DicomEventStream.fromPart10Stream(buffer.slice(0));

        const a = new CollectorListener();
        await events.process(a);

        const b = new CollectorListener();
        await events.process(b); // second run — must succeed

        const problems = [];
        compareSection(
            a.result.meta || {},
            b.result.meta || {},
            "meta",
            problems
        );
        compareSection(
            a.result.dict || {},
            b.result.dict || {},
            "dict",
            problems
        );
        expect(problems).toEqual([]);
    });

    test("generator input: second .process() call rejects with consumed error", async () => {
        const buffer = readBuffer(FIXTURE_ELE);
        // Passing an AsyncIterable — consumed on first use.
        const events = DicomEventStream.fromPart10Stream(
            chunked(buffer.slice(0), 37)
        );

        const a = new CollectorListener();
        await events.process(a); // first run succeeds

        const b = new CollectorListener();
        await expect(events.process(b)).rejects.toThrow(
            /already been consumed/
        );
    });
});

// ---------------------------------------------------------------------------
// Test 5: options threading — forceStoreRaw=true
// ---------------------------------------------------------------------------

/**
 * CollectorListener subclass that also captures the rawValue option from
 * each `value(v, { rawValue })` event.  The standard CollectorListener only
 * retains `v`; this variant exposes `._rawValues` for inspection.
 */
class RawValueCollectorListener extends CollectorListener {
    constructor() {
        super();
        this._rawValues = [];
    }

    /** Overrides _baseValue so rawValue from the options bag is captured. */
    _baseValue(v, opts = {}) {
        super._baseValue(v);
        this._rawValues.push(opts?.rawValue);
    }
}

describe("fromPart10Stream — options threading (forceStoreRaw)", () => {
    test("forceStoreRaw=true produces same rawValues as buffered fromPart10", async () => {
        const buffer = readBuffer(FIXTURE_ELE);
        const opts = { forceStoreRaw: true };

        const bufferedListener = new RawValueCollectorListener();
        await fromPart10(buffer.slice(0), bufferedListener, opts);

        const streamListener = new RawValueCollectorListener();
        await fromPart10Stream(buffer.slice(0), streamListener, opts);

        // Same number of value events.
        expect(streamListener._rawValues.length).toBe(
            bufferedListener._rawValues.length
        );
        // Emitted at least some values (sanity).
        expect(streamListener._rawValues.length).toBeGreaterThan(0);

        // rawValues match element-by-element.
        const problems = [];
        for (let i = 0; i < bufferedListener._rawValues.length; i++) {
            deepCompare(
                bufferedListener._rawValues[i],
                streamListener._rawValues[i],
                `rawValues[${i}]`,
                problems
            );
        }
        expect(problems).toEqual([]);

        // At least some rawValues must be non-undefined: forceStoreRaw took effect.
        expect(streamListener._rawValues.some(v => v !== undefined)).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Test 6: Invalid input rejection (TypeError)
// ---------------------------------------------------------------------------

describe("fromPart10Stream — invalid input rejection", () => {
    test.each([
        ["plain number", 42],
        ["plain object", {}],
        ["string", "not a buffer"],
        ["null", null],
        ["undefined", undefined]
    ])("%s: rejects with TypeError", async (_label, invalidInput) => {
        const listener = new CollectorListener();
        await expect(
            fromPart10Stream(invalidInput, listener)
        ).rejects.toThrow(TypeError);
    });
});

// ---------------------------------------------------------------------------
// K2 Test 7: FMI events arrive before input is complete (streaming gate)
//
// This is the key RED test for K2: the K1 placeholder buffers all bytes
// before emitting any events, so the test fails with K1.  K2's incremental
// FMI parser emits startFileMetaInformation / endFileMetaInformation while
// the body bytes are still blocked behind a gate promise.
// ---------------------------------------------------------------------------

/**
 * A minimal EventStreamListener subclass that records which top-level
 * bracket events have been delivered.  Only the names we care about for
 * the gate check are tracked; all other callbacks are no-ops.
 *
 * Also resolves `fmiComplete` promise when endFileMetaInformation is called,
 * allowing tests to await deterministically instead of using flaky timers.
 */
class BracketTrackingListener {
    constructor() {
        this.received = [];
        this.fmiComplete = new Promise(resolve => {
            this._resolveFmiComplete = resolve;
        });
    }
    startDataSet() {
        this.received.push("startDataSet");
    }
    endDataSet() {
        this.received.push("endDataSet");
    }
    startFileMetaInformation() {
        this.received.push("startFileMetaInformation");
    }
    endFileMetaInformation() {
        this.received.push("endFileMetaInformation");
        // Signal that FMI parsing is complete, allowing deterministic test gating.
        this._resolveFmiComplete();
    }
    // EventStreamListener contract — no-ops for the gate check
    startElement() {}
    endElement() {}
    value() {}
    startBinary() {}
    binaryFragment() {}
    endBinary() {}
    startSequence() {}
    endSequence() {}
    startItem() {}
    endItem() {}
    awaitDrain() {}
}

describe("fromPart10Stream — K2: FMI events before input completes", () => {
    test(
        "startFileMetaInformation + endFileMetaInformation arrive while body is gated",
        async () => {
            const buffer = readBuffer(FIXTURE_ELE);
            const bytes = new Uint8Array(buffer);

            // CT1_UNC.explicit_little_endian.dcm FMI ends at ~334 bytes.
            // Yielding the first 400 bytes covers the entire FMI group.
            const FMI_SAFE_BOUNDARY = 400;

            let unblockBody;
            const bodyGate = new Promise(resolve => {
                unblockBody = resolve;
            });

            async function* gatingIterable() {
                // Chunk 1: covers preamble + FMI
                yield bytes.slice(0, FMI_SAFE_BOUNDARY);
                // Block until the test releases the gate
                await bodyGate;
                // Chunk 2: rest of the file
                yield bytes.slice(FMI_SAFE_BOUNDARY);
            }

            const listener = new BracketTrackingListener();
            const parsePromise = fromPart10Stream(gatingIterable(), listener);

            // Await completion of FMI parsing deterministically.
            // The listener resolves fmiComplete when endFileMetaInformation is called.
            // Use a generous timeout that FAILS the test rather than passing vacuously
            // if FMI parsing stalls.
            const fmiTimeout = new Promise((_, reject) =>
                setTimeout(() => reject(new Error("FMI parsing timeout")), 10000)
            );
            await Promise.race([listener.fmiComplete, fmiTimeout]);

            // K2 assertion: FMI bracket events must have been delivered
            // BEFORE the body gate is released.
            expect(listener.received).toContain("startFileMetaInformation");
            expect(listener.received).toContain("endFileMetaInformation");

            // Release the body gate and let the parse finish.
            unblockBody();
            await parsePromise;
        }
    );
});

// ---------------------------------------------------------------------------
// K2 Test 8: No-meta-length fixture equivalence through the stream path
//
// test/no-meta-length-test.dcm lacks (0002,0000) FileMetaInformationGroupLength.
// The stream path must handle the fallback (stop-on-group-change) correctly
// and produce events equivalent to the buffered fromPart10 path.
// ---------------------------------------------------------------------------

const FIXTURE_NO_META_LEN = "test/no-meta-length-test.dcm";

describe("fromPart10Stream — K2: no-group-length FMI fixture", () => {
    test.each([
        ["single chunk", buffer => buffer],
        ["37-byte chunks", buffer => chunked(buffer, 37)]
    ])(
        "%s: events deep-equal buffered fromPart10",
        async (_label, toInput) => {
            const buffer = readBuffer(FIXTURE_NO_META_LEN);
            const expected = await runBuffered(buffer.slice(0));
            const actual = await runStream(toInput(buffer.slice(0)));

            const problems = [];
            compareSection(
                expected.meta || {},
                actual.meta || {},
                "meta",
                problems
            );
            compareSection(
                expected.dict || {},
                actual.dict || {},
                "dict",
                problems
            );
            expect(problems).toEqual([]);
        }
    );
});

// ---------------------------------------------------------------------------
// K2 Test 9: Raw-dataset / DICM-less error parity
//
// A byte array that is neither a valid Part 10 file (no DICM marker, no 0002
// group) nor a parseable raw DICOM dataset must fail with an error of the
// same class as buffered fromPart10.  Exact message parity with @dcmjs/parser
// is not required (documented delta: early detection in fromPart10Stream may
// produce a different message; see task-K2-report.md).
// ---------------------------------------------------------------------------

describe("fromPart10Stream — K2: raw-dataset / DICM-less error parity", () => {
    test("completely invalid bytes: same error class as buffered fromPart10", async () => {
        // 64 zero bytes — not a valid DICOM file, not starting with 0002 group.
        const badBytes = new Uint8Array(64).buffer;

        let bufferedError;
        try {
            const listener = new CollectorListener();
            await fromPart10(badBytes, listener);
        } catch (e) {
            bufferedError = e;
        }

        let streamError;
        try {
            const listener = new CollectorListener();
            await fromPart10Stream(badBytes, listener);
        } catch (e) {
            streamError = e;
        }

        // Both must throw
        expect(bufferedError).toBeDefined();
        expect(streamError).toBeDefined();

        // Same error class
        expect(streamError.constructor).toBe(bufferedError.constructor);
    });
});

// ===========================================================================
// K3 TESTS — Written first (RED) before K3 implementation. K2's Phase 4 is
// still the buffered-body placeholder; these tests must FAIL until the K3
// incremental body loop replaces it.
// ===========================================================================

// ---------------------------------------------------------------------------
// K3 Test 10: Body events arrive before input is complete (KEY RED TEST)
//
// The K2 placeholder buffers all body bytes before emitting any body events,
// so the first body element event arrives only AFTER the full file is fed.
// K3's incremental body loop must emit body element events as bytes arrive,
// BEFORE the body tail bytes are released.
//
// Mechanism: gating async generator releases FMI + first body bytes (up to
// a safe boundary well past the first body element), then blocks.  The test
// awaits a listener promise that resolves on the FIRST body element event.
// This must resolve before the gate is released.
// ---------------------------------------------------------------------------

/**
 * Listener subclass that tracks the first non-FMI body element event.
 * Resolves `firstBodyElement` promise (with the tag string) the first time
 * startElement() is called after endFileMetaInformation().
 * Extends BracketTrackingListener so it satisfies the full event contract.
 */
class BodyGateListener extends BracketTrackingListener {
    constructor() {
        super();
        this._pastFmi = false;
        this._bodyStarted = false;
        this.firstBodyElement = new Promise(resolve => {
            this._resolveFirstBody = resolve;
        });
    }
    endFileMetaInformation() {
        super.endFileMetaInformation();
        this._pastFmi = true;
    }
    startElement(tag) {
        if (this._pastFmi && !this._bodyStarted) {
            this._bodyStarted = true;
            this._resolveFirstBody(tag);
        }
    }
}

describe("fromPart10Stream — K3: body events before input completes", () => {
    test(
        "first body element event arrives while body tail is gated (incremental gate)",
        async () => {
            const buffer = readBuffer(FIXTURE_ELE);
            const bytes = new Uint8Array(buffer);

            // CT1_UNC.explicit_little_endian.dcm:
            //   FMI ends at ~334 bytes; first body element (0008,0005 or 0008,0008)
            //   header + value fits well within the first 600 bytes.
            // We yield the first 600 bytes (covering FMI + a few body elements),
            // then gate on a promise before yielding the tail.
            const BODY_PARTIAL_BOUNDARY = 600;

            let unblockTail;
            const tailGate = new Promise(resolve => {
                unblockTail = resolve;
            });

            async function* gatingIterable() {
                // Chunk 1: preamble + FMI + first few body elements
                yield bytes.slice(0, BODY_PARTIAL_BOUNDARY);
                // Block until the test releases the gate
                await tailGate;
                // Chunk 2: rest of the file
                yield bytes.slice(BODY_PARTIAL_BOUNDARY);
            }

            const listener = new BodyGateListener();
            const parsePromise = fromPart10Stream(gatingIterable(), listener);

            // Await the first body element deterministically (with timeout).
            const bodyTimeout = new Promise((_, reject) =>
                setTimeout(
                    () => reject(new Error("First body element timeout — K3 body loop not incremental")),
                    10000
                )
            );
            const firstBodyTag = await Promise.race([
                listener.firstBodyElement,
                bodyTimeout
            ]);

            // K3 assertion: a body element arrived before the tail was released.
            expect(typeof firstBodyTag).toBe("string");
            expect(firstBodyTag.length).toBe(8); // "GGGGEEEE" format

            // Release the tail and finish.
            unblockTail();
            await parsePromise;
        }
    );
});

// ---------------------------------------------------------------------------
// K3 Test 11: Native-path assertion via options.onPhase spy
//
// For corpus fixtures without undefined-length body elements and non-deflate
// transfer syntax, the K3 incremental body loop must report "native" via
// options.onPhase.  K2 never calls onPhase, so this test is RED until K3
// wires the hook.
// ---------------------------------------------------------------------------

describe("fromPart10Stream — K3: native-path assertion (onPhase spy)", () => {
    test(
        "FIXTURE_ELE (defined-length explicit-LE): onPhase called with 'native'",
        async () => {
            const buffer = readBuffer(FIXTURE_ELE);
            const phases = [];
            const listener = new CollectorListener();
            await fromPart10Stream(buffer.slice(0), listener, {
                onPhase: phase => phases.push(phase)
            });
            // Native incremental path must report "native"; neither "tailFallback"
            // nor "deflate" should appear for this well-formed defined-length fixture.
            expect(phases).toContain("native");
            expect(phases).not.toContain("tailFallback");
            expect(phases).not.toContain("deflate");
        }
    );
});

// ---------------------------------------------------------------------------
// K3 Test 12: Truncation error parity
//
// A defined-length element whose value extends past EOF must cause both the
// buffered (fromPart10) path and the K3 stream path to throw.  Both must
// throw — exact error class parity is documented as impractical (buffered
// path throws a plain object; K3 incremental path throws an Error).
// See task-K3-report.md §truncation-delta for the documented delta.
// ---------------------------------------------------------------------------

describe("fromPart10Stream — K3: truncation error parity", () => {
    test(
        "truncated body element: both buffered and stream paths throw",
        async () => {
            // Build a valid-looking DICOM Part 10 file where the body contains
            // one explicit-LE element (0008,0010 LO, length=256) but only 4 bytes
            // of value data are present (truncated).
            const w = new DataView(new ArrayBuffer(512));
            let off = 0;
            const setU8 = (pos, v) => w.setUint8(pos, v);
            const setU16 = (pos, v) => w.setUint16(pos, v, true);
            const setU32 = (pos, v) => w.setUint32(pos, v, true);

            // Preamble (128 bytes = zeros) + DICM
            off = 128;
            setU8(off, 0x44); setU8(off+1, 0x49);
            setU8(off+2, 0x43); setU8(off+3, 0x4d);
            off = 132;

            // (0002,0000) UL 4 bytes: FileMetaInformationGroupLength
            const fmiGroupLenPos = off;
            setU16(off, 0x0002); setU16(off+2, 0x0000); off += 4;
            setU8(off, 0x55); setU8(off+1, 0x4c); off += 2; // "UL"
            setU16(off, 4); off += 2;
            const fmiGroupLenValPos = off;
            setU32(off, 0); off += 4; // placeholder

            // (0002,0001) OB [0,1]
            setU16(off, 0x0002); setU16(off+2, 0x0001); off += 4;
            setU8(off, 0x4f); setU8(off+1, 0x42); off += 2; // "OB"
            setU16(off, 0x0000); off += 2; // reserved
            setU32(off, 2); off += 4;
            setU8(off, 0); setU8(off+1, 1); off += 2;

            // (0002,0010) UI "1.2.840.10008.1.2.1\0"
            const tsUid = "1.2.840.10008.1.2.1\0";
            setU16(off, 0x0002); setU16(off+2, 0x0010); off += 4;
            setU8(off, 0x55); setU8(off+1, 0x49); off += 2; // "UI"
            setU16(off, tsUid.length); off += 2;
            for (let i = 0; i < tsUid.length; i++) { setU8(off+i, tsUid.charCodeAt(i)); }
            off += tsUid.length;

            // Fill in (0002,0000) value
            setU32(fmiGroupLenValPos, off - (fmiGroupLenValPos + 4));

            // Body: (0008,0010) LO length=256, only 4 bytes present (truncated)
            setU16(off, 0x0008); setU16(off+2, 0x0010); off += 4;
            setU8(off, 0x4c); setU8(off+1, 0x4f); off += 2; // "LO"
            setU16(off, 256); off += 2; // claims 256 bytes
            setU32(off, 0); off += 4; // only 4 bytes of value — truncated

            const truncBuffer = w.buffer.slice(0, off);

            let bufferedError;
            try {
                const listener = new CollectorListener();
                await fromPart10(truncBuffer.slice(0), listener);
            } catch (e) {
                bufferedError = e;
            }

            let streamError;
            try {
                const listener = new CollectorListener();
                await fromPart10Stream(truncBuffer.slice(0), listener);
            } catch (e) {
                streamError = e;
            }

            // Both must throw (exact class parity is impractical — see K3 report).
            expect(bufferedError).toBeDefined();
            expect(streamError).toBeDefined();
        }
    );
});

// ---------------------------------------------------------------------------
// K3 Test 13: Synthesized defined-length SQ equivalence
//
// Build a tiny Part 10 file in memory containing a defined-length SQ with
// two items (one with one child element, one empty), then verify that
// streaming in 37-byte chunks produces events identical to the buffered path.
//
// The synthesized file uses Explicit Little Endian throughout.
// Building helper: DicomWriter — a minimal in-memory byte writer
// that does not import any dcmjs code (pure byte manipulation).
// ---------------------------------------------------------------------------

/**
 * Minimal in-memory byte builder for synthesized DICOM test files.
 * No dcmjs dependency — pure ArrayBuffer + DataView manipulation.
 */
class DicomWriter {
    constructor() {
        this._parts = [];
        this._total = 0;
    }
    _push(arr) {
        this._parts.push(arr);
        this._total += arr.length;
    }
    zeros(n) {
        this._push(new Uint8Array(n));
    }
    u16(v) {
        const a = new Uint8Array(2);
        new DataView(a.buffer).setUint16(0, v, true);
        this._push(a);
    }
    u32(v) {
        const a = new Uint8Array(4);
        new DataView(a.buffer).setUint32(0, v, true);
        this._push(a);
    }
    ascii(s) {
        const a = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
        this._push(a);
    }
    /** Write explicit-LE element with 2-byte length (standard VR). */
    elemStd(group, element, vr, valueBytes) {
        this.u16(group);
        this.u16(element);
        this.ascii(vr);
        this.u16(valueBytes.length);
        this._push(valueBytes);
    }
    /** Write explicit-LE element with 32-bit length (OB/OW/SQ/UN/OD/…). */
    elemLong(group, element, vr, valueBytes) {
        this.u16(group);
        this.u16(element);
        this.ascii(vr);
        this.u16(0); // reserved
        this.u32(valueBytes.length);
        this._push(valueBytes);
    }
    toUint8Array() {
        const out = new Uint8Array(this._total);
        let off = 0;
        for (const p of this._parts) {
            out.set(p, off);
            off += p.length;
        }
        return out;
    }
    toArrayBuffer() {
        return this.toUint8Array().buffer;
    }
}

/**
 * Build a synthesized Part 10 file (Explicit Little Endian) containing:
 *   - Standard Part 10 preamble + DICM marker
 *   - Minimal FMI: (0002,0000) UL, (0002,0001) OB, (0002,0010) UI = ELE
 *   - Body: (0008,0060) CS = "CT"
 *           (0008,1115) SQ with 2 defined-length items:
 *               Item 1: (0008,0060) CS = "MR"
 *               Item 2: (empty)
 */
function buildSyntheticSQFile() {
    // --- Item 1: contains (0008,0060) CS "MR" ---
    const item1Child = new DicomWriter();
    item1Child.elemStd(0x0008, 0x0060, "CS", new Uint8Array([0x4d, 0x52])); // "MR"
    const item1Content = item1Child.toUint8Array();

    const item1 = new DicomWriter();
    item1.u16(0xfffe); item1.u16(0xe000); // FFFE,E000
    item1.u32(item1Content.length);
    item1._push(item1Content);

    // --- Item 2: empty ---
    const item2 = new DicomWriter();
    item2.u16(0xfffe); item2.u16(0xe000);
    item2.u32(0);

    // --- SQ value bytes ---
    const sqContent = new DicomWriter();
    sqContent._push(item1.toUint8Array());
    sqContent._push(item2.toUint8Array());
    const sqBytes = sqContent.toUint8Array();

    // --- Body ---
    const body = new DicomWriter();
    body.elemStd(0x0008, 0x0060, "CS", new Uint8Array([0x43, 0x54])); // "CT"
    body.elemLong(0x0008, 0x1115, "SQ", sqBytes);
    const bodyBytes = body.toUint8Array();

    // --- FMI parts ---
    const fmiOB = new DicomWriter();
    fmiOB.elemLong(0x0002, 0x0001, "OB", new Uint8Array([0, 1]));

    const tsStr = "1.2.840.10008.1.2.1\0";
    const fmiTS = new DicomWriter();
    fmiTS.elemStd(
        0x0002, 0x0010, "UI",
        new Uint8Array(tsStr.split("").map(c => c.charCodeAt(0)))
    );

    const restFmiLen = fmiOB.toUint8Array().length + fmiTS.toUint8Array().length;
    const glBytes = new Uint8Array(4);
    new DataView(glBytes.buffer).setUint32(0, restFmiLen, true);
    const fmiGL = new DicomWriter();
    fmiGL.elemStd(0x0002, 0x0000, "UL", glBytes);

    // --- Assemble ---
    const file = new DicomWriter();
    file.zeros(128); // preamble
    file.ascii("DICM");
    file._push(fmiGL.toUint8Array());
    file._push(fmiOB.toUint8Array());
    file._push(fmiTS.toUint8Array());
    file._push(bodyBytes);
    return file.toArrayBuffer();
}

describe("fromPart10Stream — K3: synthesized defined-length SQ equivalence", () => {
    test(
        "SQ with two defined-length items (37-byte chunks): events match buffered",
        async () => {
            const buffer = buildSyntheticSQFile();
            const expected = await runBuffered(buffer.slice(0));
            const actual = await runStream(chunked(buffer.slice(0), 37));

            const problems = [];
            compareSection(expected.meta || {}, actual.meta || {}, "meta", problems);
            compareSection(expected.dict || {}, actual.dict || {}, "dict", problems);
            expect(problems).toEqual([]);
        }
    );

    test(
        "SQ with two defined-length items (single chunk): events match buffered",
        async () => {
            const buffer = buildSyntheticSQFile();
            const expected = await runBuffered(buffer.slice(0));
            const actual = await runStream(buffer.slice(0));

            const problems = [];
            compareSection(expected.meta || {}, actual.meta || {}, "meta", problems);
            compareSection(expected.dict || {}, actual.dict || {}, "dict", problems);
            expect(problems).toEqual([]);
        }
    );
});
