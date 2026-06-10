import pako from "pako";
import { parseDicom } from "@dcmjs/parser";
import { ReadBufferStream } from "../BufferStream.js";
import {
    EXPLICIT_BIG_ENDIAN,
    EXPLICIT_LITTLE_ENDIAN,
    IMPLICIT_LITTLE_ENDIAN,
    VM_DELIMITER,
    TagHex,
    encodingMapping
} from "../constants/dicom.js";
import { DicomDict } from "../DicomDict.js";
import { DicomMessage, singleVRs } from "../DicomMessage.js";
import { Tag } from "../Tag.js";
import { ValueRepresentation } from "../ValueRepresentation.js";
import { log } from "../log.js";

/**
 * Lazy read core (docs roadmap R1+R2).
 *
 * `readFileLazy` parses the file with the offsets-only tokenizer
 * (`@dcmjs/parser`) and wraps every element into a dict entry whose
 * Value/_rawValue materialize on first access through the existing
 * ValueRepresentation classes over a windowed ReadBufferStream.
 *
 * The observable result is equivalent to `DicomMessage.readFile`'s eager
 * core: same DicomDict shape, same entry shape
 * ({ vr, Value, _rawValue } via ValueRepresentation.addTagAccessors),
 * same value/VM shapes (the materialization replicates
 * DicomMessage._readTag's post-processing verbatim).
 *
 * Documented divergences (intentional, pinned by test/lazy-hardening.test.js):
 * because values materialize on access, errors the eager core hits MID-SCAN
 * shift in time and scope.
 *  - ignoreErrors:false + an element whose bytes fail to materialize (e.g.
 *    an unsupported in-sequence-item SpecificCharacterSet, or encapsulated
 *    pixel data whose fragment stream contains a garbage tag): eager throws
 *    during readFile; lazy returns the dict and throws the eager-equivalent
 *    error at FIRST ACCESS of that entry's Value/_rawValue.
 *  - ignoreErrors:true + such an element: eager catches mid-scan and
 *    returns a dict TRUNCATED at the failing element (everything at and
 *    after it is lost); lazy returns the FULL dict and resolves just the
 *    failing entry to Value/_rawValue undefined, logging one warning per
 *    entry - strictly more informative.
 *  - an unsupported in-sequence-item SpecificCharacterSet with
 *    ignoreErrors:true: eager truncates (previous point); lazy warns and
 *    decodes the item with the default character set, exactly like eager
 *    handles a bad TOP-LEVEL SpecificCharacterSet under ignoreErrors.
 *
 * WRITER SEAM (docs roadmap R4 groundwork)
 *
 * Every lazy entry carries non-enumerable writer-facing state:
 *  - `_sourceSpan` { startOffset, endOffset, buffer }: the parser element's
 *    byte span over its source byteArray (`buffer`), INCLUDING the element
 *    header and - for undefined-length SQ elements and encapsulated pixel
 *    data - all item/sequence delimiters, the basic offset table and the
 *    fragments. `buffer.subarray(startOffset, endOffset)` is the element's
 *    exact on-disk encoding. Body entries reference the dataset source
 *    buffer (for the deflated transfer syntax: the header + INFLATED
 *    body buffer the inflater returned);
 *    meta (group 0002) entries reference the original input buffer - meta
 *    is always re-encoded by the writer, the span is informational.
 *    Entries with no faithful span (untilTag stubs, the rewritten
 *    SpecificCharacterSet entry, eager-fallback entries) carry none.
 *  - `_dirty`: false until Value or _rawValue is ASSIGNED, then true.
 *    THE ABSENCE OF `_dirty` MEANS DIRTY: entries built by the eager core,
 *    by DicomDict.upsertTag, or by denaturalize have no `_dirty` property
 *    and the writer must re-encode them (`isCleanForPassthrough` returns
 *    false for them).
 *  - `_nestedDirtCount`: assignment counter for SQ subtrees. Item entries
 *    are created in child contexts holding a reference to their parent SQ
 *    entry; any nested Value/_rawValue assignment bumps the counter on
 *    every enclosing SQ entry up the chain.
 *
 * IMPORTANT - DIRTINESS IS ASSIGNMENT-BASED ONLY, with ONE structural
 * exception for SQ entries. In-place mutation of a materialized value is
 * UNDETECTABLE by the setters: `entry.Value.push(x)`, `entry.Value[0] = x`,
 * or mutating the bytes of a returned binary buffer leaves `_dirty` false
 * and the entry looks clean to the passthrough writer, which would then
 * emit the ORIGINAL bytes. Every edit should go through an assignment
 * (`entry.Value = [...]`, `item["00081150"].Value = [...]`) or through
 * DicomDict.upsertTag.
 *
 * The exception (writer hardening): item dicts returned by a materialized
 * SQ entry are plain objects, so adding or deleting a KEY in one (and
 * pushing/splicing the item array itself) bypasses every setter. Because
 * such structural edits would otherwise be silently dropped,
 * isCleanForPassthrough re-verifies a MATERIALIZED SQ entry's structure
 * against the parsed element at write time (item count, per-item key sets,
 * per-item entry ownership, recursively into materialized nested SQs - see
 * sqStructureDiverged) and re-encodes on any mismatch. Never-materialized
 * SQ entries cannot have been structurally edited and stay clean by
 * construction. Still UNDETECTABLE: in-place mutation of a LEAF entry's
 * materialized value (`item["00081150"].Value[0] = x`) and swapping two
 * items with identical key sets within the same SQ.
 *
 * The DicomDict returned by the lazy path (not the eager fallback) carries
 * a non-enumerable `_lazyWriteContext`
 * { sourceByteArray, sourceSyntax, charsetPassthroughSafe }:
 *  - sourceByteArray: the buffer body `_sourceSpan`s index into;
 *  - sourceSyntax: the file's TransferSyntaxUID exactly as stored
 *    (NOT normalized - the deflated syntax keeps its own UID even though
 *    sourceByteArray holds the inflated, no longer deflated, body);
 *  - charsetPassthroughSafe: true iff the file's original top-level
 *    SpecificCharacterSet is absent, empty, ISO_IR 6 / ISO 2022 IR 6 or
 *    ISO_IR 192 / UTF-8 - i.e. the eager writer's UTF-8 re-encode of
 *    string values is byte-identical to the source bytes for conformant
 *    content, so string-bearing elements may pass through.
 */

/** 'x00080005' (parser key) -> '00080005' (dcmjs clean dict key) */
const parserKeyToClean = key => key.slice(1).toUpperCase();

const META_GROUP = 0x0002;

/** Parser key of the item delimitation pseudo-element (FFFE,E00D) that the
 * tokenizer stores inside undefined-length sequence item dataSets. */
const ITEM_DELIMITER_KEY = "xfffee00d";

/**
 * Inflater callback for parseDicom (deflate transfer syntax,
 * 1.2.840.10008.1.2.1.99). Needed because the parser's built-in node
 * branch requires a Buffer (it calls byteArray.copy), but readFileLazy
 * normalizes input to a plain Uint8Array.
 *
 * Contract (same as the published dicom-parser): return the original
 * header bytes [0, position) followed by the inflated data set - the
 * parser continues the dataset ByteStream at `position` of the returned
 * buffer. Dataset element offsets then index into this header+inflated
 * buffer (whose header prefix is byte-identical to the original input),
 * while meta element offsets index the original (compressed) buffer - the
 * materialization context carries both.
 */
function pakoInflater(byteArray, position) {
    const inflated = pako.inflateRaw(byteArray.subarray(position));
    const fullByteArray = new Uint8Array(position + inflated.length);
    fullByteArray.set(byteArray.subarray(0, position), 0);
    fullByteArray.set(inflated, position);
    return fullByteArray;
}

function isMetaElement(el) {
    return el.tagValue >>> 16 === META_GROUP;
}

/**
 * Bumps the nested-assignment counter on every SQ entry enclosing the
 * entry whose setter fired. `parentEntry` is the SQ entry of the item the
 * assigned entry lives in (null for top-level entries); `_parentEntry`
 * chains item entries to THEIR enclosing SQ, so deep assignments dirty the
 * whole ancestor chain.
 */
function bumpNestedDirt(parentEntry) {
    for (let entry = parentEntry; entry; entry = entry._parentEntry) {
        entry._nestedDirtCount += 1;
    }
}

/**
 * True when any (transitively) nested sequence item carries its own
 * SpecificCharacterSet (0008,0005) element. Materializing such an item
 * REWRITES the stored charset value to ["ISO_IR 192"] (the eager quirk,
 * kept), so the eager writer's output for the enclosing SQ differs from
 * the source bytes by construction - the SQ must not pass through.
 */
function sequenceItemsContainCharset(el) {
    if (!el.items) {
        return false;
    }
    for (const item of el.items) {
        const elements = item.dataSet && item.dataSet.elements;
        if (!elements) {
            continue;
        }
        if (elements.x00080005) {
            return true;
        }
        for (const key in elements) {
            if (sequenceItemsContainCharset(elements[key])) {
                return true;
            }
        }
    }
    return false;
}

/**
 * Writer-seam predicate (docs roadmap R4): true ONLY when the writer may
 * emit `entry._sourceSpan` bytes verbatim instead of re-encoding, i.e. for
 * a LAZY entry that
 *  - was never assigned (`_dirty === false`; THE ABSENCE OF `_dirty` MEANS
 *    DIRTY, so eager/upsertTag/denaturalized entries always re-encode),
 *  - has a faithful `_sourceSpan` (untilTag stubs and the rewritten
 *    SpecificCharacterSet entry do not),
 *  - did not materialize through the eager-window fallback (whose nested
 *    item entries are untracked eager entries),
 *  - for SQ entries: had NO nested item entry assigned (any depth, via the
 *    shared `_nestedDirtCount` chain), contains no in-item
 *    SpecificCharacterSet (whose value materialization rewrites), and - if
 *    its Value HAS materialized - the item dicts still mirror the parsed
 *    items structurally (`_sqStructureDiverged`, which catches setterless
 *    key adds/deletes and item pushes/splices).
 *
 * Pure check: it never materializes the entry (`_sqStructureDiverged` only
 * inspects already-cached state). An entry whose materialization FAILED
 * under ignoreErrors stays clean - its source bytes are the only faithful
 * representation it has.
 *
 * In-place mutation of materialized LEAF values is undetectable here - see
 * the module docblock.
 */
export function isCleanForPassthrough(entry) {
    if (!entry || typeof entry !== "object") {
        return false;
    }
    if (entry._dirty !== false) {
        // covers _dirty === true AND _dirty absent (non-lazy entries)
        return false;
    }
    if (!entry._sourceSpan) {
        return false;
    }
    if (entry._untrackedNested) {
        return false;
    }
    if (entry._nestedDirtCount !== 0) {
        return false;
    }
    if (entry.vr === "SQ" && entry._sqHasItemCharset) {
        return false;
    }
    if (entry.vr === "SQ" && entry._sqStructureDiverged) {
        return false;
    }
    return true;
}

/**
 * Structural verification for a MATERIALIZED SQ entry (writer hardening):
 * true when the cached item dicts no longer mirror the tokenizer's parsed
 * items, i.e. a setterless structural edit happened and the source bytes
 * no longer represent the value. Checked per item, in order:
 *  - the materialized item count must equal the parsed non-empty item
 *    count (wrapSequenceItem skips empty items) - catches item array
 *    push/splice;
 *  - each item dict's key set must exactly match the parsed item's element
 *    keys - catches `item["00080050"] = {...}` adds and
 *    `delete item["0020000E"]` deletes;
 *  - each item dict value must still be the lazy entry built for THIS SQ
 *    (`_dirty` marker present and `_parentEntry === sqEntry`) - catches
 *    whole-entry replacement by a foreign object or an entry transplanted
 *    from another sequence;
 *  - nested SQ entries that materialized are verified recursively (their
 *    own `_sqStructureDiverged`).
 *
 * Never materializes anything: only called with already-cached values.
 */
function sqStructureDiverged(el, values, sqEntry) {
    if (!Array.isArray(values)) {
        return true;
    }
    const items = el.items || [];
    const parsedKeyLists = [];
    for (const item of items) {
        const elements = (item.dataSet && item.dataSet.elements) || {};
        const keys = Object.keys(elements).filter(
            key => key !== ITEM_DELIMITER_KEY
        );
        if (keys.length > 0) {
            parsedKeyLists.push(keys);
        }
    }
    if (values.length !== parsedKeyLists.length) {
        return true;
    }
    for (let i = 0; i < values.length; i++) {
        const itemDict = values[i];
        const keys = parsedKeyLists[i];
        if (!itemDict || typeof itemDict !== "object") {
            return true;
        }
        if (Object.keys(itemDict).length !== keys.length) {
            return true;
        }
        for (const parserKey of keys) {
            const cleanTag = parserKeyToClean(parserKey);
            if (!Object.prototype.hasOwnProperty.call(itemDict, cleanTag)) {
                return true;
            }
            const child = itemDict[cleanTag];
            // replaced/foreign objects lack the `_dirty` marker (absence
            // means dirty) or belong to a different enclosing SQ
            if (
                !child ||
                child._dirty !== false ||
                child._parentEntry !== sqEntry
            ) {
                return true;
            }
            if (child.vr === "SQ" && child._sqStructureDiverged) {
                return true;
            }
        }
    }
    return false;
}

/**
 * Charsets whose conformant content re-encodes to identical bytes under
 * the eager writer's UTF-8 normalization: the default repertoire (absent /
 * empty), ASCII (ISO_IR 6, single-valued ISO 2022 IR 6) and UTF-8 itself
 * (ISO_IR 192). Keys are normalized like resolveCharacterSet normalizes
 * ('_' and ' ' to '-', lowercased).
 */
const PASSTHROUGH_SAFE_CHARSETS = new Set([
    "",
    "iso-ir-6",
    "iso-2022-ir-6",
    "iso-ir-192",
    "utf-8",
    "utf8"
]);

/**
 * Computes `_lazyWriteContext.charsetPassthroughSafe` from the top-level
 * SpecificCharacterSet parser element and the resolveCharacterSet result
 * (null when the element exists but was never resolved - the
 * untilTag-stub corner - which is conservatively unsafe).
 */
function isCharsetPassthroughSafe(csEl, cs) {
    if (!csEl) {
        return true;
    }
    if (!cs || !cs.originalValues) {
        return false;
    }
    const values = cs.originalValues;
    if (values.length === 0) {
        return true;
    }
    if (values.length > 1) {
        // code extensions / multiple charsets: never byte-stable
        return false;
    }
    const coding = String(values[0]).replace(/[_ ]/g, "-").toLowerCase();
    return PASSTHROUGH_SAFE_CHARSETS.has(coding);
}

/**
 * EAGER FALLBACK (whole file): delegates the complete read to the eager
 * core with the caller's original buffer and options. Used when the
 * offsets-only tokenizer cannot parse the stream at all (it is stricter
 * than the eager reader: e.g. it rejects trailing elements whose declared
 * length overruns the buffer, and it predates the UV/SV/OV 32-bit-length
 * VRs) or when the file is missing the part-10 plumbing the lazy wrap
 * needs (meta group length with ignoreErrors, transfer syntax). The
 * result - including any error eager itself throws - is byte-identical to
 * the eager core by construction; only the entry property shape (data
 * properties instead of lazy getters) differs, which is unobservable
 * through normal value access.
 */
function readFileWithEagerCore(buffer, options) {
    return DicomMessage.readFile(buffer, { ...options, core: "eager" });
}

function toUint8Array(buffer) {
    if (buffer instanceof Uint8Array) {
        return buffer;
    }
    if (ArrayBuffer.isView(buffer)) {
        return new Uint8Array(
            buffer.buffer,
            buffer.byteOffset,
            buffer.byteLength
        );
    }
    return new Uint8Array(buffer);
}

/**
 * Resolves the ValueRepresentation instance for a parser element,
 * replicating DicomMessage._readTag's VR resolution rules
 * (src/DicomMessage.js, explicit + implicit branches).
 *
 * Meta (group 0002) elements are always explicit little endian.
 */
function resolveVrInstance(el, ctx, isMeta) {
    const implicit = ctx.implicit && !isMeta;

    if (!implicit) {
        const vrType = el.vr;
        if (vrType === "UN") {
            const tag = new Tag(el.tagValue);
            const elementData = DicomMessage.lookupTag(tag);
            if (elementData && elementData.vr) {
                // UN with a known dictionary VR: eager re-parses the value
                // as the dictionary VR via ParsedUnknownValue.
                return ValueRepresentation.parseUnknownVr(elementData.vr);
            }
        }
        return ValueRepresentation.createByTypeString(vrType);
    }

    // Implicit VR: dictionary lookup with _readTag's fallback rules.
    const tag = new Tag(el.tagValue);
    const elementData = DicomMessage.lookupTag(tag);
    let vrType;
    if (elementData) {
        vrType = elementData.vr;
    } else if (el.hadUndefinedLength) {
        // eager: length == UNDEFINED_LENGTH (the parser corrects element
        // .length for undefined-length elements, so use the flag)
        vrType = "SQ";
    } else if (tag.isPixelDataTag()) {
        vrType = "OW";
    } else if (tag.isPrivateCreator()) {
        vrType = "LO";
    } else {
        // (_readTag also has a `vrType == "xs"` arm here, but vrType is
        // always undefined at that point in the eager code - unreachable.)
        vrType = "UN";
    }
    return ValueRepresentation.createByTypeString(vrType);
}

/**
 * True when resolveVrInstance produced a ParsedUnknownValue (UN element with
 * a known dictionary VR): those are per-call instances, while every plain VR
 * resolves to the shared VRinstances singleton.
 */
function isParsedUnknownVr(vrInstance) {
    return (
        vrInstance !== ValueRepresentation.createByTypeString(vrInstance.type)
    );
}

/**
 * NARROW FALLBACK: eagerly re-reads a single element by running
 * DicomMessage._readTag over a window covering the element's full span
 * [startOffset, endOffset) - header, value, items and delimiters. This
 * delegates the rare shapes the structural paths below do not cover (see
 * call sites) to the exact eager code, so results are byte-equivalent by
 * construction - including eager's error behavior for malformed framing.
 *
 * Values produced here may contain nested item dicts of EAGER entries,
 * whose assignments the dirt tracking cannot see - the owning lazy entry
 * (when there is one) is flagged `_untrackedNested` so
 * isCleanForPassthrough denies it.
 */
function materializeWithEagerReadTag(ctx, el, isMeta, entry) {
    if (entry) {
        entry._untrackedNested = true;
    }
    const syntax = isMeta ? EXPLICIT_LITTLE_ENDIAN : ctx.syntax;
    const littleEndian = isMeta ? true : ctx.littleEndian;
    const arrayBuffer = isMeta ? ctx.metaArrayBuffer : ctx.arrayBuffer;
    const baseOffset = isMeta ? ctx.metaBaseOffset : ctx.baseOffset;
    const start = baseOffset + el.startOffset;
    const stop = baseOffset + el.endOffset;
    const stream = new ReadBufferStream(arrayBuffer, littleEndian, {
        start,
        stop,
        // eager's body stream carries noCopy; its meta stream comes from
        // stream.more(), which drops it
        noCopy: isMeta ? false : ctx.noCopy
    });
    if (!isMeta && ctx.decoder) {
        stream.setDecoder(ctx.decoder);
    }
    const readInfo = DicomMessage._readTag(stream, syntax, {
        untilTag: null,
        includeUntilTagValue: false,
        forceStoreRaw: ctx.forceStoreRaw
    });
    return { values: readInfo.values, rawValues: readInfo.rawValues };
}

/**
 * Verbatim replication of DicomMessage._readTag's value-shaping block
 * (src/DicomMessage.js:380-402): string VM splitting, the SQ and OW/OB
 * passthroughs and the array-or-push fallback (which yields
 * `_rawValue: [undefined]` for non-raw-storing VRs like UN/OF/OD - a quirk
 * the lazy core must reproduce).
 */
function shapeReadValues(vr, rawValue, value) {
    let values = [];
    let rawValues = [];
    if (!vr.isBinary() && singleVRs.indexOf(vr.type) == -1) {
        rawValues = rawValue;
        values = value;
        if (typeof value === "string") {
            const delimiterChar = String.fromCharCode(VM_DELIMITER);
            rawValues = vr.dropPadByte(rawValue.split(delimiterChar));
            values = vr.dropPadByte(value.split(delimiterChar));
        }
    } else if (vr.type == "SQ") {
        rawValues = rawValue;
        values = value;
    } else if (vr.type == "OW" || vr.type == "OB") {
        rawValues = rawValue;
        values = value;
    } else {
        Array.isArray(value) ? (values = value) : values.push(value);
        Array.isArray(rawValue)
            ? (rawValues = rawValue)
            : rawValues.push(rawValue);
    }
    return { values, rawValues };
}

/**
 * Replicates ValueRepresentation.read's raw-value retention rule
 * (src/ValueRepresentation.js:213-215) for values produced outside vr.read.
 */
function retainRaw(ctx, vr, producedValue) {
    return vr.storeRaw() || ctx.forceStoreRaw ? producedValue : undefined;
}

/**
 * Materializes one element's { values, rawValues } from its byte window.
 *
 * Routing:
 *  - plain SQ -> structural wrap of the tokenizer's items (no byte scan);
 *  - encapsulated pixel data -> frame assembly from the tokenizer's
 *    fragments/basicOffsetTable (no byte scan);
 *  - other undefined-length elements (UN-as-implicit-SQ, ParsedUnknownValue
 *    with undefined length, delimiter-scanned values) -> eager re-read of
 *    the element span, byte-equivalent by construction;
 *  - everything else -> faithful replication of the value phase of
 *    DicomMessage._readTag (src/DicomMessage.js:342-402): the same vr.read
 *    call, the same binary VM splitting, the same value shaping.
 */
function materializeElement(ctx, el, vrInstance, isMeta, entry) {
    // identity check: a ParsedUnknownValue with dictionary VR "SQ" is a
    // per-call instance, not the shared SQ singleton, and must keep eager's
    // ParsedUnknownValue.read path (window read below / fallback).
    if (vrInstance === ValueRepresentation.createByTypeString("SQ")) {
        return materializeSequence(ctx, el, vrInstance, isMeta, entry);
    }
    if (el.hadUndefinedLength) {
        if (el.encapsulatedPixelData && !isParsedUnknownVr(vrInstance)) {
            return materializeEncapsulatedPixelData(
                ctx,
                el,
                vrInstance,
                isMeta,
                entry
            );
        }
        // UN parsed as implicit SQ by the tokenizer, ParsedUnknownValue with
        // undefined length, delimiter-scanned values: eager interprets these
        // through BinaryRepresentation's encapsulated branch (treating the
        // first item as a BOT), which throws on most real-world sequences -
        // delegate to the eager code for byte-identical values AND errors.
        return materializeWithEagerReadTag(ctx, el, isMeta, entry);
    }

    const syntax = isMeta ? EXPLICIT_LITTLE_ENDIAN : ctx.syntax;
    const littleEndian = isMeta ? true : ctx.littleEndian;
    const vr = vrInstance;
    const length = el.length;
    const arrayBuffer = isMeta ? ctx.metaArrayBuffer : ctx.arrayBuffer;
    const baseOffset = isMeta ? ctx.metaBaseOffset : ctx.baseOffset;
    const start = baseOffset + el.dataOffset;
    const stream = new ReadBufferStream(arrayBuffer, littleEndian, {
        start,
        stop: start + length,
        // eager's body stream carries noCopy (getBuffer then returns
        // Uint8Array instead of ArrayBuffer); its meta stream comes from
        // stream.more(), which drops it
        noCopy: isMeta ? false : ctx.noCopy
    });
    if (!isMeta && ctx.decoder) {
        stream.setDecoder(ctx.decoder);
    }
    const readOptions = { forceStoreRaw: ctx.forceStoreRaw };

    if (vr.isBinary() && length > vr.maxLength && !vr.noMultiple) {
        const values = [];
        const rawValues = [];
        const times = length / vr.maxLength;
        let i = 0;
        while (i++ < times) {
            const { rawValue, value } = vr.read(
                stream,
                vr.maxLength,
                syntax,
                readOptions
            );
            rawValues.push(rawValue);
            values.push(value);
        }
        return { values, rawValues };
    }
    const { rawValue, value } =
        vr.read(stream, length, syntax, readOptions) || {};
    return shapeReadValues(vr, rawValue, value);
}

/**
 * Structural SQ materialization: entry.Value = array of item dicts built
 * from the tokenizer's already-parsed `items` (no byte scanning). Mirrors
 * SequenceOfItems.readBytes (src/ValueRepresentation.js:1108-1201) +
 * the nested DicomMessage._read it performs per item:
 *  - empty items (defined length 0, or undefined length with an immediate
 *    item delimiter) are skipped, like eager's `if (toRead)` guard;
 *  - each item is read as its own dataset with a fresh default decoder
 *    (eager's stream.more() creates a new latin1 stream) and without
 *    forceStoreRaw (eager's nested _read drops the read options);
 *  - a per-item SpecificCharacterSet (0008,0005) resolves a per-item
 *    decoder, replicating the nested _read's charset handling. Eager only
 *    applies it to elements after 0008,0005 in stream order; the lazy core
 *    applies it to the whole item - indistinguishable for conformant
 *    datasets where 0008,0005 precedes all encoded strings.
 */
function materializeSequence(ctx, el, vrInstance, isMeta, entry) {
    if (!el.items) {
        if (el.length === 0) {
            // eager: SequenceOfItems.readBytes returns [] for zero length
            const values = [];
            return {
                values,
                rawValues: retainRaw(ctx, vrInstance, values)
            };
        }
        // The tokenizer treated the element as opaque (e.g. defined-length
        // private SQ in implicit syntax, or a dictionary/peek mismatch):
        // re-read the span with the eager code.
        return materializeWithEagerReadTag(ctx, el, isMeta, entry);
    }

    const values = [];
    for (const item of el.items) {
        const itemDict = wrapSequenceItem(ctx, item, entry);
        if (itemDict !== null) {
            values.push(itemDict);
        }
    }
    return { values, rawValues: retainRaw(ctx, vrInstance, values) };
}

/**
 * Wraps one tokenizer sequence item ({ dataSet }) into a lazy item dict, or
 * null for empty items (which eager never emits).
 *
 * @param parentEntry the lazy entry of the enclosing SQ element; the child
 *     context carries it so nested Value/_rawValue assignments bump the
 *     dirt counter of every enclosing SQ entry (writer seam, R4).
 */
function wrapSequenceItem(ctx, item, parentEntry) {
    const elements = (item.dataSet && item.dataSet.elements) || {};
    const keys = Object.keys(elements).filter(
        key => key !== ITEM_DELIMITER_KEY
    );
    if (keys.length === 0) {
        return null;
    }

    // Fresh decoder + dropped forceStoreRaw: see materializeSequence doc.
    // noCopy is dropped too: eager reads items from stream.more(), which
    // creates the item stream without the noCopy flag.
    const childCtx = {
        ...ctx,
        decoder: null,
        forceStoreRaw: false,
        noCopy: false,
        parentEntry: parentEntry || null
    };
    // Per-item charset resolution honors ignoreErrors (eager's nested _read
    // always runs with ignoreErrors:false and lets the outer read TRUNCATE
    // the dict; the lazy core instead applies the same warn-and-continue
    // handling eager uses for a top-level charset - documented divergence).
    // Residual (non-charset) errors follow the H2 policy: rethrow without
    // ignoreErrors (error at first access of the enclosing SQ), warn and
    // fall back to the default decoder with it.
    let cs = null;
    try {
        cs = resolveCharacterSet(
            childCtx,
            elements.x00080005,
            ctx.ignoreErrors
        );
    } catch (err) {
        if (!ctx.ignoreErrors) {
            throw err;
        }
        log.warn("WARN:", err);
    }

    const dict = {};
    for (const key of keys) {
        const el = elements[key];
        const cleanTag = parserKeyToClean(el.tag);
        let entry;
        if (cleanTag === TagHex.SpecificCharacterSet && cs) {
            // seeded with the REWRITTEN ["ISO_IR 192"] value: its source
            // bytes no longer represent it, so it carries no _sourceSpan
            entry = createLazyEntry(
                childCtx,
                el,
                cs.vrInstance,
                false,
                cleanTag,
                cs.seedState,
                true
            );
        } else {
            const vrInstance = resolveVrInstance(el, childCtx, false);
            entry = createLazyEntry(childCtx, el, vrInstance, false, cleanTag);
        }
        dict[cleanTag] = entry;
    }
    return dict;
}

/**
 * Encapsulated pixel data frame assembly from the tokenizer's
 * fragments/basicOffsetTable - a structural replication of
 * BinaryRepresentation.readBytes' undefined-length branch
 * (src/ValueRepresentation.js:508-624) without re-scanning bytes:
 *  - with a BOT: one frame per BOT entry; fragments are grouped into
 *    [BOT[i], BOT[i+1]) windows; a single-fragment frame is that fragment's
 *    buffer, a multi-fragment frame is merged into one ArrayBuffer;
 *  - without a BOT: one frame PER FRAGMENT, matching eager's existing
 *    1-fragment=1-frame behavior.
 *    TODO(1.0 API decision): eager conflates fragments and frames when no
 *    BOT is present (a multi-fragment frame comes out as several "frames");
 *    keep matching it until the 1.0 framing decision lands.
 *
 * noCopy mirrors eager's observable shapes (BufferStream.getBuffer wraps
 * the slice in a Uint8Array when stream.noCopy is set, and the BOT branch
 * returns the raw fragment list for multi-fragment frames instead of
 * merging): fragment buffers come out as Uint8Arrays and BOT
 * multi-fragment frames as arrays of fragment Uint8Arrays. Like eager's
 * post-SplitDataView getBuffer, the bytes are still copies - only the
 * wrapper type changes.
 */
function materializeEncapsulatedPixelData(ctx, el, vrInstance, isMeta, entry) {
    if (ctx.encapsulatedScanWarning) {
        // The tokenizer hit a tag that is neither an item nor the sequence
        // delimiter while scanning this element's fragments; it records a
        // warning and a clamped fragment and keeps going
        // (packages/parser/src/findEndOfEncapsulatedPixelData.js). The eager
        // core throws when its own item walk reaches that tag - surface the
        // eager-equivalent error at access (under ignoreErrors:true,
        // ensureMaterialized converts it to a warn + undefined entry).
        throw Error("Invalid tag in sequence");
    }
    const fragments = el.fragments || [];
    const bot = el.basicOffsetTable || [];
    // eager: stream.getBuffer -> ArrayBuffer copy, or Uint8Array over the
    // copy when the stream has noCopy
    const wrapBuffer = buf => (ctx.noCopy ? new Uint8Array(buf) : buf);
    const fragmentBuffer = f =>
        wrapBuffer(
            ctx.arrayBuffer.slice(
                ctx.baseOffset + f.position,
                ctx.baseOffset + f.position + f.length
            )
        );

    let frames;
    if (bot.length > 0) {
        // Eager starts a fresh item scan at every BOT offset; if a BOT entry
        // does not land exactly on a fragment boundary that scan throws.
        // Delegate to the eager code for byte-identical behavior.
        const fragmentStarts = new Set(fragments.map(f => f.offset));
        if (!bot.every(offset => fragmentStarts.has(offset))) {
            return materializeWithEagerReadTag(ctx, el, isMeta, entry);
        }
        frames = [];
        for (let i = 0; i < bot.length; i++) {
            const start = bot[i];
            const stop =
                i + 1 < bot.length ? bot[i + 1] : Number.POSITIVE_INFINITY;
            const frameFragments = fragments.filter(
                f => f.offset >= start && f.offset < stop
            );
            if (frameFragments.length === 1) {
                frames.push(fragmentBuffer(frameFragments[0]));
            } else if (ctx.noCopy) {
                // eager noCopy: the fragment list itself is the frame, for
                // downstream application to process
                frames.push(frameFragments.map(fragmentBuffer));
            } else {
                // eager merges multi-fragment frames into one ArrayBuffer
                const frameSize = frameFragments.reduce(
                    (size, f) => size + f.length,
                    0
                );
                const merged = new Uint8Array(frameSize);
                let position = 0;
                for (const f of frameFragments) {
                    merged.set(
                        new Uint8Array(
                            ctx.arrayBuffer,
                            ctx.baseOffset + f.position,
                            f.length
                        ),
                        position
                    );
                    position += f.length;
                }
                frames.push(merged.buffer);
            }
        }
    } else {
        frames = fragments.map(fragmentBuffer);
    }

    return shapeReadValues(
        vrInstance,
        retainRaw(ctx, vrInstance, frames),
        frames
    );
}

/**
 * Mirrors the eager assignment path `dict[tag].Value = values`, which runs
 * through the addTagAccessors proxy set-trap and applies
 * vr.addValueAccessors (PN boxing/toJSON) to the stored value.
 */
function applyValueAccessors(vrType, values) {
    if (vrType && ValueRepresentation.hasValueAccessors(vrType)) {
        return ValueRepresentation.createByTypeString(vrType).addValueAccessors(
            values
        );
    }
    return values;
}

/**
 * Builds a lazy dict entry with the same observable shape as the eager
 * `{ vr, Value, _rawValue }` entry. Value/_rawValue are getter-backed and
 * materialize (then cache) on first access. Setters replace the cached
 * value; setting Value OR _rawValue flips the non-enumerable `_dirty` flag
 * and bumps the nested dirt counter of every enclosing SQ entry
 * (groundwork for the passthrough writer, docs roadmap R4 - see the
 * module docblock for the full writer-seam contract).
 *
 * @param seedState optional pre-materialized { values, rawValues } (used
 *     for the transfer syntax and SpecificCharacterSet entries which the
 *     wrap step has to resolve eagerly anyway).
 * @param omitSpan true for entries whose source bytes do not faithfully
 *     represent their value (the rewritten SpecificCharacterSet entry, the
 *     widened undefined-length untilTag element) - they carry no
 *     `_sourceSpan` and can never pass through.
 */
function createLazyEntry(
    ctx,
    el,
    vrInstance,
    isMeta,
    cleanTag,
    seedState,
    omitSpan
) {
    const vrType = vrInstance.type;

    let state = seedState
        ? {
              values: applyValueAccessors(vrType, seedState.values),
              rawValues: seedState.rawValues
          }
        : null;
    let valueAssigned = false;
    let assignedValue;
    let rawAssigned = false;
    let assignedRaw;

    const entry = { vr: vrType };
    Object.defineProperties(entry, {
        // false = clean; assignment flips it. Non-lazy entries lack the
        // property entirely: ABSENCE MEANS DIRTY (writer must re-encode).
        _dirty: {
            value: false,
            writable: true,
            enumerable: false,
            configurable: true
        },
        // enclosing SQ entry (null at top level): the bump chain for
        // nested assignments
        _parentEntry: {
            value: ctx.parentEntry || null,
            enumerable: false,
            configurable: true
        },
        // number of Value/_rawValue assignments anywhere below this entry
        // (only ever non-zero for SQ entries)
        _nestedDirtCount: {
            value: 0,
            writable: true,
            enumerable: false,
            configurable: true
        },
        // set when the eager-window fallback produced the value: nested
        // item entries (if any) are untracked eager entries
        _untrackedNested: {
            value: false,
            writable: true,
            enumerable: false,
            configurable: true
        }
    });
    if (!omitSpan) {
        Object.defineProperty(entry, "_sourceSpan", {
            value: {
                startOffset: el.startOffset,
                endOffset: el.endOffset,
                buffer: isMeta ? ctx.metaSourceByteArray : ctx.sourceByteArray
            },
            enumerable: false,
            configurable: true
        });
    }
    if (vrType === "SQ") {
        // lazily computed (write-time) - see sequenceItemsContainCharset
        Object.defineProperty(entry, "_sqHasItemCharset", {
            get: () => sequenceItemsContainCharset(el),
            enumerable: false,
            configurable: true
        });
        // Write-time structural verification (writer hardening): a
        // materialized SQ's item dicts are plain objects, so key
        // adds/deletes and item pushes bypass the Value/_rawValue setters.
        // Never-materialized entries (state === null) cannot have been
        // structurally edited and stay clean without materializing.
        Object.defineProperty(entry, "_sqStructureDiverged", {
            get: () =>
                state !== null && sqStructureDiverged(el, state.values, entry),
            enumerable: false,
            configurable: true
        });
    }

    const ensureMaterialized = () => {
        if (state === null) {
            if (ctx.onMaterialize) {
                ctx.onMaterialize(cleanTag);
            }
            try {
                const { values, rawValues } = materializeElement(
                    ctx,
                    el,
                    vrInstance,
                    isMeta,
                    entry
                );
                state = {
                    values: applyValueAccessors(vrType, values),
                    rawValues
                };
            } catch (err) {
                if (!ctx.ignoreErrors) {
                    // error-at-first-access (documented divergence: eager
                    // throws the same error during readFile)
                    throw err;
                }
                // ignoreErrors: eager warns and TRUNCATES the dict at the
                // failing element; lazy warns (once - the state is cached)
                // and resolves just this entry to undefined.
                log.warn("WARN:", err);
                state = { values: undefined, rawValues: undefined };
            }
        }
        return state;
    };

    Object.defineProperty(entry, "Value", {
        enumerable: true,
        configurable: true,
        get() {
            return valueAssigned ? assignedValue : ensureMaterialized().values;
        },
        set(v) {
            assignedValue = v;
            valueAssigned = true;
            entry._dirty = true;
            bumpNestedDirt(ctx.parentEntry);
        }
    });
    Object.defineProperty(entry, "_rawValue", {
        enumerable: true,
        configurable: true,
        get() {
            return rawAssigned ? assignedRaw : ensureMaterialized().rawValues;
        },
        set(v) {
            assignedRaw = v;
            rawAssigned = true;
            // a raw assignment makes the source bytes stale exactly like a
            // Value assignment does (writer seam: the eager writer prefers
            // _rawValue when Value is untouched)
            entry._dirty = true;
            bumpNestedDirt(ctx.parentEntry);
        }
    });

    // Same wrapping the eager reader applies (proxy only for VRs with
    // value accessors, i.e. PN); the proxy set-trap forwards through the
    // accessor properties defined above.
    return ValueRepresentation.addTagAccessors(entry);
}

/**
 * Resolves the dataset decoder from SpecificCharacterSet (00080005) with
 * the exact eager semantics of DicomMessage._read (src/DicomMessage.js:77-105):
 * encodingMapping lookup, warn-or-throw per ignoreErrors for unsupported or
 * multiple charsets, and the entry Value rewritten to ["ISO_IR 192"] while
 * _rawValue keeps the original.
 *
 * Returns the seed state for the 00080005 entry, or null if absent.
 * Sets ctx.decoder as a side effect.
 */
function resolveCharacterSet(ctx, csEl, ignoreErrors) {
    if (!csEl) {
        return null;
    }
    const vrInstance = resolveVrInstance(csEl, ctx, false);
    // Read with the default (latin1) decoder, exactly like the eager loop
    // does before it reaches the setDecoder call.
    const { values, rawValues } = materializeElement(
        ctx,
        csEl,
        vrInstance,
        false
    );

    if (values.length > 0) {
        let coding = values[0];
        coding = coding.replace(/[_ ]/g, "-").toLowerCase();
        if (coding in encodingMapping) {
            coding = encodingMapping[coding];
            ctx.decoder = new TextDecoder(coding);
        } else if (ignoreErrors) {
            log.warn(
                `Unsupported character set: ${coding}, using default character set`
            );
        } else {
            throw Error(`Unsupported character set: ${coding}`);
        }
    }
    if (values.length > 1) {
        if (ignoreErrors) {
            log.warn(
                "Using multiple character sets is not supported, proceeding with just the first character set",
                values
            );
        } else {
            throw Error(
                `Using multiple character sets is not supported: ${values}`
            );
        }
    }

    return {
        vrInstance,
        // the values as stored in the file, BEFORE the ISO_IR 192 rewrite
        // (consumed by the charsetPassthroughSafe computation)
        originalValues: values,
        seedState: {
            // change SpecificCharacterSet to UTF-8 (eager quirk, kept)
            values: ["ISO_IR 192"],
            rawValues
        }
    };
}

/**
 * Replicates the entry the eager core stores for the untilTag element when
 * includeUntilTagValue is false: _readTag returns { tag, vr: 0, values: 0 }
 * (src/DicomMessage.js:311-314), which _read stores as
 * { vr: undefined, Value: 0, _rawValue: undefined } - except for
 * SpecificCharacterSet, whose Value the charset branch unconditionally
 * rewrites to ["ISO_IR 192"] (src/DicomMessage.js:117) even on the stub.
 */
function createUntilTagStubEntry(cleanTag) {
    const entry = ValueRepresentation.addTagAccessors({ vr: undefined });
    entry.Value = cleanTag === TagHex.SpecificCharacterSet ? ["ISO_IR 192"] : 0;
    entry._rawValue = undefined;
    return entry;
}

/**
 * Lazy core entry point: parseDicom (offsets only) -> lazy DicomDict.
 *
 * @param {ArrayBuffer|Uint8Array} buffer
 * @param {Object} options DicomMessage.readFile options. Honored here:
 *     ignoreErrors, untilTag, includeUntilTagValue, forceStoreRaw, noCopy,
 *     onMaterialize (test/instrumentation callback invoked with the clean
 *     tag string on each lazy materialization).
 * @returns {DicomDict}
 */
export function readFileLazy(buffer, options = {}) {
    const {
        ignoreErrors = false,
        untilTag = null,
        includeUntilTagValue = false,
        forceStoreRaw = false,
        noCopy = false,
        onMaterialize = null
    } = options;

    // dcmjs untilTag is a clean 8-char uppercase string; the parser takes
    // 'x' + lowercase and stops INCLUSIVE of that element, like eager's
    // body loop (store entry, then break). Eager compares the candidate
    // against Tag.toCleanString() EXACTLY, so any untilTag that is not its
    // own canonical uppercase clean form (lowercase hex, separators, wrong
    // length, ...) never matches and the whole file parses - honor only
    // canonical values and ignore everything else, like eager.
    let untilState = null;
    if (untilTag && /^[0-9A-F]{8}$/.test(untilTag)) {
        if (untilTag === TagHex.FileMetaInformationGroupLength) {
            // eager consumes (0002,0000) BEFORE the windowed meta read, so
            // this untilTag never matches an emitted element and the whole
            // file parses - ignore it.
        } else if (untilTag.slice(0, 4) === "0002") {
            // The parser always reads the full meta group, so a meta
            // untilTag is emulated by truncating the wrapped meta.
            if (untilTag < TagHex.TransferSyntaxUID) {
                // Eager crashes outright (TypeError dereferencing the
                // missing 0002,0010 entry) when the cut hides the transfer
                // syntax - refuse with a clear error instead.
                throw new Error(
                    "DicomMessage.readFile: untilTag before TransferSyntaxUID is not supported by the lazy core"
                );
            }
            if (
                untilTag === TagHex.TransferSyntaxUID &&
                !includeUntilTagValue
            ) {
                // Eager stores the stub entry { Value: 0 } for 0002,0010,
                // reads `(0)[0]` -> undefined as the transfer syntax and
                // parses the WHOLE BODY as explicit little endian, whatever
                // the real syntax is. The tokenizer has already framed the
                // body with the REAL syntax, so delegate the whole file to
                // the eager core for exact (byte-identical) replication.
                return readFileWithEagerCore(buffer, options);
            }
            untilState = {
                parserKey: "x" + untilTag.toLowerCase(),
                isMeta: true,
                passed: false
            };
        } else {
            untilState = {
                parserKey: "x" + untilTag.toLowerCase(),
                isMeta: false,
                passed: false
            };
        }
    }

    const byteArray = toUint8Array(buffer);
    const parseOptions = {
        untilTag:
            untilState && !untilState.isMeta ? untilState.parserKey : undefined,
        inflater: pakoInflater,
        // Implicit-VR framing: without a dictionary the tokenizer guesses
        // SQ-ness by peeking for an FFFE,E000 item tag at the value start,
        // which misframes defined-length elements whose first value bytes
        // mimic an item tag. Inject the SAME dictionary VR resolution
        // eager's _readTag implicit branch uses (the parser package itself
        // stays dictionary-free); undefined for unknown tags keeps the peek
        // heuristic as the fallback, mirroring eager's own fallback rules.
        vrCallback: parserTag => {
            const elementData = DicomMessage.lookupTag(
                new Tag(parseInt(parserTag.slice(1), 16))
            );
            return elementData ? elementData.vr : undefined;
        }
    };

    let dataSet;
    try {
        dataSet = parseDicom(byteArray, parseOptions);
    } catch {
        // The tokenizer rejected the stream (truncated file, declared
        // lengths overrunning the buffer, VRs it predates like UV/SV/OV,
        // missing part-10 plumbing, ...). The eager reader is more lenient
        // in several of these cases, and with ignoreErrors it recovers
        // partial dicts with its own stop-positions - delegate the whole
        // read so both the recovered data AND any error are exactly
        // eager's.
        return readFileWithEagerCore(buffer, options);
    }

    const elements = dataSet.elements;

    const glEl =
        elements[`x${TagHex.FileMetaInformationGroupLength.toLowerCase()}`];
    if (!glEl) {
        // eager readFile requires the meta group length element...
        if (!ignoreErrors) {
            throw new Error(
                "Invalid DICOM file, meta length tag is malformed or not present."
            );
        }
        // ...and with ignoreErrors re-scans the meta group sequentially
        // (untilTag 00030000 / stopOnGreaterTag). The parser's recovery
        // scan is not guaranteed to stop at the same element, so delegate.
        return readFileWithEagerCore(buffer, options);
    }

    // Eager windows the meta group by the (0002,0000) VALUE
    // (stream.more(metaLength), src/DicomMessage.js) while the tokenizer
    // scans until the first tag with group > 0002. When the recorded group
    // length does not land exactly on the tokenizer's meta/body boundary,
    // the two cores would partition elements between meta and dict
    // differently - delegate the whole file to the eager core, which is
    // byte-identical by construction.
    if (glEl.hadUndefinedLength || glEl.length !== 4) {
        return readFileWithEagerCore(buffer, options);
    }
    const metaLength =
        (byteArray[glEl.dataOffset] |
            (byteArray[glEl.dataOffset + 1] << 8) |
            (byteArray[glEl.dataOffset + 2] << 16) |
            (byteArray[glEl.dataOffset + 3] << 24)) >>>
        0;
    const eagerMetaEnd = glEl.dataOffset + glEl.length + metaLength;
    let tokenizerMetaEnd = 0;
    for (const key in elements) {
        const el = elements[key];
        if (isMetaElement(el) && el.endOffset > tokenizerMetaEnd) {
            tokenizerMetaEnd = el.endOffset;
        }
    }
    if (eagerMetaEnd !== tokenizerMetaEnd) {
        return readFileWithEagerCore(buffer, options);
    }

    const tsEl = elements.x00020010;
    if (!tsEl) {
        // eager dereferences metaHeader[TransferSyntaxUID].Value and throws
        // a TypeError; delegate for the exact same observable behavior.
        return readFileWithEagerCore(buffer, options);
    }

    // Per-dataset materialization context. Body element offsets index into
    // dataSet.byteArray, which is the input buffer - or, for the deflated
    // transfer syntax, the header + inflated body buffer the inflater
    // returned. Meta (group 0002) element offsets always index into the
    // ORIGINAL input buffer, so the context carries both windows.
    const ctx = {
        arrayBuffer: dataSet.byteArray.buffer,
        baseOffset: dataSet.byteArray.byteOffset || 0,
        metaArrayBuffer: byteArray.buffer,
        metaBaseOffset: byteArray.byteOffset || 0,
        // _sourceSpan buffers (writer seam): body element offsets index
        // dataSet.byteArray (header + inflated body for the deflated
        // syntax), meta element offsets index the original input buffer
        sourceByteArray: dataSet.byteArray,
        metaSourceByteArray: byteArray,
        // lazy entry of the enclosing SQ element (nested dirt tracking);
        // null at the top level, set per item by wrapSequenceItem
        parentEntry: null,
        syntax: EXPLICIT_LITTLE_ENDIAN,
        littleEndian: true,
        implicit: false,
        decoder: null,
        forceStoreRaw: !!forceStoreRaw,
        noCopy: !!noCopy,
        ignoreErrors: !!ignoreErrors,
        // parser warning emitted while scanning encapsulated pixel data
        // fragments (clamped garbage fragment); the eager core THROWS on
        // the same bytes, so materializeEncapsulatedPixelData re-raises the
        // eager-equivalent error at access.
        encapsulatedScanWarning:
            (dataSet.warnings || []).find(
                warning =>
                    typeof warning === "string" &&
                    warning.indexOf("unexpected tag") !== -1 &&
                    warning.indexOf(
                        "while searching for end of pixel data element"
                    ) !== -1
            ) || null,
        onMaterialize
    };

    // Transfer syntax: materialized eagerly (it drives every other read).
    const tsVrInstance = resolveVrInstance(tsEl, ctx, true);
    const tsState = materializeElement(ctx, tsEl, tsVrInstance, true);
    const mainSyntax = tsState.values[0];
    ctx.syntax = DicomMessage._normalizeSyntax(mainSyntax);
    ctx.littleEndian = ctx.syntax !== EXPLICIT_BIG_ENDIAN;
    ctx.implicit = ctx.syntax === IMPLICIT_LITTLE_ENDIAN;

    // Character set: resolved once per dataset (eager swaps the decoder
    // when the read loop passes 00080005; tag ordering guarantees every
    // encoded-string element comes after it). When 00080005 itself is the
    // untilTag with includeUntilTagValue=false, eager never reads its value
    // (and never swaps the decoder) - skip resolution to match.
    const csElement =
        untilState &&
        untilState.parserKey === "x00080005" &&
        !includeUntilTagValue
            ? null
            : elements.x00080005;
    const cs = resolveCharacterSet(ctx, csElement, ignoreErrors);

    const meta = {};
    const dict = {};

    for (const key in elements) {
        let el = elements[key];
        const isMeta = isMetaElement(el);
        const cleanTag = parserKeyToClean(el.tag);

        if (isMeta && cleanTag === TagHex.FileMetaInformationGroupLength) {
            // eager readFile consumes (0002,0000) to window the meta group
            // and never puts it in DicomDict.meta.
            continue;
        }

        if (untilState && untilState.isMeta && isMeta && untilState.passed) {
            // meta untilTag: eager's meta _read breaks at the untilTag, so
            // later meta elements (in stream order) never reach the dict.
            continue;
        }
        const isUntilTagElement = untilState && el.tag === untilState.parserKey;

        let entry;
        if (isUntilTagElement && !includeUntilTagValue) {
            entry = createUntilTagStubEntry(cleanTag);
        } else if (isMeta && cleanTag === TagHex.TransferSyntaxUID) {
            entry = createLazyEntry(
                ctx,
                el,
                tsVrInstance,
                true,
                cleanTag,
                tsState
            );
        } else if (!isMeta && cleanTag === TagHex.SpecificCharacterSet && cs) {
            // seeded with the REWRITTEN ["ISO_IR 192"] value: its source
            // bytes no longer represent it, so it carries no _sourceSpan
            entry = createLazyEntry(
                ctx,
                el,
                cs.vrInstance,
                false,
                cleanTag,
                cs.seedState,
                true
            );
        } else {
            let omitSpan = false;
            if (isUntilTagElement && el.hadUndefinedLength) {
                // the parser does not consume the untilTag element's value,
                // so endOffset only covers the header; widen the (fallback)
                // re-read window to the end of the buffer - _readTag stops
                // at the element's own delimiters, like eager. The widened
                // endOffset is a read window, NOT the element's span - no
                // _sourceSpan.
                el = { ...el, endOffset: dataSet.byteArray.length };
                omitSpan = true;
            }
            const vrInstance = resolveVrInstance(el, ctx, isMeta);
            entry = createLazyEntry(
                ctx,
                el,
                vrInstance,
                isMeta,
                cleanTag,
                undefined,
                omitSpan
            );
        }

        if (isUntilTagElement && untilState.isMeta) {
            untilState.passed = true;
        }

        if (isMeta) {
            meta[cleanTag] = entry;
        } else {
            dict[cleanTag] = entry;
        }
    }

    const dicomDict = new DicomDict(meta);
    dicomDict.dict = dict;
    // Writer seam (R4): only the lazy path attaches this - dicts from the
    // whole-file eager fallback (or built any other way) lack it, and the
    // writer must re-encode everything for them.
    Object.defineProperty(dicomDict, "_lazyWriteContext", {
        value: {
            sourceByteArray: dataSet.byteArray,
            sourceSyntax: mainSyntax,
            charsetPassthroughSafe: isCharsetPassthroughSafe(
                elements.x00080005,
                cs
            )
        },
        enumerable: false,
        configurable: true
    });
    return dicomDict;
}
