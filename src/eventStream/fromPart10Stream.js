/**
 * src/eventStream/fromPart10Stream.js
 *
 * fromPart10Stream — chunked bytes → events source (slice K, stage 2).
 *
 * This is the public entry point for the bounded-memory streaming path.
 * Input is normalized into an AsyncIterable and fed into a ReadBufferStream
 * concurrently with parsing.
 *
 * Stage K2 makes the **preamble + File Meta Information phase** genuinely
 * incremental: FMI elements are decoded on-the-fly as bytes arrive, so
 * `startFileMetaInformation` / per-element events / `endFileMetaInformation`
 * are emitted before the body bytes have finished streaming.
 *
 * The **body phase** still buffers fully this stage (K1 approach delegated to
 * fromPart10 with `_skipMeta:true`). Stages K3+ will make the body
 * incremental as well.
 *
 * Decision D-E (noCopy) and the clearBuffers=false choice for K2:
 * We keep all bytes in the stream buffer so that the full byte array can be
 * passed to fromPart10 for the body phase after FMI is parsed.  K3+ will
 * switch to clearBuffers=true and consume() as data is parsed.
 */

import { ReadBufferStream } from "../BufferStream.js";
import { fromPart10 } from "./fromPart10.js";
import { EXPLICIT_LITTLE_ENDIAN } from "../constants/dicom.js";
import { DicomMessage } from "../DicomMessage.js";
import { ValueRepresentation } from "../ValueRepresentation.js";
import { resolveVrInstance, decodeElementValues } from "../core/decodeCore.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * fromPart10Stream — parse a chunked DICOM Part 10 byte source into events.
 *
 * Accepted `input` forms (all normalized to AsyncIterable internally):
 *
 *   1. `ArrayBuffer | Uint8Array`
 *      Degenerate single-chunk input. Re-runnable: each call starts fresh.
 *
 *   2. `AsyncIterable<Uint8Array | ArrayBuffer | Buffer>`
 *      Streamed chunks (async generators, Node.js Readable streams in
 *      object mode, etc.). Single-use: the iterator is exhausted on the
 *      first call and cannot be rewound.
 *
 *   3. WHATWG `ReadableStream`
 *      Adapted to AsyncIterable via `Symbol.asyncIterator` (Node ≥ 16.14).
 *      A reader-loop fallback is provided for environments where ReadableStream
 *      does not implement AsyncIterable (older browsers / Node builds). No
 *      additional dependencies are required.
 *
 * NOTE — `noCopy` is intentionally NOT accepted. The streaming source forces
 * noCopy semantics OFF because zero-copy views alias chunk memory that
 * `consume()` releases when the incremental loop (K3-K5) is in place
 * (decision D-E). Callers that need zero-copy must use the buffered
 * `fromPart10` directly.
 *
 * @param {ArrayBuffer|Uint8Array|AsyncIterable|ReadableStream} input
 * @param {import("./EventStreamListener").EventStreamListener} listener
 * @param {Object} [options]
 * @param {boolean} [options.forceStoreRaw]   Thread to the decode core.
 * @param {boolean} [options.ignoreErrors]    Thread to the decode core.
 * @returns {Promise<void>}
 */
export async function fromPart10Stream(input, listener, options = {}) {
    const iterable = normalizeInput(input);

    // K2: clearBuffers:false — all bytes are retained so the full byte
    // array can be passed to fromPart10 for the body phase.
    // K3+ will switch to clearBuffers:true + consume() as segments complete.
    const stream = new ReadBufferStream(null, true, { clearBuffers: false });

    // Feed runs unawaited so the FMI parse can proceed concurrently.
    let feedError = null;
    const feedPromise = (async () => {
        try {
            for await (const chunk of iterable) {
                stream.addBuffer(toArrayBuffer(chunk));
            }
            stream.setComplete();
        } catch (e) {
            feedError = e;
            // Unblock any stream.ensureAvailable() waiters so the parse
            // can observe the error and propagate it.
            stream.setComplete();
        }
    })();

    const policy = {
        forceStoreRaw: !!options.forceStoreRaw,
        noCopy: false,
        ignoreErrors: !!options.ignoreErrors
    };

    // ---- Phase 1: Preamble detection (incremental) ----
    //
    // Mirrors AsyncDicomReader.readPreamble() semantics:
    //   - "DICM" at bytes 128-131 → normal Part 10, advance to offset 132
    //   - First 2 bytes are group 0x0002 → PART10_NO_PREAMBLE, stay at 0
    //   - Neither → raw dataset / non-DICOM → delegate to buffered fromPart10
    //     (K2 placeholder for the raw-dataset path; exact error parity is
    //     guaranteed by delegation — see task-K2-report.md §error-parity).

    let rawDatasetFallback = false;

    // Wait for enough bytes to check the DICM marker (requires 132 bytes:
    // 128-byte preamble + 4-byte "DICM").  ensureAvailable resolves even
    // at EOF if bytes are insufficient (OR-complete semantics), so we
    // always re-check with isAvailable(N, false) after the await.
    await stream.ensureAvailable(132);

    if (stream.isAvailable(132, false)) {
        // We have at least 132 bytes — check for "DICM" at bytes 128-131.
        const hasDicm =
            stream.view.getUint8(128) === 0x44 && // D
            stream.view.getUint8(129) === 0x49 && // I
            stream.view.getUint8(130) === 0x43 && // C
            stream.view.getUint8(131) === 0x4d; //   M
        if (hasDicm) {
            // Normal Part 10: skip preamble + DICM marker.
            stream.offset = 132;
        } else {
            // No DICM — check whether the file starts with group 0x0002.
            const firstGroup = stream.view.getUint16(0, true); // LE
            if (firstGroup === 0x0002) {
                // PART10_NO_PREAMBLE: FMI starts at byte 0.
                stream.offset = 0;
            } else {
                rawDatasetFallback = true;
            }
        }
    } else {
        // Fewer than 132 bytes available (short stream or early EOF).
        // Try to at least check the 0x0002 group in the first 2 bytes.
        await stream.ensureAvailable(4);
        if (stream.isAvailable(2, false)) {
            const firstGroup = stream.view.getUint16(0, true); // LE
            if (firstGroup === 0x0002) {
                stream.offset = 0; // PART10_NO_PREAMBLE
            } else {
                rawDatasetFallback = true;
            }
        } else {
            rawDatasetFallback = true;
        }
    }

    if (rawDatasetFallback) {
        // K2 placeholder: raw datasets / non-DICOM input still uses the
        // fully-buffered K1 delegation path.  This guarantees exact error
        // parity with fromPart10 (which propagates the tokenizer's error
        // via seedReadContext) without requiring early message reconstruction.
        // K3+ may detect and short-circuit earlier.
        await feedPromise;
        if (feedError) throw feedError;
        const byteArray = new Uint8Array(stream.slice(0, stream.size));
        await fromPart10(byteArray.buffer, listener, options);
        return;
    }

    // ---- Phase 2: Incremental FMI parse ----
    //
    // FMI is always EXPLICIT_LITTLE_ENDIAN regardless of the body TS.
    // We accumulate decoded FMI elements (tag, VR, values, rawValues) into
    // a local array so that we can emit startDataSet *after* we know the
    // TransferSyntaxUID from (0002,0010) — the listener must receive
    // startDataSet with the correct TS before any FMI events.

    /** @type {Array<{tag:string, vrStr:string, length:number, values:any[], rawValues:any[]}>} */
    const fmiElements = [];
    let transferSyntaxUID = EXPLICIT_LITTLE_ENDIAN; // default if 0002,0010 absent

    // We need at least 8 bytes for the smallest possible FMI header.
    await stream.ensureAvailable(8);

    // Determine whether (0002,0000) FileMetaInformationGroupLength is present.
    // If present, we know the exact end-of-FMI offset; otherwise we stop
    // when the first non-0002 group tag appears (AsyncDicomReader.readMeta
    // §233–240 fallback).
    let metaEndOffset = null; // null → no fixed bound

    if (
        stream.isAvailable(8, false) &&
        stream.view.getUint16(stream.offset, true) === 0x0002 &&
        stream.view.getUint16(stream.offset + 2, true) === 0x0000
    ) {
        // (0002,0000) is present.  We'll parse it in the main loop below
        // and set metaEndOffset once we have the UL value.
        // (No special pre-read needed — the loop handles it uniformly.)
    }

    // ---- FMI element loop ----
    while (true) {
        // Fixed-bound termination: used when (0002,0000) was found.
        if (metaEndOffset !== null && stream.offset >= metaEndOffset) break;

        // Wait for enough bytes to read a minimal element header (8 bytes:
        // 4-byte tag + 2-byte VR + 2-byte length).  If the stream ends
        // before we get 8 bytes (unlikely for valid FMI), we stop.
        await stream.ensureAvailable(8);

        // EOF or insufficient data: stop FMI loop gracefully.
        if (!stream.isAvailable(4, false)) break;

        // Peek at the next element's group tag (LE uint16).
        // For the no-group-length fallback: stop as soon as group != 0x0002.
        const peekGroup = stream.view.getUint16(stream.offset, true);
        if (peekGroup !== 0x0002) break; // body starts here

        // Confirm we have at least a full 8-byte header before committing.
        if (!stream.isAvailable(8, false)) break;

        // ---- Read element header (Explicit Little Endian) ----
        const elGroup = stream.readUint16(); // always 0x0002
        const elElement = stream.readUint16();
        // Build DICOM clean tag string: "GGGGEEEE" (uppercase hex, 8 chars)
        const tagStr =
            elGroup.toString(16).padStart(4, "0").toUpperCase() +
            elElement.toString(16).padStart(4, "0").toUpperCase();

        // VR: 2 ASCII bytes
        const vrStr =
            String.fromCharCode(stream.view.getUint8(stream.offset)) +
            String.fromCharCode(stream.view.getUint8(stream.offset + 1));
        stream.offset += 2;

        // Length: 2 bytes (standard VR) or 2 reserved + 4 bytes (extended VR)
        let valueLength;
        // Resolve VR instance to determine header framing via isLength32()
        // createByTypeString handles invalid VR strings by falling back to UN.
        const vrForHeader = ValueRepresentation.createByTypeString(vrStr);
        if (vrForHeader.isLength32()) {
            // Extended form: need 2 more bytes (reserved) + 4 bytes (length32)
            await stream.ensureAvailable(6);
            if (!stream.isAvailable(6, false)) break; // truncated
            stream.offset += 2; // skip reserved (0x0000)
            valueLength = stream.readUint32();
        } else {
            // Standard form: length is already in the next 2 bytes
            await stream.ensureAvailable(2);
            if (!stream.isAvailable(2, false)) break; // truncated
            valueLength = stream.readUint16();
        }

        // Set metaEndOffset after reading the FileMetaInformationGroupLength
        // value (0002,0000) UL.  The bound is relative to the END of this
        // element (i.e., the first byte AFTER the UL value bytes).
        const isGroupLengthTag = elGroup === 0x0002 && elElement === 0x0000;

        // Wait for value bytes
        await stream.ensureAvailable(valueLength);

        if (!stream.isAvailable(valueLength, false)) {
            // Stream ended mid-value: best-effort stop (truncated FMI)
            break;
        }

        // Extract value bytes into a fresh ArrayBuffer (copy is acceptable
        // for FMI — FMI is at most a few hundred bytes).
        const valueStart = stream.offset;
        const valueAB = stream.slice(valueStart, valueStart + valueLength);

        // Build a minimal read window for decodeCore
        const fakeWindow = {
            arrayBuffer: valueAB,
            baseOffset: 0,
            syntax: EXPLICIT_LITTLE_ENDIAN,
            littleEndian: true,
            implicit: false,
            decoder: null
        };
        // elLike: the minimal shape decodeCore.resolveVrInstance and
        // decodeCore.decodeElementValues require.
        //   vr        — VR string (e.g. "UI", "UL", "OB")
        //   tagValue  — numeric tag (group << 16) | element, for UN dictionary lookup
        //   dataOffset — byte offset of value within the window.arrayBuffer
        //   length    — value byte count
        //   hadUndefinedLength — always false for FMI elements (PS3.5 §7.1)
        const elLike = {
            vr: vrStr,
            tagValue: (elGroup << 16) | elElement,
            dataOffset: 0,
            length: valueLength,
            hadUndefinedLength: false
        };

        const vrInstance = resolveVrInstance(elLike, fakeWindow);
        const { values, rawValues } = decodeElementValues(
            fakeWindow,
            elLike,
            vrInstance,
            policy
        );

        // Capture TransferSyntaxUID for startDataSet and body-phase delegation.
        // Matches seedReadContext's normalization via DicomMessage._normalizeSyntax.
        if (tagStr === "00020010" && values[0]) {
            transferSyntaxUID = DicomMessage._normalizeSyntax(values[0]);
        }

        // Set meta end offset from (0002,0000) FileMetaInformationGroupLength
        if (isGroupLengthTag && values[0] !== undefined) {
            // values[0] is the UL integer: bytes after THIS element
            metaEndOffset = valueStart + valueLength + values[0];
        }

        fmiElements.push({
            tag: tagStr,
            vrStr,
            length: valueLength,
            values,
            rawValues
        });

        // Advance stream past the value bytes
        stream.offset = valueStart + valueLength;
    }

    // ---- Phase 3: Emit collected FMI events ----
    //
    // Now that we know the TransferSyntaxUID we can emit startDataSet with
    // the correct TS before the FMI bracket and element events.

    listener.startDataSet({ transferSyntaxUID });

    if (fmiElements.length > 0) {
        listener.startFileMetaInformation();
        for (const el of fmiElements) {
            emitFmiElement(listener, el);
        }
        listener.endFileMetaInformation();
    }

    // ---- Phase 4: Body phase (K2 placeholder — still buffered) ----
    //
    // Wait for all remaining bytes, then pass the full byte array to
    // fromPart10 with _skipMeta:true so it emits only the body elements
    // (skipping startDataSet, FMI, and endDataSet — all handled above/below).
    //
    // K3+ will replace this block with an incremental body walk.
    await feedPromise;
    if (feedError) throw feedError;

    const byteArray = new Uint8Array(stream.slice(0, stream.size));
    await fromPart10(byteArray.buffer, listener, {
        ...options,
        _skipMeta: true
    });

    listener.endDataSet();
}

// ---------------------------------------------------------------------------
// FMI element emission
// ---------------------------------------------------------------------------

/**
 * Emit a single FMI element's events into `listener`.
 *
 * Mirrors fromPart10's `emitValues` logic:
 *   - Buffer-valued VRs (OB, OW, OD, …) → startBinary / binaryFragment / endBinary
 *   - Everything else → one or more value() calls
 *
 * FMI elements are never sequences (SQ) or undefined-length elements, so
 * those branches from the full emitElement are not needed here.
 */
function emitFmiElement(listener, el) {
    const { tag, vrStr, length, values, rawValues } = el;

    const hasBuffer = values.some(
        v => v instanceof ArrayBuffer || ArrayBuffer.isView(v)
    );

    listener.startElement(tag, { vr: vrStr, length });

    if (hasBuffer) {
        listener.startBinary({ encapsulated: false });
        for (const buf of values) {
            listener.binaryFragment(buf);
        }
        listener.endBinary();
    } else {
        let index = 0;
        for (const v of values) {
            listener.value(v, { index, rawValue: rawValues[index] });
            index++;
        }
    }

    listener.endElement();
}

// ---------------------------------------------------------------------------
// Input normalization
// ---------------------------------------------------------------------------

/**
 * Normalize `input` to an `AsyncIterable<Uint8Array | ArrayBuffer>`.
 *
 * Dispatch order:
 *   1. ArrayBuffer / TypedArray  → single-item async iterable
 *   2. WHATWG ReadableStream     → AsyncIterable (native) or reader-loop adapter
 *   3. AsyncIterable (generator, etc.) → returned as-is
 *
 * @param {*} input
 * @returns {AsyncIterable<Uint8Array|ArrayBuffer>}
 */
function normalizeInput(input) {
    // Case 1: flat buffer — degenerate single-chunk
    if (input instanceof ArrayBuffer || ArrayBuffer.isView(input)) {
        return singleChunkIterable(input);
    }

    // Case 2: WHATWG ReadableStream
    if (isWhatwgReadableStream(input)) {
        // Modern Node (≥ 16.14) and modern browsers expose Symbol.asyncIterator
        // on ReadableStream natively — use it directly.
        if (Symbol.asyncIterator in input) {
            return input;
        }
        // Fallback for environments where ReadableStream is defined but not
        // yet AsyncIterable (older browsers, certain polyfills).
        return readableStreamToAsyncIterable(input);
    }

    // Case 3: AsyncIterable (async generators, Node.js streams, etc.)
    if (input != null && typeof input[Symbol.asyncIterator] === "function") {
        return input;
    }

    throw new TypeError(
        "fromPart10Stream: `input` must be an ArrayBuffer, Uint8Array, " +
            "AsyncIterable<Uint8Array|ArrayBuffer>, or a WHATWG ReadableStream. " +
            `Got: ${Object.prototype.toString.call(input)}`
    );
}

/** True if `input` is a WHATWG ReadableStream (works in browser and Node). */
function isWhatwgReadableStream(input) {
    return (
        typeof ReadableStream !== "undefined" && input instanceof ReadableStream
    );
}

/** Single-item async iterable that yields `buffer` as a Uint8Array chunk. */
async function* singleChunkIterable(buffer) {
    yield buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
}

/**
 * Adapter: wrap a WHATWG ReadableStream in an async generator for
 * environments where the stream does not implement Symbol.asyncIterator.
 * This is dependency-free and works in both browser and Node.
 */
async function* readableStreamToAsyncIterable(stream) {
    const reader = stream.getReader();
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            yield value;
        }
    } finally {
        reader.releaseLock();
    }
}

// ---------------------------------------------------------------------------
// Chunk helpers
// ---------------------------------------------------------------------------

/**
 * Coerce a chunk from the async iterable to an ArrayBuffer for
 * `stream.addBuffer()`. Handles Uint8Array, Buffer (Node), other typed
 * arrays, and plain ArrayBuffers.
 *
 * @param {Uint8Array|ArrayBuffer} chunk
 * @returns {ArrayBuffer}
 */
function toArrayBuffer(chunk) {
    if (chunk instanceof ArrayBuffer) return chunk;
    if (ArrayBuffer.isView(chunk)) {
        // Typed array (Uint8Array, Buffer, etc.): slice to own ArrayBuffer.
        return chunk.buffer.slice(
            chunk.byteOffset,
            chunk.byteOffset + chunk.byteLength
        );
    }
    throw new TypeError(
        `fromPart10Stream: expected Uint8Array|ArrayBuffer chunk from iterable, ` +
            `got ${Object.prototype.toString.call(chunk)}`
    );
}
