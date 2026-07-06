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
import { fromPart10, emitValues } from "./fromPart10.js";
import {
    EXPLICIT_LITTLE_ENDIAN,
    EXPLICIT_BIG_ENDIAN,
    IMPLICIT_LITTLE_ENDIAN,
    DEFLATED_EXPLICIT_LITTLE_ENDIAN
} from "../constants/dicom.js";
import { DicomMessage } from "../DicomMessage.js";
import { ValueRepresentation } from "../ValueRepresentation.js";
import {
    resolveVrInstance,
    decodeElementValues,
    decodeWithEagerReadTag,
    isParsedUnknownVr,
    resolveCharacterSet
} from "../core/decodeCore.js";

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

    // K4: clearBuffers:true — the incremental body loop consume()s each
    // completed top-level element, so chunk memory is released as the parse
    // advances (bounded-memory streaming). The deflate and raw-dataset
    // fallbacks run BEFORE any consume() and slice the full retained buffer,
    // so they are unaffected by the flag.
    const stream = new ReadBufferStream(null, true, { clearBuffers: true });

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

    // ---- Phase 4: Body phase (K4 — fully incremental element loop) ----
    //
    // Every structure now streams natively, in source order, bounded only by
    // the element currently being decoded:
    //
    //   - Defined-length leaves and SQ: emitted directly (K3 behavior).
    //   - Undefined-length SQ / items: parsed delimiter-driven; the subtree is
    //     buffered ONLY long enough to backfill the buffered-parity content-span
    //     length payload on startSequence/startItem (unknown until the closing
    //     FFFE,E0DD / FFFE,E00D is reached), then flushed.
    //   - Encapsulated pixel data: fragments streamed one at a time (the Basic
    //     Offset Table item is skipped, matching buffered fromPart10).
    //   - Undefined-length non-SQ leaves ("eagerWindow"): the element window is
    //     bounded by an item-delimiter scan (mirroring the parser's
    //     findItemDelimitationItem) and decoded via decodeWithEagerReadTag.
    //
    // The K3 tail-fallback (walkBodyTail / TailFallbackSignal / EventBuffer-for-
    // atomicity) is deleted: nothing can fall back mid-subtree anymore because
    // deflate is decided BEFORE the body loop. The only remaining buffered path
    // is deflate (K5). Chunk release is LIVE (clearBuffers:true + consume()).

    // --- Deflate TS → buffered body path (still retains full bytes; K5) ---
    if (transferSyntaxUID === DEFLATED_EXPLICIT_LITTLE_ENDIAN) {
        // K5 will stream-inflate; for now delegate to fromPart10 (buffered).
        options.onPhase?.("deflate"); // observable hook for tests
        await feedPromise;
        if (feedError) throw feedError;
        const deflateBytes = new Uint8Array(stream.slice(0, stream.size));
        await fromPart10(deflateBytes.buffer, listener, {
            ...options,
            _skipMeta: true
        });
        listener.endDataSet();
        return;
    }

    // Body transfer syntax characteristics — drive all element reads.
    const bodyLittleEndian = transferSyntaxUID !== EXPLICIT_BIG_ENDIAN;
    const bodyImplicit = transferSyntaxUID === IMPLICIT_LITTLE_ENDIAN;

    // K4: chunk release is LIVE for non-deflate streams. clearBuffers is true
    // at construction, so consume() actually frees fully-passed chunks after
    // every completed top-level element.
    const releaseEnabled = true;

    const UNDEFINED_LEN = 0xffffffff;
    const SQ_VR = ValueRepresentation.createByTypeString("SQ");
    const EMPTY_WIN = {
        arrayBuffer: new ArrayBuffer(0),
        baseOffset: 0,
        syntax: transferSyntaxUID,
        littleEndian: bodyLittleEndian,
        implicit: bodyImplicit,
        decoder: null
    };

    // Byte-order helpers for body elements (tag, VR, length, item tags).
    const getU16 = abs => stream.view.getUint16(abs, bodyLittleEndian);
    const getU32 = abs => stream.view.getUint32(abs, bodyLittleEndian);

    /** Convert (group, element) numbers to clean DICOM tag string "GGGGEEEE". */
    function bodyTagStr(g, e) {
        return (
            g.toString(16).padStart(4, "0").toUpperCase() +
            e.toString(16).padStart(4, "0").toUpperCase()
        );
    }

    /**
     * EventBuffer — records listener events as lambdas so an undefined-length
     * SQ / item subtree can be replayed AFTER its closing delimiter is reached,
     * once the content-span length payload is known (buffered fromPart10 emits
     * that computed span, not the on-wire 0xFFFFFFFF). Values are baked into the
     * lambdas at decode time, so charset scoping and fresh-copy semantics are
     * unaffected by the deferred flush. awaitDrain is a local no-op during
     * buffering (backpressure is applied by the real listener after the flush).
     */
    class EventBuffer {
        constructor() {
            this._q = [];
        }
        startElement(tag, info) {
            this._q.push(l => l.startElement(tag, info));
        }
        endElement() {
            this._q.push(l => l.endElement());
        }
        value(v, opts) {
            this._q.push(l => l.value(v, opts));
        }
        startBinary(opts) {
            this._q.push(l => l.startBinary(opts));
        }
        binaryFragment(buf) {
            this._q.push(l => l.binaryFragment(buf));
        }
        endBinary() {
            this._q.push(l => l.endBinary());
        }
        startSequence(tag, info) {
            this._q.push(l => l.startSequence(tag, info));
        }
        endSequence() {
            this._q.push(l => l.endSequence());
        }
        startItem(info) {
            this._q.push(l => l.startItem(info));
        }
        endItem() {
            this._q.push(l => l.endItem());
        }
        awaitDrain() {} // no-op during buffering
        /** Replay all buffered events to `realListener`. */
        flushTo(realListener) {
            for (const fn of this._q) fn(realListener);
        }
    }

    /**
     * Ensure the bytes up to absolute offset `absEnd` are present, then re-check
     * strict availability (ensureAvailable resolves at EOF too — OR-complete
     * semantics). Returns true only when the bytes are genuinely available.
     */
    async function ensureAbs(absEnd) {
        const need = absEnd - stream.offset;
        if (need > 0) {
            await stream.ensureAvailable(need);
        }
        return absEnd <= stream.endOffset;
    }

    // ---- Undefined-length structural end-finders (byte skip, no emission) ----
    //
    // The only undefined-length non-SQ elements dcmjs decodes cleanly via the
    // eager reader (classifyElement "eagerWindow") are the ones the offsets
    // parser routes through readSequenceItemsImplicit — explicit VR UN of
    // undefined length, and private implicit undefined-length elements (whose
    // items the parser clears). Those end at the sequence delimiter FFFE,E0DD,
    // NOT at an item delimiter. findItemDelimitationItem (FFFE,E00D) applies to
    // the remaining undefined-length non-SQ VRs (e.g. OB), but the eager reader
    // reads those to their declared length and throws — identically in buffered
    // fromPart10 — so no equivalent decode exists to bound. These scanners
    // therefore mirror the parser's sequence walk (FFFE,E0DD) with nested
    // item-delimiter (FFFE,E00D) handling.

    /**
     * Skip an undefined-length sequence's items, returning
     * `{ contentEnd, end }`: `contentEnd` is the offset of the closing
     * FFFE,E0DD (the parser's content-span end == element.length base), `end`
     * is the offset just past it. Mirrors readSQElementUndefinedLength*.
     */
    async function skipUndefinedSequence(fromAbs) {
        let pos = fromAbs;
        for (;;) {
            if (!(await ensureAbs(pos + 8))) {
                return { contentEnd: stream.endOffset, end: stream.endOffset };
            }
            const g = getU16(pos);
            const e = getU16(pos + 2);
            if (g === 0xfffe && e === 0xe0dd) {
                return { contentEnd: pos, end: pos + 8 };
            }
            if (g !== 0xfffe || e !== 0xe000) {
                return { contentEnd: pos, end: pos }; // malformed — stop
            }
            const itemLength = getU32(pos + 4);
            pos += 8;
            pos =
                itemLength === UNDEFINED_LEN
                    ? await skipUndefinedItem(pos)
                    : pos + itemLength;
        }
    }

    /**
     * Skip an undefined-length item's elements, returning the offset just past
     * its FFFE,E00D delimiter (findItemDelimitationItem semantics, but element-
     * aware so nested defined-length values are stepped over correctly).
     */
    async function skipUndefinedItem(fromAbs) {
        let pos = fromAbs;
        for (;;) {
            if (!(await ensureAbs(pos + 8))) return stream.endOffset;
            const g = getU16(pos);
            const e = getU16(pos + 2);
            if (g === 0xfffe && e === 0xe00d) return pos + 8;
            pos = await skipOneElementEnd(pos);
        }
    }

    /** Skip a single element header + value, recursing into nested structures. */
    async function skipOneElementEnd(fromAbs) {
        let pos = fromAbs;
        if (!(await ensureAbs(pos + 8))) return stream.endOffset;
        pos += 4; // tag
        let valueLength;
        if (bodyImplicit) {
            valueLength = stream.view.getUint32(pos, true);
            pos += 4;
        } else {
            const vr =
                String.fromCharCode(stream.view.getUint8(pos)) +
                String.fromCharCode(stream.view.getUint8(pos + 1));
            pos += 2;
            if (ValueRepresentation.createByTypeString(vr).isLength32()) {
                if (!(await ensureAbs(pos + 6))) return stream.endOffset;
                pos += 2; // reserved
                valueLength = getU32(pos);
                pos += 4;
            } else {
                valueLength = getU16(pos);
                pos += 2;
            }
        }
        if (valueLength === UNDEFINED_LEN) {
            return (await skipUndefinedSequence(pos)).end;
        }
        if (!(await ensureAbs(pos + valueLength))) return stream.endOffset;
        return pos + valueLength;
    }

    /**
     * Read ONE element header at `elemStartAbs` (the caller has verified it is
     * not a delimiter tag) and route it by classification, emitting into
     * `target`. Returns the (possibly charset-updated) decoder for the caller
     * to thread into the next element. Mirrors decodeCore.classifyElement.
     */
    async function parseOneElement(target, elemStartAbs, currentDecoder) {
        stream.offset = elemStartAbs;
        const elGroup = getU16(elemStartAbs);
        const elElement = getU16(elemStartAbs + 2);
        stream.offset = elemStartAbs + 4;
        const tagStr = bodyTagStr(elGroup, elElement);

        let vrStr = null;
        let valueLength;
        if (bodyImplicit) {
            if (!(await ensureAbs(stream.offset + 4))) {
                throw new Error(
                    `fromPart10Stream: truncated at ${elemStartAbs}: missing implicit length`
                );
            }
            // Implicit is always LITTLE_ENDIAN regardless of body TS.
            valueLength = stream.view.getUint32(stream.offset, true);
            stream.offset += 4;
        } else {
            if (!(await ensureAbs(stream.offset + 2))) {
                throw new Error(
                    `fromPart10Stream: truncated at ${elemStartAbs}: missing VR bytes`
                );
            }
            vrStr =
                String.fromCharCode(stream.view.getUint8(stream.offset)) +
                String.fromCharCode(stream.view.getUint8(stream.offset + 1));
            stream.offset += 2;
            const vrForLen = ValueRepresentation.createByTypeString(vrStr);
            if (vrForLen.isLength32()) {
                if (!(await ensureAbs(stream.offset + 6))) {
                    throw new Error(
                        `fromPart10Stream: truncated at ${elemStartAbs}: missing extended length`
                    );
                }
                stream.offset += 2; // reserved
                valueLength = getU32(stream.offset);
                stream.offset += 4;
            } else {
                if (!(await ensureAbs(stream.offset + 2))) {
                    throw new Error(
                        `fromPart10Stream: truncated at ${elemStartAbs}: missing 2-byte length`
                    );
                }
                valueLength = getU16(stream.offset);
                stream.offset += 2;
            }
        }

        const valueStartAbs = stream.offset;
        const undef = valueLength === UNDEFINED_LEN;
        const elLike = {
            vr: vrStr,
            tagValue: ((elGroup << 16) | elElement) >>> 0,
            dataOffset: 0,
            length: valueLength,
            hadUndefinedLength: undef
        };
        let vrInstance = resolveVrInstance(elLike, EMPTY_WIN);

        if (!undef) {
            // Defined length. Mirror readDicomElementImplicit isSequence() peek
            // for dictionary-unknown implicit elements.
            if (
                bodyImplicit &&
                vrInstance.type !== "SQ" &&
                (elGroup & 1) === 0 &&
                valueLength >= 4 &&
                (await ensureAbs(valueStartAbs + 4))
            ) {
                // Item/delimiter tags are little-endian in implicit LE (== body).
                const pg = stream.view.getUint16(valueStartAbs, true);
                const pe = stream.view.getUint16(valueStartAbs + 2, true);
                if (pg === 0xfffe && (pe === 0xe000 || pe === 0xe0dd)) {
                    vrInstance = SQ_VR;
                }
            }
            if (vrInstance.type === "SQ") {
                await emitSequence(
                    target,
                    tagStr,
                    valueStartAbs,
                    valueLength,
                    currentDecoder
                );
                return currentDecoder;
            }
            return await emitDefinedLeaf(
                target,
                tagStr,
                elLike,
                vrInstance,
                valueLength,
                valueStartAbs,
                currentDecoder
            );
        }

        // Undefined length: classify SQ / encapsulated / eagerWindow leaf,
        // matching decodeCore.classifyElement + the parser's SQ resolution.
        let treatAsSq = false;
        if (vrInstance.type === "SQ") {
            if (!bodyImplicit) {
                treatAsSq = true; // explicit VR SQ
            } else {
                // Implicit resolved-SQ: dictionary-known SQ (no peek) vs
                // dictionary-unknown (hadUndefinedLength fallback → peek).
                const dictVr = resolveVrInstance(
                    { ...elLike, hadUndefinedLength: false },
                    EMPTY_WIN
                );
                if (dictVr.type === "SQ") {
                    treatAsSq = true;
                } else if (await ensureAbs(valueStartAbs + 4)) {
                    const pg = stream.view.getUint16(valueStartAbs, true);
                    const pe = stream.view.getUint16(valueStartAbs + 2, true);
                    treatAsSq =
                        pg === 0xfffe && (pe === 0xe000 || pe === 0xe0dd);
                }
            }
        }
        if (treatAsSq) {
            await emitSequence(
                target,
                tagStr,
                valueStartAbs,
                UNDEFINED_LEN,
                currentDecoder
            );
            return currentDecoder;
        }
        if (tagStr === "7FE00010" && !isParsedUnknownVr(vrInstance)) {
            await emitEncapsulated(target, tagStr, vrInstance, valueStartAbs);
            return currentDecoder;
        }
        await emitUndefinedLeaf(
            target,
            tagStr,
            elemStartAbs,
            valueStartAbs,
            elLike,
            vrInstance,
            currentDecoder
        );
        return currentDecoder;
    }

    /**
     * Defined-length leaf element: decode the value and emit directly. Returns
     * the decoder to thread onward (updated when this is (0008,0005)).
     */
    async function emitDefinedLeaf(
        target,
        tagStr,
        elLike,
        vrInstance,
        valueLength,
        valueStartAbs,
        decoder
    ) {
        const valueEndAbs = valueStartAbs + valueLength;
        if (valueLength > 0 && !(await ensureAbs(valueEndAbs))) {
            throw new Error(
                `fromPart10Stream: truncated: element at ${valueStartAbs} ` +
                    `declares ${valueLength} bytes but stream ended`
            );
        }
        const valueAB = stream.slice(valueStartAbs, valueEndAbs);
        const win = {
            arrayBuffer: valueAB,
            baseOffset: 0,
            syntax: transferSyntaxUID,
            littleEndian: bodyLittleEndian,
            implicit: bodyImplicit,
            decoder
        };
        const { values, rawValues } = decodeElementValues(
            win,
            elLike,
            vrInstance,
            policy
        );
        let newDecoder = decoder;
        // (0008,0005) SpecificCharacterSet sets the decoder for subsequent
        // elements in this scope (top-level body or the current SQ item).
        if (tagStr === "00080005") {
            const csResult = resolveCharacterSet(win, elLike, policy);
            newDecoder = csResult?.decoder ?? null;
        }
        emitValues(target, tagStr, vrInstance, elLike, values, rawValues);
        stream.offset = valueEndAbs;
        return newDecoder;
    }

    /**
     * Emit a sequence (defined or undefined length) into `target`.
     * `dataOffsetAbs` is the absolute offset of the sequence's first content
     * byte. Defined-length sequences emit directly with the declared length;
     * undefined-length sequences buffer their items so the content-span length
     * payload (parity with buffered fromPart10) can be backfilled at the
     * closing FFFE,E0DD.
     */
    async function emitSequence(
        target,
        tagStr,
        dataOffsetAbs,
        declaredLength,
        outerDecoder
    ) {
        if (declaredLength !== UNDEFINED_LEN) {
            const sqEndAbs = dataOffsetAbs + declaredLength;
            target.startSequence(tagStr, { vr: "SQ", length: declaredLength });
            await parseSqItems(target, sqEndAbs, false, outerDecoder);
            target.endSequence();
            stream.offset = sqEndAbs;
        } else {
            const buf = new EventBuffer();
            const delimStart = await parseSqItems(buf, -1, true, outerDecoder);
            const contentSpan = delimStart - dataOffsetAbs;
            target.startSequence(tagStr, { vr: "SQ", length: contentSpan });
            buf.flushTo(target);
            target.endSequence();
            // stream.offset already advanced past FFFE,E0DD by parseSqItems.
        }
    }

    /**
     * Encapsulated pixel data: stream fragments one at a time. The first item is
     * the Basic Offset Table — its header is read and its bytes skipped (buffered
     * fromPart10 keeps it in element.basicOffsetTable and does NOT emit it as a
     * fragment). The startElement length payload is the on-wire 0xFFFFFFFF
     * (the computed span is unknown until the closing delimiter, which would
     * defeat fragment streaming) — a documented delta from buffered fromPart10.
     */
    async function emitEncapsulated(target, tagStr, vrInstance, dataOffsetAbs) {
        target.startElement(tagStr, {
            vr: vrInstance.type,
            length: UNDEFINED_LEN
        });
        target.startBinary({ encapsulated: true });
        stream.offset = dataOffsetAbs;

        // Basic Offset Table item (FFFE,E000) — skip its bytes.
        if (!(await ensureAbs(stream.offset + 8))) {
            throw new Error(
                `fromPart10Stream: truncated: encapsulated BOT header at ${stream.offset}`
            );
        }
        const botLen = getU32(stream.offset + 4);
        stream.offset += 8;
        if (botLen > 0) {
            if (!(await ensureAbs(stream.offset + botLen))) {
                throw new Error(
                    `fromPart10Stream: truncated: encapsulated BOT (${botLen} bytes)`
                );
            }
            stream.offset += botLen;
        }

        for (;;) {
            if (!(await ensureAbs(stream.offset + 8))) {
                throw new Error(
                    `fromPart10Stream: truncated: encapsulated item header at ${stream.offset}`
                );
            }
            const g = getU16(stream.offset);
            const e = getU16(stream.offset + 2);
            if (g === 0xfffe && e === 0xe0dd) {
                stream.offset += 8; // sequence-delimiter tag + 4-byte length
                break;
            }
            if (g !== 0xfffe || e !== 0xe000) {
                break; // unexpected tag — stop gracefully
            }
            const fragLen = getU32(stream.offset + 4);
            stream.offset += 8;
            const fragStart = stream.offset;
            const fragEnd = fragStart + fragLen;
            if (!(await ensureAbs(fragEnd))) {
                throw new Error(
                    `fromPart10Stream: truncated: pixel-data fragment (${fragLen} bytes) at ${fragStart}`
                );
            }
            // Fresh copy — the emitted buffer must not alias released chunks.
            target.binaryFragment(stream.slice(fragStart, fragEnd));
            stream.offset = fragEnd;
            await target.awaitDrain(); // backpressure between fragments
        }
        target.endBinary();
        target.endElement();
    }

    /**
     * Undefined-length non-SQ leaf ("eagerWindow"): bound the element window by
     * walking the structure to its closing sequence delimiter, copy the whole
     * element span, and decode via decodeWithEagerReadTag — the same narrow
     * eager fallback buffered fromPart10 uses. The emitted length payload is the
     * parser's computed content span (delimiter offset minus the data offset),
     * for parity with buffered.
     */
    async function emitUndefinedLeaf(
        target,
        tagStr,
        elemStartAbs,
        valueStartAbs,
        elLike,
        vrInstance,
        decoder
    ) {
        const { contentEnd, end } = await skipUndefinedSequence(valueStartAbs);
        const windowAB = stream.slice(elemStartAbs, end);
        const win = {
            arrayBuffer: windowAB,
            baseOffset: 0,
            syntax: transferSyntaxUID,
            littleEndian: bodyLittleEndian,
            implicit: bodyImplicit,
            decoder
        };
        const eagerEl = {
            ...elLike,
            startOffset: 0,
            endOffset: end - elemStartAbs,
            dataOffset: valueStartAbs - elemStartAbs,
            length: contentEnd - valueStartAbs
        };
        const { values, rawValues } = decodeWithEagerReadTag(
            win,
            eagerEl,
            policy
        );
        emitValues(target, tagStr, vrInstance, eagerEl, values, rawValues);
        stream.offset = end;
    }

    /**
     * Parse the items of a sequence into `target`.
     *   - Defined-length SQ (`undefinedSeq=false`): items until `sqEndAbs`.
     *   - Undefined-length SQ (`undefinedSeq=true`, `sqEndAbs` ignored): items
     *     until the sequence delimiter (FFFE,E0DD); returns the absolute offset
     *     of that delimiter (the parser's content-span end).
     * `outerDecoder` is the parent-scope charset decoder inherited by items.
     */
    async function parseSqItems(target, sqEndAbs, undefinedSeq, outerDecoder) {
        while (undefinedSeq || stream.offset < sqEndAbs) {
            if (!(await ensureAbs(stream.offset + 8))) {
                if (undefinedSeq) return stream.offset; // EOF before delimiter
                throw new Error(
                    `fromPart10Stream: truncated: SQ item header at ${stream.offset}`
                );
            }
            const itemStart = stream.offset;
            const itemGroup = getU16(itemStart);
            const itemElement = getU16(itemStart + 2);

            if (itemGroup === 0xfffe && itemElement === 0xe0dd) {
                stream.offset = itemStart + 8; // consume seq-delimiter + length
                return itemStart;
            }
            if (itemGroup !== 0xfffe || itemElement !== 0xe000) {
                return itemStart; // unexpected tag — stop gracefully
            }
            const itemLength = getU32(itemStart + 4);
            stream.offset = itemStart + 8; // past item header
            const itemDataOffset = stream.offset;

            if (itemLength !== UNDEFINED_LEN) {
                const itemEndAbs = itemDataOffset + itemLength;
                target.startItem({ length: itemLength });
                await parseItemElements(
                    target,
                    itemEndAbs,
                    false,
                    outerDecoder
                );
                target.endItem();
                stream.offset = itemEndAbs;
            } else {
                // Undefined-length item: buffer to backfill the parser's item
                // span (data offset → past the closing item delimiter).
                const ibuf = new EventBuffer();
                const delimStart = await parseItemElements(
                    ibuf,
                    -1,
                    true,
                    outerDecoder
                );
                const itemSpan = delimStart + 8 - itemDataOffset;
                target.startItem({ length: itemSpan });
                ibuf.flushTo(target);
                target.endItem();
            }
        }
        return stream.offset;
    }

    /**
     * Parse the elements of a single sequence item into `target`.
     *   - Defined-length item (`undefinedItem=false`): elements until
     *     `itemEndAbs`.
     *   - Undefined-length item (`undefinedItem=true`, `itemEndAbs` ignored):
     *     elements until the item delimiter (FFFE,E00D); returns the absolute
     *     offset of that delimiter.
     * Per-item charset scoping: this item's own (0008,0005) overrides
     * `parentDecoder` for subsequent elements in its subtree.
     */
    async function parseItemElements(
        target,
        itemEndAbs,
        undefinedItem,
        parentDecoder
    ) {
        let itemDecoder = parentDecoder;
        while (undefinedItem || stream.offset < itemEndAbs) {
            if (!(await ensureAbs(stream.offset + 4))) {
                if (undefinedItem) return stream.offset;
                throw new Error(
                    `fromPart10Stream: truncated: item element header at ${stream.offset}`
                );
            }
            const elemStart = stream.offset;
            const g = getU16(elemStart);
            const e = getU16(elemStart + 2);
            if (g === 0xfffe && e === 0xe00d) {
                // Item delimiter: consume tag + 4-byte length.
                if (!(await ensureAbs(elemStart + 8)) && undefinedItem) {
                    return elemStart;
                }
                stream.offset = elemStart + 8;
                return elemStart;
            }
            itemDecoder = await parseOneElement(target, elemStart, itemDecoder);
        }
        return stream.offset;
    }

    // ---- K4 top-level body element loop ----
    // Every element (defined or undefined length, leaf or SQ or encapsulated)
    // is read and emitted incrementally by parseOneElement.  After each
    // top-level element completes, consume() releases the chunks it no longer
    // needs (non-deflate release is live).
    let bodyDecoder = null; // resolved when (0008,0005) is first seen in body

    bodyLoop: for (;;) {
        // --- Read next element tag (4 bytes) ---
        if (!(await ensureAbs(stream.offset + 4))) break bodyLoop; // clean EOF

        const elemStartAbs = stream.offset;
        const elGroup = getU16(elemStartAbs);

        // Defensive: stray top-level FFFE delimiter tags are malformed for a
        // well-formed Part 10 body; skip them so the next real element frames
        // correctly (native SQ/encapsulated handlers already consume their own
        // delimiters, so this is only reached on malformed input).
        if (elGroup === 0xfffe) {
            if (!(await ensureAbs(elemStartAbs + 8))) break bodyLoop;
            stream.offset = elemStartAbs + 8;
            continue bodyLoop;
        }

        bodyDecoder = await parseOneElement(
            listener,
            elemStartAbs,
            bodyDecoder
        );
        await listener.awaitDrain();
        if (releaseEnabled) {
            // Release every chunk fully behind the current position.
            stream.consume(stream.offset);
            options.onConsume?.(stream.getBufferMemoryInfo());
        }
    }

    // Observable hook: the native incremental path always runs to here (the
    // tail-fallback path is deleted; deflate returns early above).
    options.onPhase?.("native");

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
