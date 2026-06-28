import { parseDicom } from "@dcmjs/parser";
import { ReadBufferStream } from "../BufferStream.js";
import { ValueRepresentation } from "../ValueRepresentation.js";
import { DicomMessage } from "../DicomMessage.js";
import { Tag } from "../Tag.js";
import {
    EXPLICIT_LITTLE_ENDIAN,
    EXPLICIT_BIG_ENDIAN,
    IMPLICIT_LITTLE_ENDIAN,
    DEFLATED_EXPLICIT_LITTLE_ENDIAN,
    VM_DELIMITER,
    encodingMapping
} from "../constants/dicom.js";
import { fromDataSet } from "./fromDataSet.js";

/**
 * fromPart10 — slice B: a genuine raw-bytes Part 10 -> event-stream generator.
 *
 * Walks @dcmjs/parser's offsets tree in source order and emits the event-stream
 * contract, decoding each element with dcmjs's public primitives
 * (ReadBufferStream + ValueRepresentation.read) plus faithful copies of the
 * small pure helpers (resolveVrInstance, shapeReadValues). Encapsulated pixel
 * data is emitted as RAW fragments (§33); frame grouping is naturalization
 * (slice D). Defined-length binary is one fragment.
 *
 * Hard cases delegate to the lazy core for the whole file (byte-equivalent by
 * construction): deflate transfer syntax, and any per-element undefined-length
 * non-SQ / unknown-VR case the common-path walker can't faithfully decode.
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

    const syntax = DicomMessage._normalizeSyntax(transferSyntaxOf(dataSet));
    if (syntax === DEFLATED_EXPLICIT_LITTLE_ENDIAN) {
        // Deflate dual-buffer handling is trapped in the lazy core; delegate.
        return delegate(buffer, listener, options);
    }

    const ctx = {
        arrayBuffer: dataSet.byteArray.buffer,
        baseOffset: dataSet.byteArray.byteOffset,
        syntax,
        littleEndian: syntax !== EXPLICIT_BIG_ENDIAN,
        implicit: syntax === IMPLICIT_LITTLE_ENDIAN,
        forceStoreRaw: !!options.forceStoreRaw,
        ignoreErrors: !!options.ignoreErrors
    };

    // A control-flow signal used to bail out to whole-file delegation when a
    // per-element hard case is reached.
    const HARD = Symbol("hard-case");

    try {
        listener.startDataSet({ transferSyntaxUID: syntax });

        const elements = dataSet.elements;
        const keys = Object.keys(elements).filter(k => k !== "xfffee00d");
        const metaKeys = keys.filter(k => isMetaKey(k));
        const bodyKeys = keys.filter(k => !isMetaKey(k));

        if (metaKeys.length) {
            listener.startFileMetaInformation();
            for (const key of metaKeys) {
                emitElement(listener, ctx, elements[key], true, HARD);
            }
            listener.endFileMetaInformation();
        }

        const decoder = resolveDecoder(ctx, elements.x00080005);
        for (const key of bodyKeys) {
            emitElement(listener, ctx, elements[key], false, HARD, decoder);
            await listener.awaitDrain();
        }

        listener.endDataSet();
    } catch (signal) {
        if (signal === HARD) {
            return delegate(buffer, listener, options);
        }
        throw signal;
    }
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

function emitElement(listener, ctx, el, isMeta, HARD, decoder) {
    const tag = cleanTag(el);
    const vr = resolveVrInstance(el, ctx, isMeta);

    // Plain sequence (defined or undefined length).
    if (vr.type === "SQ" && el.items) {
        listener.startSequence(tag, { vr: vr.type, length: el.length });
        for (const item of el.items) {
            listener.startItem({ length: item.length });
            const itemElements = (item.dataSet && item.dataSet.elements) || {};
            const itemDecoder =
                resolveDecoder(ctx, itemElements.x00080005) || decoder;
            for (const key of Object.keys(itemElements)) {
                if (key === "xfffee00d") continue;
                emitElement(
                    listener,
                    ctx,
                    itemElements[key],
                    isMeta,
                    HARD,
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
        listener.startElement(tag, { vr: vr.type, length: el.length });
        listener.startBinary({ encapsulated: true });
        for (const f of el.fragments) {
            listener.binaryFragment(fragmentBuffer(ctx, f));
        }
        listener.endBinary();
        listener.endElement();
        return;
    }

    // Other undefined-length cases are hard: delegate the whole file.
    if (el.hadUndefinedLength) {
        throw HARD;
    }

    // Decode the value(s) with the same primitives readFile uses, then route by
    // the DECODED type: byte-blob VRs (OB/OW/OF/OD/UN) produce ArrayBuffers and
    // go to the binary sub-stream; everything else (incl. numeric "binary" VRs
    // like SL/US which decode to numbers) goes to value().
    const stream = elementStream(ctx, el, isMeta, decoder);
    const values = decodeValues(
        vr,
        stream,
        el.length,
        readSyntax(ctx, isMeta),
        ctx
    );

    if (values.some(isBufferLike)) {
        listener.startElement(tag, { vr: vr.type, length: el.length });
        listener.startBinary({ encapsulated: false });
        for (const buf of values) {
            listener.binaryFragment(buf);
        }
        listener.endBinary();
        listener.endElement();
        return;
    }

    listener.startElement(tag, { vr: vr.type, length: el.length });
    let index = 0;
    for (const v of values) {
        listener.value(v, { index: index++ });
    }
    listener.endElement();
}

/** Mirror materializeElement's value phase: numeric multi-read loop + shaping. */
function decodeValues(vr, stream, length, syntax, ctx) {
    const opts = { forceStoreRaw: ctx.forceStoreRaw };
    if (vr.isBinary() && vr.maxLength && length > vr.maxLength) {
        const out = [];
        const times = length / vr.maxLength;
        for (let i = 0; i < times; i++) {
            out.push(vr.read(stream, vr.maxLength, syntax, opts).value);
        }
        return out;
    }
    const result = vr.read(stream, length, syntax, opts) || {};
    return shapeReadValues(vr, result.value);
}

function isBufferLike(v) {
    return v instanceof ArrayBuffer || ArrayBuffer.isView(v);
}

// --- decode helpers (faithful copies of the lazy core's pure helpers) -------

function resolveVrInstance(el, ctx, isMeta) {
    const implicit = ctx.implicit && !isMeta;
    if (!implicit) {
        const vrType = el.vr;
        if (vrType === "UN") {
            const ed = DicomMessage.lookupTag(new Tag(el.tagValue));
            if (ed && ed.vr) {
                return ValueRepresentation.parseUnknownVr(ed.vr);
            }
        }
        return ValueRepresentation.createByTypeString(vrType);
    }
    const tag = new Tag(el.tagValue);
    const ed = DicomMessage.lookupTag(tag);
    let vrType;
    if (ed) {
        vrType = ed.vr;
    } else if (el.hadUndefinedLength) {
        vrType = "SQ";
    } else if (tag.isPixelDataTag()) {
        vrType = "OW";
    } else if (tag.isPrivateCreator()) {
        vrType = "LO";
    } else {
        vrType = "UN";
    }
    return ValueRepresentation.createByTypeString(vrType);
}

function shapeReadValues(vr, value) {
    if (vr.allowMultiple()) {
        if (typeof value === "string") {
            return vr.dropPadByte(
                value.split(String.fromCharCode(VM_DELIMITER))
            );
        }
        return Array.isArray(value) ? value : [value];
    }
    if (vr.type === "SQ" || vr.type === "OW" || vr.type === "OB") {
        return Array.isArray(value) ? value : [value];
    }
    return Array.isArray(value) ? value : [value];
}

function resolveDecoder(ctx, csEl) {
    if (!csEl) {
        return null;
    }
    const stream = elementStream(ctx, csEl, false, null);
    const vr = ValueRepresentation.createByTypeString(csEl.vr || "CS");
    const { value } = vr.read(stream, csEl.length, EXPLICIT_LITTLE_ENDIAN, {
        forceStoreRaw: false
    });
    const first = Array.isArray(value) ? value[0] : value;
    if (!first) {
        return null;
    }
    const coding = String(first).replace(/[_ ]/g, "-").toLowerCase();
    if (coding in encodingMapping) {
        return new TextDecoder(encodingMapping[coding]);
    }
    return null;
}

// --- byte-window helpers ----------------------------------------------------

function elementStream(ctx, el, isMeta, decoder) {
    const start = ctx.baseOffset + el.dataOffset;
    const stream = new ReadBufferStream(
        ctx.arrayBuffer,
        readLittleEndian(ctx, isMeta),
        {
            start,
            stop: start + el.length
        }
    );
    if (!isMeta && decoder) {
        stream.setDecoder(decoder);
    }
    return stream;
}

function fragmentBuffer(ctx, f) {
    const start = ctx.baseOffset + f.position;
    return ctx.arrayBuffer.slice(start, start + f.length);
}

function readSyntax(ctx, isMeta) {
    return isMeta ? EXPLICIT_LITTLE_ENDIAN : ctx.syntax;
}

function readLittleEndian(ctx, isMeta) {
    return isMeta ? true : ctx.littleEndian;
}

// --- misc -------------------------------------------------------------------

function transferSyntaxOf(dataSet) {
    const el = dataSet.elements.x00020010;
    if (!el) {
        return EXPLICIT_LITTLE_ENDIAN;
    }
    const start = dataSet.byteArray.byteOffset + el.dataOffset;
    const stream = new ReadBufferStream(dataSet.byteArray.buffer, true, {
        start,
        stop: start + el.length
    });
    const vr = ValueRepresentation.createByTypeString("UI");
    const { value } = vr.read(stream, el.length, EXPLICIT_LITTLE_ENDIAN, {
        forceStoreRaw: false
    });
    return Array.isArray(value) ? value[0] : value;
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
