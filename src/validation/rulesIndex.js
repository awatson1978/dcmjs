/**
 * Lazy keyword/tag lookup over the generated naturalized rule catalog
 * (src/schema/naturalizedRules.js), mirroring the byKeyword technique the
 * D22 code-agreement gate uses (test/schema/codeAgreement.test.js) without
 * importing from tests. VM patterns are parsed on demand with the same
 * `parseVm` primitive the schema generator uses and memoized per entry.
 */

import { naturalizedRules } from "../schema/naturalizedRules.js";
import { parseVm } from "../../generate/schemaRules.mjs";

let byTag = null;
let byKeyword = null;

function build() {
    byTag = new Map();
    byKeyword = new Map();
    for (const [tag, entry] of Object.entries(naturalizedRules.attributes)) {
        const record = {
            tag,
            keyword: entry.keyword,
            vr: entry.vr,
            vm: entry.vm,
            _vmParsed: undefined
        };
        byTag.set(tag, record);
        byKeyword.set(entry.keyword, record);
    }
}

/**
 * @param {string} tag clean uppercase tag hex ("00280010")
 * @returns {{tag, keyword, vr, vm}|null}
 */
export function ruleForTag(tag) {
    if (!byTag) {
        build();
    }
    return byTag.get(tag) || null;
}

/**
 * @param {string} keyword dictionary keyword ("Rows")
 * @returns {{tag, keyword, vr, vm}|null}
 */
export function ruleForKeyword(keyword) {
    if (!byKeyword) {
        build();
    }
    return byKeyword.get(keyword) || null;
}

/**
 * Parsed VM constraint for a rule record ({min, max, multiple, multi}),
 * memoized on the record. Returns null for unclassifiable patterns.
 */
export function vmConstraint(record) {
    if (record._vmParsed === undefined) {
        try {
            record._vmParsed = parseVm(record.vm);
        } catch {
            record._vmParsed = null;
        }
    }
    return record._vmParsed;
}

/** VR codes a rule record allows, always as an array. */
export function allowedVrs(record) {
    return Array.isArray(record.vr) ? record.vr : [record.vr];
}

/** Part 5 per-VR value-format constraints from the generated catalog. */
export const vrFormats = naturalizedRules.vrFormats;
