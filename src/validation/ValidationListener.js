/**
 * ValidationListener — event-stream validation (layers 1+2, layer-3 seam).
 *
 * An EventStreamListener that runs the layer-1 structural checks as values
 * arrive (nothing buffered), captures the layer-2 scalars and the
 * accumulated PixelData byte length (from binaryFragment byte lengths —
 * fragments are never retained), and populates the minimal layer-3
 * collector. `finish()` runs the cross-field layers and returns the result,
 * so huge files validate streaming with O(paths) memory:
 *
 *   const listener = new ValidationListener(options);
 *   await fromPart10Stream(chunks, listener, readOptions);
 *   const result = listener.finish();
 *
 * The deliberate bounded exceptions to "retain nothing": file meta element
 * values (to recompute (0002,0000)), SpecificCharacterSet values, and the
 * scalar capture tags — all a handful of short values.
 */

import { EventStreamListener } from "../eventStream/EventStreamListener.js";
import { TagHex } from "../constants/dicom.js";
import {
    ValidationCollector,
    SCALAR_TAGS,
    PALETTE_DESCRIPTOR_TAGS,
    PALETTE_DATA_TAGS
} from "./collector.js";
import { IssueReporter, summarize } from "./result.js";
import {
    checkVrLegality,
    checkValueFormat,
    checkVmCount,
    checkCharset,
    hasNonAscii
} from "./layer1.js";
import { runLayer2, computeMetaGroupLength } from "./layer2.js";
import { runLayer3, resolveIod } from "./layer3.js";

const DEFAULT_LAYERS = [1, 2];

function isGroupLengthTag(tag) {
    return tag.slice(4) === "0000";
}

function isPrivateTag(tag) {
    return parseInt(tag.charAt(3), 16) % 2 === 1;
}

function isStringy(value) {
    return typeof value === "string" || value instanceof String;
}

export class ValidationListener extends EventStreamListener {
    /**
     * @param {Object} [options]
     * @param {number[]} [options.layers=[1,2]] which layers to run
     * @param {string[]} [options.ignore] rule ids to suppress
     * @param {number} [options.maxIssues] hard cap on reported issues
     * @param {...Object} filters event-stream filters (EventStreamListener)
     */
    constructor(options = {}, ...filters) {
        super(...filters);
        this.options = options;
        this.layers = options.layers || DEFAULT_LAYERS;
        this.reporter = new IssueReporter(options);
        this.collector = new ValidationCollector();
        this._layer1 = this.layers.includes(1);
        this._inMeta = false;
        this._metaElements = [];
        this._element = null;
        this._finished = null;
    }

    // --- Lifecycle ----------------------------------------------------------

    _baseStartDataSet(info = {}) {
        if (info.transferSyntaxUID) {
            this.collector.transferSyntaxUid = info.transferSyntaxUID;
        }
    }

    _baseEndDataSet() {}

    _baseStartFileMetaInformation() {
        this._inMeta = true;
        this.collector.fmi.present = true;
    }

    _baseEndFileMetaInformation() {
        this._inMeta = false;
        this.collector.fmi.computedGroupLength = computeMetaGroupLength(
            this._metaElements
        );
    }

    // --- Elements -----------------------------------------------------------

    _baseStartElement(tag, info = {}) {
        const cleanTag = String(tag).toUpperCase();
        const skip = isGroupLengthTag(cleanTag) || isPrivateTag(cleanTag);
        const retainValues =
            this._inMeta ||
            cleanTag === TagHex.SpecificCharacterSet ||
            (this.collector.depth === 0 &&
                (cleanTag in SCALAR_TAGS ||
                    cleanTag in PALETTE_DESCRIPTOR_TAGS));
        this._element = {
            tag: cleanTag,
            vr: info.vr,
            path: this.collector.pathFor(cleanTag),
            skip,
            retainValues,
            count: 0,
            values: retainValues ? [] : null,
            isBinary: false,
            encapsulated: false,
            binaryBytes: null,
            fragmentCount: 0,
            zeroLengthFragments: 0,
            basicOffsetTable: null,
            bulkReference: false
        };
        if (this._layer1 && !skip) {
            checkVrLegality(
                cleanTag,
                info.vr,
                this._element.path,
                this.reporter
            );
        }
    }

    _baseValue(v, opts = {}) {
        const element = this._element;
        if (!element) {
            return;
        }
        element.count++;
        if (element.retainValues) {
            element.values.push(v);
        }
        if (this._layer1 && !element.skip) {
            checkValueFormat(
                element.tag,
                element.vr,
                v,
                opts.rawValue,
                element.path,
                this.reporter
            );
        }
        if (
            !this._inMeta &&
            !this.collector.nonAsciiPath &&
            isStringy(v) &&
            hasNonAscii(String(v))
        ) {
            this.collector.nonAsciiPath = element.path;
        }
    }

    _baseBulkDataReference() {
        if (this._element) {
            this._element.bulkReference = true;
        }
    }

    _baseEndElement() {
        const element = this._element;
        this._element = null;
        if (!element) {
            return;
        }
        const nonEmpty =
            element.count > 0 ||
            (element.binaryBytes || 0) > 0 ||
            element.bulkReference;

        if (this._inMeta) {
            this._metaElements.push({
                tag: element.tag,
                vr: element.vr,
                values: element.values || [],
                binaryBytes: element.isBinary ? element.binaryBytes : null
            });
            if (
                element.tag === TagHex.FileMetaInformationGroupLength &&
                element.count
            ) {
                this.collector.fmi.declaredGroupLength = element.values[0];
            }
            if (element.tag === TagHex.TransferSyntaxUID && element.count) {
                this.collector.transferSyntaxUid = String(element.values[0]);
            }
            return;
        }

        if (this._layer1 && !element.skip && !element.isBinary) {
            checkVmCount(
                element.tag,
                element.count,
                element.path,
                this.reporter
            );
        }
        this.collector.markPath(element.path, nonEmpty);
        this._capture(element);
    }

    /** Layer-2 scalar / charset / pixel capture at endElement. */
    _capture(element) {
        const { tag } = element;
        if (tag === TagHex.SpecificCharacterSet) {
            const values = element.values || [];
            if (this.collector.depth === 0) {
                this.collector.charsetValues = values.slice();
            }
            if (this._layer1) {
                checkCharset(values, tag, element.path, this.reporter);
            }
            return;
        }
        if (this.collector.depth !== 0) {
            return;
        }
        if (tag in SCALAR_TAGS && element.count) {
            this.collector.scalars[SCALAR_TAGS[tag]] = element.values[0];
            if (tag === "00080016") {
                this.collector.sopClassUid = String(element.values[0]).trim();
            }
            return;
        }
        if (tag in PALETTE_DESCRIPTOR_TAGS && element.count) {
            this.collector.palette.descriptors[PALETTE_DESCRIPTOR_TAGS[tag]] =
                element.values.slice();
            return;
        }
        if (tag in PALETTE_DATA_TAGS) {
            this.collector.palette.dataLengths[PALETTE_DATA_TAGS[tag]] =
                element.isBinary
                    ? element.binaryBytes
                    : element.count
                    ? element.count * 2
                    : null;
            return;
        }
        if (tag === TagHex.PixelData) {
            this.collector.pixelData = {
                byteLength: element.binaryBytes || 0,
                fragmentCount: element.fragmentCount,
                zeroLengthFragments: element.zeroLengthFragments,
                encapsulated: element.encapsulated,
                basicOffsetTable: element.basicOffsetTable,
                bulkReference: element.bulkReference
            };
        }
    }

    // --- Sequences ----------------------------------------------------------

    _baseStartSequence(tag, info = {}) {
        const cleanTag = String(tag).toUpperCase();
        const skip = isGroupLengthTag(cleanTag) || isPrivateTag(cleanTag);
        if (this._layer1 && !skip && !this._inMeta) {
            checkVrLegality(
                cleanTag,
                info.vr,
                this.collector.pathFor(cleanTag),
                this.reporter
            );
        }
        if (this._inMeta) {
            this._metaElements.push({
                tag: cleanTag,
                vr: "SQ",
                values: [],
                binaryBytes: null
            });
        } else {
            this.collector.markPath(this.collector.pathFor(cleanTag), false);
        }
        this.collector.enterSequence(cleanTag);
    }

    _baseEndSequence() {
        this.collector.exitSequence();
    }

    _baseStartItem() {
        if (!this._inMeta) {
            this.collector.markPath(this.collector.currentSequencePath(), true);
        }
    }

    _baseEndItem() {}

    // --- Binary -------------------------------------------------------------

    _baseStartBinary(info = {}) {
        const element = this._element;
        if (!element) {
            return;
        }
        element.isBinary = true;
        element.encapsulated = !!info.encapsulated;
        element.binaryBytes = 0;
        if (info.basicOffsetTable && info.basicOffsetTable.length) {
            element.basicOffsetTable = Array.from(info.basicOffsetTable);
        }
    }

    _baseBinaryFragment(chunk) {
        const element = this._element;
        if (!element) {
            return;
        }
        const byteLength =
            chunk && chunk.byteLength !== undefined
                ? chunk.byteLength
                : (chunk && chunk.length) || 0;
        element.binaryBytes = (element.binaryBytes || 0) + byteLength;
        element.fragmentCount++;
        if (!byteLength) {
            element.zeroLengthFragments++;
        }
    }

    _baseEndBinary() {}

    // --- Result -------------------------------------------------------------

    /**
     * Run the cross-field layers and assemble the result. Idempotent.
     * @returns {{ok: boolean, issues: Array, summary: Object}}
     */
    finish() {
        if (this._finished) {
            return this._finished;
        }
        const layersRun = [];
        if (this._layer1) {
            layersRun.push(1);
        }
        if (this.layers.includes(2)) {
            runLayer2(this.collector, this.reporter);
            layersRun.push(2);
        }
        if (this.layers.includes(3)) {
            for (const issue of runLayer3(this.collector, this.options)) {
                this.reporter.report(issue);
            }
            layersRun.push(3);
        }
        const iod = resolveIod(this.collector.sopClassUid);
        this._finished = summarize(this.reporter.issues, {
            sopClassUid: this.collector.sopClassUid || undefined,
            iod: iod ? iod.ciodId : undefined,
            layersRun
        });
        return this._finished;
    }
}
