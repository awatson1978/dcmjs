/**
 * Layer 1 — structural per-element checks (no IOD keystone needed).
 *
 * VR legality vs the dictionary, VM count vs the dictionary VM pattern,
 * Part 5 value format regexes / length caps (vrFormats from the generated
 * catalog), UID format, and SpecificCharacterSet term legality + value-order
 * rules (PS3.3 C.12.1.1.2 / PS3.5 6.1.2.5.3).
 *
 * All functions are pure: they inspect one element's worth of data and push
 * issues through the provided IssueReporter. The streaming ValidationListener
 * calls the per-value checks as values arrive, so nothing is buffered.
 */

import { VALID_VRS, encodingMapping } from "../constants/dicom.js";
import { Severity } from "./result.js";
import {
    ruleForTag,
    vmConstraint,
    allowedVrs,
    vrFormats
} from "./rulesIndex.js";

/** UID: dot-joined nonempty numeric components (stricter than "^[0-9.]+$"
 *  so "1..2" / ".1" / trailing dots are caught), max 64 chars (PS3.5 9.1). */
const UID_PATTERN = /^[0-9]+(\.[0-9]+)*$/;
const UID_MAX_LENGTH = 64;

// eslint-disable-next-line no-control-regex -- NUL padding is the point
const TRAILING_PADDING = /[\x00 ]+$/;
// eslint-disable-next-line no-control-regex -- full 7-bit ASCII range
const NON_ASCII = /[^\x00-\x7f]/;

/** Compiled vrFormats regexes, built on demand. */
const patternCache = new Map();
function formatRegex(vr, pattern) {
    let re = patternCache.get(vr);
    if (!re) {
        re = new RegExp(pattern);
        patternCache.set(vr, re);
    }
    return re;
}

/** Normalizes one (0008,0005) value to the encodingMapping key form —
 *  same transform as src/charset/iso2022.js normalizeCode (private there). */
export function normalizeCharsetCode(value) {
    return String(value ?? "")
        .trim()
        .replace(/[_ ]/g, "-")
        .toLowerCase();
}

/** PS3.3 defined terms for (0008,0005), normalized. */
const DEFINED_CHARSET_TERMS = new Set([
    // Single-byte without code extensions (Table C.12-2)
    "iso-ir-100",
    "iso-ir-101",
    "iso-ir-109",
    "iso-ir-110",
    "iso-ir-144",
    "iso-ir-127",
    "iso-ir-126",
    "iso-ir-138",
    "iso-ir-148",
    "iso-ir-203",
    "iso-ir-13",
    "iso-ir-166",
    // Multi-byte without code extensions (Table C.12-3)
    "iso-ir-192",
    "gb18030",
    "gbk",
    // With code extensions (Tables C.12-4/5)
    "iso-2022-ir-6",
    "iso-2022-ir-100",
    "iso-2022-ir-101",
    "iso-2022-ir-109",
    "iso-2022-ir-110",
    "iso-2022-ir-144",
    "iso-2022-ir-127",
    "iso-2022-ir-126",
    "iso-2022-ir-138",
    "iso-2022-ir-148",
    "iso-2022-ir-203",
    "iso-2022-ir-13",
    "iso-2022-ir-166",
    "iso-2022-ir-87",
    "iso-2022-ir-159",
    "iso-2022-ir-149",
    "iso-2022-ir-58"
]);

/** Multi-byte ISO 2022 sets that may never be value 1 (PS3.3 C.12.1.1.2). */
const ILLEGAL_AS_VALUE1 = new Set([
    "iso-2022-ir-87",
    "iso-2022-ir-159",
    "iso-2022-ir-149",
    "iso-2022-ir-58"
]);

/** Single-byte ISO 2022 code-extension terms legal as value 1. */
const SINGLE_BYTE_ISO2022 = new Set([
    "iso-2022-ir-6",
    "iso-2022-ir-13",
    "iso-2022-ir-100",
    "iso-2022-ir-101",
    "iso-2022-ir-109",
    "iso-2022-ir-110",
    "iso-2022-ir-126",
    "iso-2022-ir-127",
    "iso-2022-ir-138",
    "iso-2022-ir-144",
    "iso-2022-ir-148",
    "iso-2022-ir-166",
    "iso-2022-ir-203"
]);

/** True when a string contains characters outside 7-bit ASCII. */
export function hasNonAscii(str) {
    return NON_ASCII.test(str);
}

/**
 * vr.legality — the stated VR must be a legal VR code (ERROR) and, for
 * dictionary tags, agree with the dictionary VR (WARNING; UN is always
 * acceptable — it means "sender did not know").
 */
export function checkVrLegality(tag, vr, path, reporter) {
    if (!vr) {
        return;
    }
    if (!VALID_VRS.has(vr)) {
        reporter.report({
            severity: Severity.ERROR,
            tag,
            path,
            rule: "vr.legality",
            message: `"${vr}" is not a legal VR code`
        });
        return;
    }
    if (vr === "UN") {
        return;
    }
    const rule = ruleForTag(tag);
    if (!rule) {
        return;
    }
    const allowed = allowedVrs(rule);
    if (!allowed.includes(vr)) {
        reporter.report({
            severity: Severity.WARNING,
            tag,
            keyword: rule.keyword,
            path,
            rule: "vr.legality",
            message: `VR ${vr} disagrees with dictionary VR ${allowed.join(
                "/"
            )}`
        });
    }
}

/**
 * Per-value format checks: uid.format for UI, vr.pattern / vr.maxLength for
 * VRs constrained by the catalog's vrFormats. Non-string values are checked
 * through their retained raw string when one exists (precision retention);
 * otherwise skipped. Empty values are always legal here (Type 2 territory).
 */
export function checkValueFormat(tag, vr, value, rawValue, path, reporter) {
    let str = null;
    if (typeof value === "string" || value instanceof String) {
        str = String(value);
    } else if (
        (typeof value === "number" || typeof value === "bigint") &&
        typeof rawValue === "string"
    ) {
        str = rawValue;
    }
    if (str === null) {
        return;
    }
    const trimmed = str.replace(TRAILING_PADDING, "");
    if (trimmed === "") {
        return;
    }

    if (vr === "UI") {
        if (trimmed.length > UID_MAX_LENGTH || !UID_PATTERN.test(trimmed)) {
            reporter.report({
                severity: Severity.ERROR,
                tag,
                path,
                rule: "uid.format",
                message: `"${trimmed}" is not a valid UID (numeric dot-components, max ${UID_MAX_LENGTH} chars)`
            });
        }
        return;
    }

    const format = vrFormats[vr];
    if (!format) {
        return;
    }
    if (format.maxLength && trimmed.length > format.maxLength) {
        reporter.report({
            severity: Severity.ERROR,
            tag,
            path,
            rule: "vr.maxLength",
            message: `${vr} value of ${trimmed.length} chars exceeds the ${format.maxLength}-char limit`
        });
    }
    if (format.pattern && !formatRegex(vr, format.pattern).test(trimmed)) {
        reporter.report({
            severity: Severity.ERROR,
            tag,
            path,
            rule: "vr.pattern",
            message: `${vr} value "${trimmed}" violates the Part 5 value format`
        });
    }
}

/**
 * vm.count — value count vs the dictionary VM pattern. Empty elements are
 * legal (Type 2); sequences and binary elements are out of scope (a
 * sequence's VM constrains attribute repetition, not item count).
 */
export function checkVmCount(tag, count, path, reporter) {
    if (!count) {
        return;
    }
    const rule = ruleForTag(tag);
    if (!rule || allowedVrs(rule).includes("SQ")) {
        return;
    }
    const vm = vmConstraint(rule);
    if (!vm) {
        return;
    }
    const belowMin = count < vm.min;
    const aboveMax = vm.max !== null && count > vm.max;
    const badMultiple = vm.multiple !== null && count % vm.multiple !== 0;
    if (belowMin || aboveMax || badMultiple) {
        reporter.report({
            severity: Severity.ERROR,
            tag,
            keyword: rule.keyword,
            path,
            rule: "vm.count",
            message: `value count ${count} violates VM ${rule.vm}`
        });
    }
}

/**
 * SpecificCharacterSet (0008,0005) checks:
 *  - charset.terms: each term must be decodable (ERROR when unknown) and a
 *    PS3.3 defined term (WARNING for lenient aliases like bare "GB2312" or
 *    "ISO_IR 6").
 *  - charset.valueOrder: value 1 must be empty or designate a single-byte
 *    set; ISO 2022 IR 87/159/149/58 are illegal as value 1; values 2..n of
 *    a multi-valued list must all be ISO 2022 terms.
 */
export function checkCharset(values, tag, path, reporter) {
    const codes = values.map(normalizeCharsetCode);

    for (let i = 0; i < codes.length; i++) {
        const code = codes[i];
        if (code === "") {
            continue;
        }
        if (!(code in encodingMapping)) {
            reporter.report({
                severity: Severity.ERROR,
                tag,
                path,
                rule: "charset.terms",
                message: `unsupported SpecificCharacterSet term "${values[i]}"`
            });
        } else if (!DEFINED_CHARSET_TERMS.has(code)) {
            reporter.report({
                severity: Severity.WARNING,
                tag,
                path,
                rule: "charset.terms",
                message: `"${values[i]}" is not a PS3.3 defined term for (0008,0005)`
            });
        }
    }

    if (!codes.length) {
        return;
    }
    const first = codes[0];
    if (ILLEGAL_AS_VALUE1.has(first)) {
        reporter.report({
            severity: Severity.ERROR,
            tag,
            path,
            rule: "charset.valueOrder",
            message: `"${values[0]}" is a multi-byte set and may not be value 1 of (0008,0005)`
        });
    } else if (
        codes.length > 1 &&
        first !== "" &&
        !SINGLE_BYTE_ISO2022.has(first)
    ) {
        reporter.report({
            severity: Severity.ERROR,
            tag,
            path,
            rule: "charset.valueOrder",
            message: `value 1 of a multi-valued (0008,0005) must be empty or a single-byte ISO 2022 term (got "${values[0]}")`
        });
    }
    for (let i = 1; i < codes.length; i++) {
        if (!codes[i].startsWith("iso-2022-")) {
            reporter.report({
                severity: Severity.ERROR,
                tag,
                path,
                rule: "charset.valueOrder",
                message: `value ${
                    i + 1
                } of a multi-valued (0008,0005) must be an ISO 2022 code-extension term (got "${
                    values[i]
                }")`
            });
        }
    }
}

/** Terms that declare (or imply, when absent) the default ASCII repertoire. */
export function impliesAscii(charsetValues) {
    if (!charsetValues || !charsetValues.length) {
        return true;
    }
    return charsetValues.every(v => {
        const code = normalizeCharsetCode(v);
        return code === "" || code === "iso-ir-6" || code === "iso-2022-ir-6";
    });
}
