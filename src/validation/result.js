/**
 * Validation result primitives (v2.0 Workstream B, layers 1+2).
 *
 * Issues carry stable, namespaced rule ids so callers can filter with
 * `options.ignore` and pin expectations against ids (not messages):
 *
 *   vr.legality       element VR is not a legal VR code / disagrees with the
 *                     dictionary VR for the tag
 *   vr.pattern        string value violates the Part 5 value format regex
 *   vr.maxLength      string value exceeds the Part 5 VR length cap
 *   vm.count          value count violates the dictionary VM pattern
 *   uid.format        UI value is not a dot-joined numeric UID or exceeds 64
 *   charset.terms     SpecificCharacterSet term unsupported / nonstandard
 *   charset.valueOrder  multi-valued (0008,0005) ordering rules (PS3.3
 *                     C.12.1.1.2): value 1 empty or single-byte; IR 87/159/
 *                     149/58 illegal as value 1
 *   charset.observed  non-ASCII characters observed while the declared (or
 *                     implied) charset is ASCII (INFO)
 *   pixel.dataLength  PixelData byte length vs Rows x Columns x Samples x
 *                     bytes x frames (native), fragment coherence
 *                     (encapsulated)
 *   pixel.bitsStored  BitsStored > BitsAllocated
 *   pixel.highBit     HighBit !== BitsStored - 1
 *   palette.descriptor  palette LUT descriptor triplet vs LUT data length
 *   ts.encapsulation  transfer-syntax vs pixel-data encapsulation coherence
 *   fmi.groupLength   declared (0002,0000) vs recomputed meta group length
 *   iod.type1.missing   Type 1 attribute of an enforced module is missing
 *                     (ERROR top-level; WARNING on nested paths — flattened
 *                     any-item granularity, see layer3.js)
 *   iod.type1.empty   Type 1 attribute of an enforced module is present but
 *                     empty (severity as iod.type1.missing)
 *   iod.type2.missing   Type 2 attribute of an enforced module is missing
 *                     (severity as iod.type1.missing)
 *   iod.conditional   Type 1C/2C attribute absent — INFO with the condition
 *                     text (conditions are reporting-only; never an error)
 *   iod.conditionalModule  usage "C" module not in use — INFO with the
 *                     module condition text
 *   iod.unknownAttribute  attribute belongs to no module of the resolved
 *                     CIOD (INFO, rate-limited)
 *   iod.unknownSopClass  SOP Class UID absent or not in the IOD catalog
 *                     (single WARNING; layer 3 stops)
 */

export const Severity = {
    ERROR: "error",
    WARNING: "warning",
    INFO: "info"
};

/** Every rule id layers 1-3 can emit (kept sorted for docs/tests). */
export const RULES = [
    "charset.observed",
    "charset.terms",
    "charset.valueOrder",
    "fmi.groupLength",
    "iod.conditional",
    "iod.conditionalModule",
    "iod.type1.empty",
    "iod.type1.missing",
    "iod.type2.missing",
    "iod.unknownAttribute",
    "iod.unknownSopClass",
    "palette.descriptor",
    "pixel.bitsStored",
    "pixel.dataLength",
    "pixel.highBit",
    "ts.encapsulation",
    "uid.format",
    "vm.count",
    "vr.legality",
    "vr.maxLength",
    "vr.pattern"
];

/**
 * Build one issue object. Optional location fields are only attached when
 * provided so issues stay compact and multiset-comparable.
 * @param {{severity: string, tag?: string, keyword?: string, path?: string,
 *          module?: string, rule: string, message: string}} fields
 */
export function makeIssue({
    severity,
    tag,
    keyword,
    path,
    module,
    rule,
    message
}) {
    const issue = { severity, rule, message };
    if (tag !== undefined) {
        issue.tag = tag;
    }
    if (keyword !== undefined) {
        issue.keyword = keyword;
    }
    if (path !== undefined) {
        issue.path = path;
    }
    if (module !== undefined) {
        issue.module = module;
    }
    return issue;
}

/**
 * Assemble the public result shape from accumulated issues.
 * @param {Array} issues
 * @param {{sopClassUid?: string, iod?: string, layersRun?: number[]}} [context]
 * @returns {{ok: boolean, issues: Array, summary: Object}}
 */
export function summarize(issues, context = {}) {
    let errors = 0;
    let warnings = 0;
    let infos = 0;
    for (const issue of issues) {
        if (issue.severity === Severity.ERROR) {
            errors++;
        } else if (issue.severity === Severity.WARNING) {
            warnings++;
        } else {
            infos++;
        }
    }
    const summary = {
        errors,
        warnings,
        infos,
        layersRun: context.layersRun || []
    };
    if (context.sopClassUid) {
        summary.sopClassUid = context.sopClassUid;
    }
    if (context.iod) {
        summary.iod = context.iod;
    }
    return { ok: errors === 0, issues, summary };
}

/**
 * Issue sink implementing `options.ignore` (rule-id array) and
 * `options.maxIssues` (hard cap; further reports are dropped and
 * `truncated` is set).
 */
export class IssueReporter {
    constructor(options = {}) {
        this.issues = [];
        this._ignore = new Set(options.ignore || []);
        this._maxIssues =
            typeof options.maxIssues === "number"
                ? options.maxIssues
                : Infinity;
        this.truncated = false;
    }

    /** @param {Object} fields makeIssue fields */
    report(fields) {
        if (this._ignore.has(fields.rule)) {
            return;
        }
        if (this.issues.length >= this._maxIssues) {
            this.truncated = true;
            return;
        }
        this.issues.push(makeIssue(fields));
    }
}
