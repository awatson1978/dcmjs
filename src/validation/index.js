/**
 * dcmjs.validate — the layered validation engine (v2.0 Workstream B).
 *
 * This PR ships layers 1 (structural) and 2 (cross-field) plus the layer-3
 * (IOD/module) seam; layer 3 itself lands in a later PR and currently
 * reports a single `iod.unavailable` INFO when requested.
 *
 *   const result = await validate(datasetOrDict, {
 *       layers: [1, 2],          // default; add 3 for the IOD stub
 *       ignore: ["vr.pattern"],  // rule ids to suppress
 *       maxIssues: 500           // hard cap
 *   });
 *   result.ok / result.issues / result.summary
 *
 * Accepted inputs:
 *   - a DicomDict-like `{ meta?, dict }` (e.g. DicomMessage.readFile output)
 *     or a bare tag-keyed `{ "GGGGEEEE": { vr, Value } }` tree — replayed
 *     through the shared event-stream generator (fromDataSet) so eager and
 *     streamed validation run the exact same checks;
 *   - a naturalized dataset (keyword keys) — walked with the equivalent
 *     synthetic event emission.
 *
 * For streaming, use ValidationListener directly with fromPart10Stream and
 * call listener.finish().
 */

import { fromDataSet } from "../eventStream/fromDataSet.js";
import { ValidationListener } from "./ValidationListener.js";
import { ruleForKeyword, allowedVrs } from "./rulesIndex.js";
import { Severity, RULES, summarize } from "./result.js";

const TAG_KEY = /^[0-9A-F]{8}$/i;
const PRIVATE_KEY = /:/; // '<slot>:<creator>' grouping (D2b)

/** True for DicomDict / tag-keyed dict trees (vs naturalized datasets). */
function isDictLike(input) {
    if (input.dict && typeof input.dict === "object") {
        return true;
    }
    const keys = Object.keys(input);
    return (
        keys.length > 0 &&
        keys.every(key => TAG_KEY.test(key) || key.startsWith("_"))
    );
}

function isBinaryValue(value) {
    return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}

function isInlineBinary(value) {
    return (
        value &&
        typeof value === "object" &&
        value.InlineBinary !== undefined &&
        !isBinaryValue(value)
    );
}

/** Emit one naturalized attribute as synthetic events. */
function emitNaturalized(listener, key, value) {
    if (key.startsWith("_") || PRIVATE_KEY.test(key)) {
        return;
    }
    const rule = ruleForKeyword(key);
    if (!rule) {
        return; // unknown/preserved keys are layer-3 (INFO) territory
    }
    const tag = rule.tag;
    const vrs = allowedVrs(rule);

    if (vrs.includes("SQ")) {
        const items = Array.isArray(value) ? value : value ? [value] : [];
        listener.startSequence(tag, { vr: "SQ" });
        for (const item of items) {
            listener.startItem({});
            for (const childKey of Object.keys(item || {})) {
                emitNaturalized(listener, childKey, item[childKey]);
            }
            listener.endItem();
        }
        listener.endSequence();
        return;
    }

    const values =
        value === null || value === undefined
            ? []
            : Array.isArray(value)
            ? value
            : [value];

    if (values.some(v => isBinaryValue(v) || isInlineBinary(v))) {
        listener.startElement(tag, { vr: vrs[0] });
        listener.startBinary({ encapsulated: false });
        for (const v of values) {
            const inline = isInlineBinary(v) ? v.InlineBinary : v;
            for (const fragment of Array.isArray(inline) ? inline : [inline]) {
                if (isBinaryValue(fragment)) {
                    listener.binaryFragment(fragment);
                }
            }
        }
        listener.endBinary();
        listener.endElement();
        return;
    }

    listener.startElement(tag, { vr: vrs[0] });
    let index = 0;
    for (const v of values) {
        if (v && typeof v === "object" && typeof v.BulkDataURI === "string") {
            listener.bulkDataReference({ uri: v.BulkDataURI });
        } else {
            listener.value(v, { index });
        }
        index++;
    }
    listener.endElement();
}

function walkNaturalized(dataset, listener) {
    listener.startDataSet({
        transferSyntaxUID:
            dataset._meta && dataset._meta.TransferSyntaxUID
                ? dataset._meta.TransferSyntaxUID.Value
                    ? dataset._meta.TransferSyntaxUID.Value[0]
                    : dataset._meta.TransferSyntaxUID
                : undefined
    });
    for (const key of Object.keys(dataset)) {
        emitNaturalized(listener, key, dataset[key]);
    }
    listener.endDataSet();
}

/**
 * Validate a dataset or DicomDict.
 * @param {Object} datasetOrDict DicomDict ({meta?, dict}), tag-keyed dict,
 *        or naturalized dataset
 * @param {Object} [options]
 * @param {number[]} [options.layers=[1,2]]
 * @param {string[]} [options.ignore] rule ids to suppress
 * @param {number} [options.maxIssues]
 * @returns {Promise<{ok: boolean, issues: Array, summary: Object}>}
 */
export async function validate(datasetOrDict, options = {}) {
    if (!datasetOrDict || typeof datasetOrDict !== "object") {
        return summarize([], { layersRun: [] });
    }
    const listener = new ValidationListener(options);
    if (isDictLike(datasetOrDict)) {
        await fromDataSet(datasetOrDict, listener);
    } else {
        walkNaturalized(datasetOrDict, listener);
    }
    return listener.finish();
}

export { ValidationListener } from "./ValidationListener.js";
export { ValidationCollector } from "./collector.js";
export { Severity, RULES, makeIssue, summarize } from "./result.js";

export default {
    validate,
    ValidationListener,
    Severity,
    RULES
};
