import { parseDicom } from "@dcmjs/parser";
import { DicomMessage } from "../DicomMessage.js";
import { Tag } from "../Tag.js";
import {
    EXPLICIT_LITTLE_ENDIAN,
    EXPLICIT_BIG_ENDIAN,
    IMPLICIT_LITTLE_ENDIAN,
    DEFLATED_EXPLICIT_LITTLE_ENDIAN
} from "../constants/dicom.js";
import { fromDataSet } from "./fromDataSet.js";
import {
    resolveVrInstance,
    decodeElementValues,
    resolveCharacterSet,
    decodeWithEagerReadTag
} from "../core/decodeCore.js";

/**
 * fromPart10 — slice B: a genuine raw-bytes Part 10 -> event-stream generator.
 *
 * Walks @dcmjs/parser's offsets tree in source order and emits the event-stream
 * contract, decoding each element with decodeCore primitives (resolveVrInstance,
 * decodeElementValues, resolveCharacterSet). Encapsulated pixel data is emitted
 * as RAW fragments (§33); frame grouping is naturalization (slice D).
 * Defined-length binary is one fragment.
 *
 * Hard cases delegate to the lazy core for the whole file (byte-equivalent by
 * construction): deflate transfer syntax, and any per-element undefined-length
 * non-SQ / unknown-VR case the common-path walker can't faithfully decode.
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

    let dataSet;
    try {
        dataSet = parseDicom(byteArray, {
            vrCallback: parserTag => {
                const ed = DicomMessage.lookupTag(
                    new Tag(parseInt(parserTag.slice(1), 16))
                );
                return ed ? ed.vr : undefined;
            }
        });
    } catch (e) {
        // Tokenizer-rejected file: let the lazy core decide (it delegates to
        // eager and throws the same way).
        return delegate(buffer, listener, options, e);
    }

    // metaWindow: original input buffer, always explicit little endian.
    // Meta element offsets always index the original (possibly compressed)
    // buffer; we construct this before reading the transfer syntax so the TS
    // element can be decoded without a separate stream setup.
    const metaWindow = {
        arrayBuffer: byteArray.buffer,
        baseOffset: byteArray.byteOffset || 0,
        syntax: EXPLICIT_LITTLE_ENDIAN,
        littleEndian: true,
        implicit: false,
        decoder: null
    };

    const policy = {
        forceStoreRaw: !!options.forceStoreRaw,
        noCopy: false,
        ignoreErrors: !!options.ignoreErrors
    };

    const syntax = DicomMessage._normalizeSyntax(
        transferSyntaxOf(dataSet, metaWindow, policy)
    );
    if (syntax === DEFLATED_EXPLICIT_LITTLE_ENDIAN) {
        // Deflate dual-buffer handling is trapped in the lazy core; delegate.
        return delegate(buffer, listener, options);
    }

    // bodyWindow: post-parse buffer with negotiated syntax/endianness/
    // implicitness. decoder starts null; resolved after SpecificCharacterSet
    // is read below.
    const bodyWindow = {
        arrayBuffer: dataSet.byteArray.buffer,
        baseOffset: dataSet.byteArray.byteOffset || 0,
        syntax,
        littleEndian: syntax !== EXPLICIT_BIG_ENDIAN,
        implicit: syntax === IMPLICIT_LITTLE_ENDIAN,
        decoder: null
    };

    listener.startDataSet({ transferSyntaxUID: syntax });

    const elements = dataSet.elements;
    const keys = Object.keys(elements).filter(k => k !== "xfffee00d");
    const metaKeys = keys.filter(k => isMetaKey(k));
    const bodyKeys = keys.filter(k => !isMetaKey(k));

    if (metaKeys.length) {
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

    listener.endDataSet();
}

/** Re-emit the whole file via the slice-A path over the lazy core's decode. */
function delegate(buffer, listener, options, parseError) {
    let dict;
    try {
        dict = DicomMessage.readFile(toArrayBuffer(buffer), options);
    } catch (e) {
        if (parseError) {
            throw parseError;
        }
        throw e;
    }
    return fromDataSet({ meta: dict.meta, dict: dict.dict }, listener);
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

/** Route decoded {values, rawValues} to binary or scalar listener events. */
function emitValues(listener, tag, vrInstance, el, values, rawValues) {
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

/**
 * Read the transfer syntax UID from the dataset using core decode primitives.
 * The TS element lives in group 0002 (always explicit little endian), so
 * metaWindow is the correct window.
 */
function transferSyntaxOf(dataSet, metaWindow, policy) {
    const el = dataSet.elements.x00020010;
    if (!el) {
        return EXPLICIT_LITTLE_ENDIAN;
    }
    const vrInstance = resolveVrInstance(el, metaWindow);
    const { values } = decodeElementValues(metaWindow, el, vrInstance, policy);
    return values[0] || EXPLICIT_LITTLE_ENDIAN;
}

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

function toUint8Array(buffer) {
    if (buffer instanceof Uint8Array) {
        return buffer;
    }
    return new Uint8Array(buffer);
}

function toArrayBuffer(buffer) {
    if (buffer instanceof ArrayBuffer) {
        return buffer.slice(0);
    }
    return buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength
    );
}
