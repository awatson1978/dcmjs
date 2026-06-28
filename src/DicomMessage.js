import { DeflatedReadBufferStream, ReadBufferStream } from "./BufferStream.js";
import {
    DEFLATED_EXPLICIT_LITTLE_ENDIAN,
    EXPLICIT_BIG_ENDIAN,
    EXPLICIT_LITTLE_ENDIAN,
    IMPLICIT_LITTLE_ENDIAN,
    VM_DELIMITER,
    TagHex,
    encodingMapping,
    unencapsulatedTransferSyntaxes,
    UNDEFINED_LENGTH
} from "./constants/dicom.js";
import { DicomDict } from "./DicomDict.js";
import { DicomMetaDictionary } from "./DicomMetaDictionary.js";
import { Tag } from "./Tag.js";
import { log } from "./log.js";
import { deepEqual } from "./utilities/deepEqual";
import { ValueRepresentation } from "./ValueRepresentation.js";
import { readFileLazy, isCleanForPassthrough } from "./lazy/LazyDicomReader.js";

export const singleVRs = ["SQ", "OF", "OW", "OB", "UN", "LT"];

export class DicomMessage {
    /**
     * Default read core for readFile: 'lazy' (offsets-only tokenizer +
     * on-access materialization, the 1.0 default) or 'eager' (the
     * historical in-place reader, kept as the escape hatch). Overridable
     * per call via options.core and globally via the DCMJS_CORE
     * environment variable (DCMJS_CORE=eager restores the old behavior).
     */
    static defaultCore =
        (typeof process !== "undefined" &&
            process.env &&
            process.env.DCMJS_CORE) ||
        "lazy";

    static _read(
        bufferStream,
        syntax,
        options = {
            ignoreErrors: false,
            untilTag: null,
            includeUntilTagValue: false,
            stopOnGreaterTag: false
        }
    ) {
        const { ignoreErrors, untilTag, stopOnGreaterTag } = options;
        var dict = {};
        try {
            let previousTagOffset;
            while (!bufferStream.end()) {
                previousTagOffset = bufferStream.offset;
                const readInfo = DicomMessage._readTag(
                    bufferStream,
                    syntax,
                    options
                );
                const cleanTagString = readInfo.tag.toCleanString();
                if (untilTag && stopOnGreaterTag && cleanTagString > untilTag) {
                    bufferStream.offset = previousTagOffset;
                    break;
                }
                if (cleanTagString === TagHex.SpecificCharacterSet) {
                    if (readInfo.values.length > 0) {
                        let coding = readInfo.values[0];
                        coding = coding.replace(/[_ ]/g, "-").toLowerCase();
                        if (coding in encodingMapping) {
                            coding = encodingMapping[coding];
                            bufferStream.setDecoder(new TextDecoder(coding));
                        } else if (ignoreErrors) {
                            log.warn(
                                `Unsupported character set: ${coding}, using default character set`
                            );
                        } else {
                            throw Error(`Unsupported character set: ${coding}`);
                        }
                    }
                    if (readInfo.values.length > 1) {
                        if (ignoreErrors) {
                            log.warn(
                                "Using multiple character sets is not supported, proceeding with just the first character set",
                                readInfo.values
                            );
                        } else {
                            throw Error(
                                `Using multiple character sets is not supported: ${readInfo.values}`
                            );
                        }
                    }
                    readInfo.values = ["ISO_IR 192"]; // change SpecificCharacterSet to UTF-8
                }

                dict[cleanTagString] = ValueRepresentation.addTagAccessors({
                    vr: readInfo.vr.type
                });
                dict[cleanTagString].Value = readInfo.values;
                dict[cleanTagString]._rawValue = readInfo.rawValues;

                if (untilTag && untilTag === cleanTagString) {
                    break;
                }
            }
            return dict;
        } catch (err) {
            if (ignoreErrors) {
                log.warn("WARN:", err);
                return dict;
            }
            throw err;
        }
    }

    static _normalizeSyntax(syntax) {
        if (
            syntax == IMPLICIT_LITTLE_ENDIAN ||
            syntax == EXPLICIT_LITTLE_ENDIAN ||
            syntax == EXPLICIT_BIG_ENDIAN
        ) {
            return syntax;
        } else {
            return EXPLICIT_LITTLE_ENDIAN;
        }
    }

    static isEncapsulated(syntax) {
        return !unencapsulatedTransferSyntaxes[syntax];
    }

    static readFile(
        buffer,
        options = {
            ignoreErrors: false,
            untilTag: null,
            includeUntilTagValue: false,
            noCopy: false,
            forceStoreRaw: false
        }
    ) {
        const core = (options && options.core) || DicomMessage.defaultCore;
        if (core === "lazy") {
            return readFileLazy(buffer, options);
        }
        if (core !== "eager") {
            throw new Error(
                `Unknown DicomMessage.readFile core: ${core} (expected 'eager' or 'lazy')`
            );
        }
        var stream = new ReadBufferStream(buffer, null, {
                noCopy: options.noCopy
            }),
            useSyntax = EXPLICIT_LITTLE_ENDIAN;
        stream.reset();
        stream.increment(128);
        if (stream.readAsciiString(4) !== "DICM") {
            throw new Error("Invalid DICOM file, expected header is missing");
        }

        // save position before reading first tag
        var metaStartPos = stream.offset;

        // read the first tag to check if it's the meta length tag
        var el = DicomMessage._readTag(stream, useSyntax);

        var metaHeader = {};
        if (el.tag.cleanString !== TagHex.FileMetaInformationGroupLength) {
            // meta length tag is missing
            if (!options.ignoreErrors) {
                throw new Error(
                    "Invalid DICOM file, meta length tag is malformed or not present."
                );
            }

            // reset stream to the position where we started reading tags
            stream.offset = metaStartPos;

            // read meta header elements sequentially
            metaHeader = DicomMessage._read(stream, useSyntax, {
                untilTag: "00030000",
                stopOnGreaterTag: true,
                ignoreErrors: true
            });
        } else {
            // meta length tag is present
            var metaLength = el.values[0];

            // read header buffer using the specified meta length
            var metaStream = stream.more(metaLength);
            metaHeader = DicomMessage._read(metaStream, useSyntax, options);
        }

        //get the syntax
        var mainSyntax = metaHeader[TagHex.TransferSyntaxUID].Value[0];

        //in case of deflated dataset, decompress and continue
        if (mainSyntax === DEFLATED_EXPLICIT_LITTLE_ENDIAN) {
            stream = new DeflatedReadBufferStream(stream, {
                noCopy: options.noCopy
            });
        }

        mainSyntax = DicomMessage._normalizeSyntax(mainSyntax);
        var objects = DicomMessage._read(stream, mainSyntax, options);

        var dicomDict = new DicomDict(metaHeader);
        dicomDict.dict = objects;

        return dicomDict;
    }

    static writeTagObject(stream, tagString, vr, values, syntax, writeOptions) {
        var tag = Tag.fromString(tagString);

        tag.write(stream, vr, values, syntax, writeOptions);
    }

    /**
     * Writes the elements of jsonObjects to useStream in sorted tag order.
     *
     * `lazyWriteContext` (R4 passthrough fast path) is the dict-level
     * `_lazyWriteContext` a lazy read attaches: when the target BODY
     * syntax equals the source's BODY syntax (the deflated transfer
     * syntax differs from explicit little endian only in the stream-level
     * deflate wrapper - element bytes are ELE on both sides, and a
     * deflated source's spans already index the INFLATED body buffer) and
     * the source charset is byte-stable under the writer's UTF-8
     * normalization, every clean lazy
     * entry (isCleanForPassthrough) is emitted as its verbatim source span
     * - header, value, items and delimiters byte-identical - instead of
     * being re-encoded. Dirty, foreign and span-less entries take the
     * re-encode path unchanged. Callers that pass no context (the meta
     * group, nested sequence items, non-lazy dicts) always re-encode.
     */
    static write(
        jsonObjects,
        useStream,
        syntax,
        writeOptions,
        lazyWriteContext = null
    ) {
        var written = 0;

        // W4: compare BODY syntaxes - the deflated syntax is the ELE body
        // in a deflate wrapper, and DicomDict.write hands this function
        // the pre-deflate body stream, so passthrough applies in every
        // deflated/ELE source-target combination.
        const toBodySyntax = candidate =>
            candidate === DEFLATED_EXPLICIT_LITTLE_ENDIAN
                ? EXPLICIT_LITTLE_ENDIAN
                : candidate;
        // Writer hardening: an encoding-affecting writeOption set to a
        // NON-DEFAULT value asks for bytes the source file does not
        // contain, so emitting source spans would silently ignore it.
        // Passthrough is disabled for the WHOLE dict in that case - simpler
        // and safer than tracking which elements the option touches, and
        // these options are rare. Today the only such option is
        // fragmentMultiframe (default true via
        // `{ fragmentMultiframe = true } = writeOptions` in
        // BinaryRepresentation.writeBytes; it re-fragments encapsulated
        // pixel data). allowInvalidVRLength (default false) is deliberately
        // NOT in this set: it gates write-time validation only, and
        // byte-faithful passthrough legitimately preserves invalid stored
        // lengths (pinned in test/data.test.js).
        const nonDefaultEncodingOptions =
            writeOptions != null &&
            writeOptions.fragmentMultiframe !== undefined &&
            !writeOptions.fragmentMultiframe;
        const passthroughSource =
            !nonDefaultEncodingOptions &&
            lazyWriteContext &&
            lazyWriteContext.charsetPassthroughSafe &&
            toBodySyntax(syntax) === toBodySyntax(lazyWriteContext.sourceSyntax)
                ? lazyWriteContext.sourceByteArray
                : null;

        var sortedTags = Object.keys(jsonObjects).sort();
        sortedTags.forEach(function (tagString) {
            var tagObject = jsonObjects[tagString],
                vrType = tagObject.vr;

            if (passthroughSource && isCleanForPassthrough(tagObject)) {
                const span = tagObject._sourceSpan;
                // The span must index the buffer the context describes:
                // an entry transplanted from another lazy dict carries
                // bytes this context's syntax/charset checks know nothing
                // about, so it re-encodes.
                if (span.buffer === passthroughSource) {
                    written += useStream.writeRawBytes(
                        span.buffer.subarray(span.startOffset, span.endOffset)
                    );
                    return;
                }
            }

            var tag = Tag.fromString(tagString);

            var values = DicomMessage._getTagWriteValues(vrType, tagObject);

            written += tag.write(
                useStream,
                vrType,
                values,
                syntax,
                writeOptions
            );
        });

        return written;
    }

    static _getTagWriteValues(vrType, tagObject) {
        if (!tagObject._rawValue) {
            return tagObject.Value;
        }

        // apply VR specific formatting to the original _rawValue and compare to the Value
        const vr = ValueRepresentation.createByTypeString(vrType);

        let originalValue;
        if (Array.isArray(tagObject._rawValue)) {
            originalValue = tagObject._rawValue.map(val =>
                vr.applyFormatting(val)
            );
        } else {
            originalValue = vr.applyFormatting(tagObject._rawValue);
        }

        // if Value has not changed, write _rawValue unformatted back into the file
        if (deepEqual(tagObject.Value, originalValue)) {
            return tagObject._rawValue;
        } else {
            return tagObject.Value;
        }
    }

    static _readTag(
        stream,
        syntax,
        options = {
            untilTag: null,
            includeUntilTagValue: false
        }
    ) {
        const { untilTag, includeUntilTagValue } = options;
        var implicit = syntax == IMPLICIT_LITTLE_ENDIAN ? true : false,
            isLittleEndian =
                syntax == IMPLICIT_LITTLE_ENDIAN ||
                syntax == EXPLICIT_LITTLE_ENDIAN
                    ? true
                    : false;

        var oldEndian = stream.isLittleEndian;
        stream.setEndian(isLittleEndian);
        var tag = Tag.readTag(stream);

        if (untilTag === tag.toCleanString() && untilTag !== null) {
            if (!includeUntilTagValue) {
                return { tag: tag, vr: 0, values: 0 };
            }
        }

        var length = null,
            vr = null,
            vrType;

        if (implicit) {
            length = stream.readUint32();
            var elementData = DicomMessage.lookupTag(tag);
            if (elementData) {
                vrType = elementData.vr;
            } else {
                //unknown tag
                if (length == UNDEFINED_LENGTH) {
                    vrType = "SQ";
                } else if (tag.isPixelDataTag()) {
                    vrType = "OW";
                } else if (vrType == "xs") {
                    vrType = "US";
                } else if (tag.isPrivateCreator()) {
                    vrType = "LO";
                } else {
                    vrType = "UN";
                }
            }
            vr = ValueRepresentation.createByTypeString(vrType);
        } else {
            vrType = stream.readVR();

            if (
                vrType === "UN" &&
                DicomMessage.lookupTag(tag) &&
                DicomMessage.lookupTag(tag).vr
            ) {
                vrType = DicomMessage.lookupTag(tag).vr;

                vr = ValueRepresentation.parseUnknownVr(vrType);
            } else {
                vr = ValueRepresentation.createByTypeString(vrType);
            }

            if (vr.isLength32()) {
                stream.increment(2);
                length = stream.readUint32();
            } else {
                length = stream.readUint16();
            }
        }

        var values = [];
        var rawValues = [];
        if (vr.isBinary() && length > vr.maxLength && !vr.noMultiple) {
            var times = length / vr.maxLength,
                i = 0;
            while (i++ < times) {
                const { rawValue, value } = vr.read(
                    stream,
                    vr.maxLength,
                    syntax,
                    options
                );
                rawValues.push(rawValue);
                values.push(value);
            }
        } else {
            const { rawValue, value } =
                vr.read(stream, length, syntax, options) || {};
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
        }
        stream.setEndian(oldEndian);

        const retObj = ValueRepresentation.addTagAccessors({
            tag: tag,
            vr: vr
        });
        retObj.values = values;
        retObj.rawValues = rawValues;
        return retObj;
    }

    static lookupTag(tag) {
        return DicomMetaDictionary.dictionary[tag.toString()];
    }
}
