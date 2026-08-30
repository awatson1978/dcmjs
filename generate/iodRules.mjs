// IOD catalog rules — pure helpers shared by the refresh script, the
// catalog builder, and the CI gates. No I/O, no import.meta (jest-importable).
// Mirrors the schemaRules.mjs role in the naturalized-schema pipeline.
// Source data: innolitics/dicom-standard stripped snapshots under
// generate/data/dicom-standard/ (see VERSION.md there).

// Closed sets (V2_ROADMAP Workstream A): anything outside these throws loudly.
export const ATTRIBUTE_TYPES = new Set(["1", "1C", "2", "2C", "3"]);
export const MODULE_USAGES = new Set(["M", "C", "U"]);

// Upstream emits type "None" for attribute tables that carry no Type column
// (Print Management / normalized-service modules, DIMSE-governed). No Part 3
// presence requirement exists for these rows, so they normalize to Type 3
// (never an error). Exact count over the packed catalog, asserted by the gate.
export const NONE_TYPE_NORMALIZED_ROW_COUNT = 888;

// 1C/2C rows whose description carries no extractable condition sentence
// (the condition lives on an enclosing sequence/macro/module instead —
// e.g. Image Position inside the Pixel Measures functional group).
// Scope statement: conditions are reporting-only text; 1C/2C never error,
// so a missing condition degrades reporting, not correctness. Exact count
// over the packed catalog (functional-group expansion included), asserted
// by the gate — 99.4% of 1C/2C rows carry condition text.
export const CONDITIONLESS_1C2C_ROW_COUNT = 289;

// Functional-group container paths (Enhanced multi-frame IODs).
export const FG_SHARED = "52009229"; // SharedFunctionalGroupsSequence
export const FG_PER_FRAME = "52009230"; // PerFrameFunctionalGroupsSequence

export function normalizeType(type, counters) {
    if (type === "None") {
        if (counters) {
            counters.none += 1;
        }
        return "3";
    }
    if (!ATTRIBUTE_TYPES.has(type)) {
        throw new Error(`attribute type outside closed set: "${type}"`);
    }
    return type;
}

export function assertUsage(usage, context) {
    if (!MODULE_USAGES.has(usage)) {
        throw new Error(`${context}: usage outside closed set: "${usage}"`);
    }
    return usage;
}

// "module:00400275:00081080" (Innolitics colon path, first segment is the
// module/macro id) -> "00400275.00081080" bare-hex dot path, matching the
// bareTag conventions in buildCatalog.mjs. Overlay repeating groups keep
// their placeholder digits ("60xx0010" -> "60XX0010").
export function normalizePath(colonPath, ownerId) {
    const segments = colonPath.split(":");
    if (segments[0] !== ownerId) {
        throw new Error(
            `path "${colonPath}" does not start with owner id "${ownerId}"`
        );
    }
    const tags = segments.slice(1).map(seg => {
        const tag = seg.toUpperCase();
        if (!/^[0-9A-FX]{8}$/.test(tag)) {
            throw new Error(`unexpected path segment "${seg}" in ${colonPath}`);
        }
        return tag;
    });
    if (tags.length === 0) {
        throw new Error(`path "${colonPath}" has no tag segments`);
    }
    return tags.join(".");
}

const ENTITIES = [
    [/&amp;/g, "&"],
    [/&lt;/g, "<"],
    [/&gt;/g, ">"],
    [/&quot;/g, '"'],
    [/&#39;/g, "'"]
];

export function stripHtml(html) {
    if (!html) {
        return "";
    }
    let text = html.replace(/<[^>]*>/g, " ");
    for (const [re, ch] of ENTITIES) {
        text = text.replace(re, ch);
    }
    return text.replace(/\s+/g, " ").trim();
}

// First condition sentence from a Part 3 description: the sentence starting
// "Required if" (the dominant phrasing) or "Shall be present if" (the code
// sequence macro phrasing — including it lifts extraction from ~68% to ~98%
// of 1C/2C rows). HTML tags stripped; "" when no condition sentence exists.
const CONDITION_LEADS = ["Required if ", "Shall be present if "];

export function extractConditionText(html) {
    const text = stripHtml(html);
    let start = -1;
    for (const lead of CONDITION_LEADS) {
        const at = text.indexOf(lead);
        if (at >= 0 && (start < 0 || at < start)) {
            start = at;
        }
    }
    if (start < 0) {
        return "";
    }
    const rest = text.slice(start);
    const end = rest.indexOf(". ");
    return end < 0 ? rest : rest.slice(0, end + 1);
}
