/**
 * src/eventStream/fromPart10Stream.js
 *
 * fromPart10Stream — chunked bytes→events source (slice K, stage 1).
 *
 * This is the public entry point for the bounded-memory streaming path.
 * Input is normalized into an AsyncIterable and fed into a ReadBufferStream
 * concurrently with parsing. Stage K1 buffers fully before delegating to
 * fromPart10; stages K2-K5 will replace the internals with the real
 * ensureAvailable/consume incremental loop.
 */

import { ReadBufferStream } from "../BufferStream.js";
import { fromPart10 } from "./fromPart10.js";

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
 * `consume()` releases when the incremental loop (K2-K5) is in place
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

    // Build the ReadBufferStream in streaming mode, mirroring AsyncDicomReader's
    // constructor (src/AsyncDicomReader.js:34-42): clearBuffers:true,
    // littleEndian:true. Feeding and parsing run concurrently (see below).
    const stream = new ReadBufferStream(null, true, { clearBuffers: true });

    // Kick off the feed concurrently (intentionally unawaited here).
    // In K2-K5 the parse loop will interleave with this via
    // stream.ensureAvailable(N) / stream.consume(N) per chunk.
    // Feed errors are captured in `feedError` so they surface into the parse.
    let feedError = null;
    const feedPromise = (async () => {
        try {
            for await (const chunk of iterable) {
                stream.addBuffer(toArrayBuffer(chunk));
            }
            // Signal that all bytes have been delivered.
            stream.setComplete();
        } catch (e) {
            feedError = e;
            // Unblock any stream.ensureAvailable() waiters so the parse
            // (K2-K5) can observe the error and propagate it.
            stream.setComplete();
        }
    })();

    // K1 placeholder: buffers fully; replaced by incremental loop in K2-K5.
    //
    // Wait for the feed to finish, collect the entire byte array, then
    // delegate to the proven fromPart10 walker. Later stages replace this
    // block with a per-chunk ensureAvailable/consume loop so that only a
    // bounded sliding window of bytes is held in memory at once.
    await feedPromise;
    if (feedError) throw feedError;

    const byteArray = new Uint8Array(stream.slice(0, stream.size));
    await fromPart10(byteArray.buffer, listener, options);
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
