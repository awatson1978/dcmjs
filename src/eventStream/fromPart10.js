import {
    resolveVrInstance,
    decodeElementValues,
    resolveCharacterSet,
    decodeWithEagerReadTag,
    seedReadContext
} from "../core/decodeCore.js";

/**
 * fromPart10 — a genuine raw-bytes Part 10 -> event-stream generator.
 *
 * Walks @dcmjs/parser's offsets tree in source order and emits the event-stream
 * contract, decoding each element with decodeCore primitives (resolveVrInstance,
 * decodeElementValues, resolveCharacterSet). Encapsulated pixel data is emitted
 * as RAW fragments (§33); frame grouping is naturalization (slice D).
 * Defined-length binary is one fragment.
 *
 * Parsing is delegated to decodeCore.seedReadContext which runs @dcmjs/parser
 * with the pako inflater (transparent for non-deflate syntax) and returns
 * ready-to-use metaWindow (original buffer) and bodyWindow (inflated body).
 * Undefined-length non-SQ elements (classifyElement "eagerWindow") are decoded
 * per-element via decodeCore.decodeWithEagerReadTag.  Tokenizer-rejected files
 * propagate the error directly (empirical corpus check confirmed no file needs
 * eager fallback — slice J stage 4c).
 *
 * Documented behavior deltas vs the old fromPart10 (both are DELIBERATE
 * convergence on eager DicomMessage.readFile semantics):
 *   1. shapeReadValues convergence: multi-value shaping now follows the eager
 *      singleVRs branch structure (core import) instead of allowMultiple()+
 *      alignRaw. Output is byte-equivalent for all standard VR types.
 *   2. Charset error policy: resolveCharacterSet (top-level and per-item) now
 *      throws on unsupported/multiple charsets when ignoreErrors=false, where
 *      the old resolveDecoder silently returned null. ignoreErrors=true still
 *      degrades to null decoder (core handles it internally).
 *
 * @param {ArrayBuffer|Uint8Array} buffer
 * @param {import("./EventStreamListener").EventStreamListener} listener
 * @param {Object} [options] DicomMessage.readFile-style options
 */
export async function fromPart10(buffer, listener, options = {}) {
    const byteArray = toUint8Array(buffer);

    // seedReadContext parses with @dcmjs/parser (inflater enabled for deflate),
    // extracts the transfer syntax, and returns ready-to-use windows where
    // metaWindow indexes the original (possibly compressed) buffer and
    // bodyWindow indexes the (possibly inflated) body buffer.  This replaces
    // the direct parseDicom call + manual window construction and eliminates
    // the deflate early-return delegation path (slice J stage 4b).
    let dataSet, syntax, metaWindow, bodyWindow;
    try {
        ({ dataSet, syntax, metaWindow, bodyWindow } = seedReadContext(
            byteArray,
            options
        ));
    } catch (e) {
        // Empirical check (slice J stage 4c) confirmed: every corpus file either
        // passes seedReadContext or is also rejected by DicomMessage.readFile —
        // no file requires a whole-file fallback here.  Propagate directly.
        throw e;
    }

    const policy = {
        forceStoreRaw: !!options.forceStoreRaw,
        noCopy: false,
        ignoreErrors: !!options.ignoreErrors
    };

    // _skipMeta: internal option used by fromPart10Stream (K2+) to skip
    // dataset brackets and FMI emission when the streaming path has already
    // handled them incrementally.  NEVER pass this from user-facing call
    // sites; the K1 equivalence tests guard that the normal path is intact.
    const skipMeta = !!options._skipMeta;

    if (!skipMeta) {
        listener.startDataSet({ transferSyntaxUID: syntax });
    }

    const elements = dataSet.elements;
    const keys = Object.keys(elements).filter(k => k !== "xfffee00d");
    const metaKeys = keys.filter(k => isMetaKey(k));
    const bodyKeys = keys.filter(k => !isMetaKey(k));

    if (!skipMeta && metaKeys.length) {
        listener.startFileMetaInformation();
        for (const key of metaKeys) {
            emitElement(
                listener,
                metaWindow,
                bodyWindow,
                policy,
                elements[key],
                true,
                null
            );
        }
        listener.endFileMetaInformation();
    }

    // Resolve the dataset decoder from SpecificCharacterSet (00080005).
    // resolveCharacterSet uses eager semantics: throws for unsupported
    // charsets when ignoreErrors=false (DELIBERATE convergence on eager),
    // degrades to null decoder when ignoreErrors=true.
    // The ISO_IR 192 seedState in the result is intentionally discarded:
    // the event stream emits SpecificCharacterSet as-in-file (corpus gate
    // exempts that tag from equivalence checking).
    const csResult = resolveCharacterSet(
        bodyWindow,
        elements.x00080005,
        policy
    );
    const decoder = csResult?.decoder ?? null;

    for (const key of bodyKeys) {
        emitElement(
            listener,
            metaWindow,
            bodyWindow,
            policy,
            elements[key],
            false,
            decoder
        );
        await listener.awaitDrain();
    }

    if (!skipMeta) {
        listener.endDataSet();
    }
}

/**
 * Emit a single element (or subtree) into the listener.
 *
 * `decoder` is the current-scope TextDecoder (null if no charset in effect).
 * For body elements it is merged into a copy of bodyWindow before passing to
 * decodeElementValues so the body window itself stays immutable — enabling
 * per-item decoder scoping in sequences without shared-state mutation.
 */
function emitElement(
    listener,
    metaWindow,
    bodyWindow,
    policy,
    el,
    isMeta,
    decoder
) {
    const tag = cleanTag(el);
    // Select the correct window for this element's scope and attach the
    // current decoder. metaWindow.decoder is always null (meta is always
    // decoded with the default latin1 decoder).
    const window = isMeta
        ? metaWindow
        : decoder
        ? { ...bodyWindow, decoder }
        : bodyWindow;
    const vrInstance = resolveVrInstance(el, window);

    // Plain sequence (defined or undefined length).
    if (vrInstance.type === "SQ" && el.items) {
        listener.startSequence(tag, { vr: vrInstance.type, length: el.length });
        for (const item of el.items) {
            listener.startItem({ length: item.length });
            const itemElements = (item.dataSet && item.dataSet.elements) || {};
            // Per-item charset resolution: resolveCharacterSet throws for
            // unsupported charsets when ignoreErrors=false (convergence on
            // eager); degrades to null decoder (outer decoder used) when
            // ignoreErrors=true (handled internally by the core).
            const itemDecoder =
                resolveCharacterSet(bodyWindow, itemElements.x00080005, policy)
                    ?.decoder ?? decoder;
            for (const key of Object.keys(itemElements)) {
                if (key === "xfffee00d") continue;
                emitElement(
                    listener,
                    metaWindow,
                    bodyWindow,
                    policy,
                    itemElements[key],
                    isMeta,
                    itemDecoder
                );
            }
            listener.endItem();
        }
        listener.endSequence();
        return;
    }

    // Encapsulated pixel data -> raw fragments.
    if (el.encapsulatedPixelData && el.fragments) {
        listener.startElement(tag, { vr: vrInstance.type, length: el.length });
        listener.startBinary({ encapsulated: true });
        for (const f of el.fragments) {
            listener.binaryFragment(fragmentBuffer(bodyWindow, f));
        }
        listener.endBinary();
        listener.endElement();
        return;
    }

    // Undefined-length non-SQ elements (classifyElement "eagerWindow"): re-read
    // the element span via the eager reader, exactly as the lazy core does via
    // materializeWithEagerReadTag.  This eliminates the whole-file delegation
    // that previously occurred here (slice J stage 4a).
    if (el.hadUndefinedLength) {
        const { values, rawValues } = decodeWithEagerReadTag(
            window,
            el,
            policy
        );
        emitValues(listener, tag, vrInstance, el, values, rawValues);
        return;
    }

    // Decode the value(s) with the core primitives, then route by the DECODED
    // type: byte-blob VRs (OB/OW/OF/OD/UN) produce ArrayBuffers and go to the
    // binary sub-stream; everything else (incl. numeric "binary" VRs like
    // SL/US which decode to numbers) goes to value().
    const { values, rawValues } = decodeElementValues(
        window,
        el,
        vrInstance,
        policy
    );
    emitValues(listener, tag, vrInstance, el, values, rawValues);
}

/**
 * Route decoded {values, rawValues} to binary or scalar listener events.
 * Exported for reuse by fromPart10Stream's K3 incremental body loop.
 */
export function emitValues(listener, tag, vrInstance, el, values, rawValues) {
    if (values.some(isBufferLike)) {
        listener.startElement(tag, { vr: vrInstance.type, length: el.length });
        listener.startBinary({ encapsulated: false });
        for (const buf of values) {
            listener.binaryFragment(buf);
        }
        listener.endBinary();
        listener.endElement();
        return;
    }

    listener.startElement(tag, { vr: vrInstance.type, length: el.length });
    let index = 0;
    for (const v of values) {
        listener.value(v, { index, rawValue: rawValues[index] });
        index++;
    }
    listener.endElement();
}

function isBufferLike(v) {
    return v instanceof ArrayBuffer || ArrayBuffer.isView(v);
}

// --- misc -------------------------------------------------------------------

function fragmentBuffer(window, f) {
    const start = window.baseOffset + f.position;
    return window.arrayBuffer.slice(start, start + f.length);
}

function cleanTag(el) {
    // parser key 'xggggeeee' (lowercase) -> dcmjs clean 'GGGGEEEE' (uppercase)
    return el.tag.slice(1).toUpperCase();
}

function isMetaKey(key) {
    // key is 'xggggeeee'; group is chars 1..5
    return key.slice(1, 5) === "0002";
}

/**
 * Walk pre-parsed body elements starting at or after `fromAbsOffset`, emitting
 * each one into `listener`.  Used by fromPart10Stream's K3 tail-fallback:
 * when an undefined-length element is encountered mid-body, the stream path
 * awaits feed completion, runs seedReadContext, and calls this function to
 * emit the elements it has not yet emitted (those at or after `fromAbsOffset`).
 *
 * @param {import("./EventStreamListener").EventStreamListener} listener
 * @param {object} metaWindow  - from seedReadContext
 * @param {object} bodyWindow  - from seedReadContext
 * @param {object} policy      - {forceStoreRaw, noCopy, ignoreErrors}
 * @param {object} elements    - dataSet.elements from seedReadContext
 * @param {TextDecoder|null} decoder - active body charset decoder (null = Latin-1)
 * @param {number} fromAbsOffset - absolute file offset; elements before this
 *        were already emitted by the incremental loop and must be skipped.
 * K3 tail-fallback: undefined-length handling is native in K4.
 */
export async function walkBodyTail(
    listener,
    metaWindow,
    bodyWindow,
    policy,
    elements,
    decoder,
    fromAbsOffset
) {
    const bodyKeys = Object.keys(elements).filter(
        k => !isMetaKey(k) && k !== "xfffee00d"
    );
    for (const key of bodyKeys) {
        const el = elements[key];
        // Skip elements that the incremental loop already emitted.
        if (el.startOffset < fromAbsOffset) continue;
        emitElement(
            listener,
            metaWindow,
            bodyWindow,
            policy,
            el,
            false,
            decoder
        );
        await listener.awaitDrain();
    }
}

function toUint8Array(buffer) {
    if (buffer instanceof Uint8Array) {
        return buffer;
    }
    return new Uint8Array(buffer);
}
