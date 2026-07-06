/**
 * test/eventStream/fromPart10Stream.test.js
 *
 * TDD suite for fromPart10Stream (slice K, stage 1).
 * Tests are written FIRST; they are expected to be RED until the
 * implementation is in place.
 *
 * Five test groups (per the brief):
 *   1. Single-chunk ArrayBuffer input
 *   2. AsyncIterable<Uint8Array> input (37-byte chunks)
 *   3. ReadableStream input (1024-byte chunks; skipped if ReadableStream absent)
 *   4. Re-runnability contract via DicomEventStream.fromPart10Stream factory
 *   5. options threading: forceStoreRaw=true produces rawValue-bearing events
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
