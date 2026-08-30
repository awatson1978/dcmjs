/**
 * Layer 3 — IOD/module validation (v2.0 Workstream B, PR 4).
 *
 * Consumes the ValidationCollector snapshot (presence/non-emptiness per
 * dot path + the SOP Class UID) and the Part 3 catalog (src/schema/
 * iodIndex.js + iodModules.packed.js) to check module attribute types:
 *
 *   - SOP Class UID -> CIOD via the catalog; unknown/absent SOP Class is a
 *     single WARNING (iod.unknownSopClass) and layer 3 stops there.
 *   - usage "M" modules are always enforced; usage "C" modules are enforced
 *     only when "in use" (any of the module's attribute paths present —
 *     matching dciodvfy: a conditional module in use must be complete),
 *     otherwise a single INFO (iod.conditionalModule) with the module
 *     condition text; usage "U" modules are never enforced (but their
 *     attributes are "known" for the unknown-attribute sweep).
 *   - Type 1 -> present + non-empty (iod.type1.missing / iod.type1.empty,
 *     ERROR); Type 2 -> present (iod.type2.missing, ERROR; empty is fine);
 *     Type 1C/2C -> INFO (iod.conditional) with the condition text when
 *     absent — conditions are reporting-only text, never machine-evaluated,
 *     so 1C/2C never error (roadmap scope statement); Type 3 -> nothing.
 *   - Attributes present in the dataset but belonging to no module of the
 *     CIOD -> INFO (iod.unknownAttribute), rate-limited to
 *     UNKNOWN_ATTRIBUTE_LIMIT reports plus a remainder count.
 *
 * Granularity limitation (documented, per-item enforcement is future work):
 * the collector records flattened dot paths only — a sequence is "non-empty"
 * when it has at least one item, and a child path is "present" when the
 * attribute appears in ANY item of the sequence. Nested rows are therefore
 * enforced at that flattened granularity, and only when their parent
 * sequence path is present with at least one item (an absent or empty
 * parent already reports at its own level). Because many nested tables are
 * item-type dependent (e.g. SR content items encode Type 1 rows that only
 * apply to one Value Type), nested Type 1/2 findings are reported as
 * WARNING, not ERROR — fixture calibration showed every nested ERROR on the
 * corpus was such a false positive. Top-level Type 1/2 stay ERROR.
 *
 * Functional-group synthetic modules ("fg:<macro-id>") carry every row under
 * both the Shared (5200,9229) and Per-Frame (5200,9230) container prefixes,
 * because shared-vs-per-frame is an instance-level choice. Macro root rows
 * are therefore evaluated ONCE with the two containers merged (present in
 * either satisfies the row); deeper macro rows are gated per container by
 * the parent-presence rule above. Rows under the container prefixes in
 * ordinary (non-"fg:") modules are skipped entirely: the per-CIOD
 * "*-multi-frame-functional-groups" tables re-encode the macros with
 * context-free types, while the fg:* entries carry the authoritative
 * per-macro usage (M/C + condition) — enforcing both double-reports and
 * turns conditional macros into false Type 1 errors (cine-test.dcm
 * calibration).
 *
 * Wildcard rows (repeating groups, e.g. "60XX0010") are matched for the
 * in-use / known-attribute sweeps but never enforced as Type 1/2 —
 * presence of a placeholder path cannot be pinned to one concrete tag.
 */

import { getIodForSopClass } from "../schema/iodIndex.js";
import { getModuleAttributes } from "../schema/iodModules.packed.js";
import { FG_SHARED, FG_PER_FRAME } from "../../generate/iodRules.mjs";
import { ruleForTag } from "./rulesIndex.js";
import { makeIssue, Severity } from "./result.js";

/** Max individual iod.unknownAttribute reports before the remainder count. */
export const UNKNOWN_ATTRIBUTE_LIMIT = 10;

/**
 * Modules whose attribute types depend on a per-item discriminator the
 * catalog does not carry (SR content items: Table C.17.3-7 keys most rows
 * off Value Type (0040,A040), including the TOP-LEVEL rows — the SR root is
 * itself a content item). Type 1/2 findings in these modules are WARNING
 * even at top level; sample-sr.dcm calibration showed every ERROR here was
 * a false positive on a conformant fixture. Corpus calibration (PR 7) may
 * extend this set.
 */
const VALUE_TYPE_DEPENDENT_MODULES = new Set(["sr-document-content"]);

/** Resolve the CIOD for a SOP Class UID (null when unknown/absent). */
export function resolveIod(sopClassUid) {
    return sopClassUid ? getIodForSopClass(sopClassUid) : null;
}

/** "00280010" -> "Rows (00280010)" when the dictionary knows the tag. */
function describeTag(tag) {
    if (tag.includes("X")) {
        return `(${tag})`;
    }
    const rule = ruleForTag(tag);
    return rule ? `${rule.keyword} (${tag})` : `(${tag})`;
}

/** Last path segment as the issue's tag (omitted for wildcard rows). */
function tagOf(path) {
    const tag = path.slice(path.lastIndexOf(".") + 1);
    return tag.includes("X") ? undefined : tag;
}

/** Location fields shared by every per-attribute issue. */
function locate(path, moduleId) {
    const tag = tagOf(path);
    const fields = { path, module: moduleId };
    if (tag !== undefined) {
        fields.tag = tag;
        const rule = ruleForTag(tag);
        if (rule) {
            fields.keyword = rule.keyword;
        }
    }
    return fields;
}

/** Compile a wildcard row path ("60XX0010") to a matcher over real paths. */
function wildcardMatcher(path) {
    return new RegExp(`^${path.replace(/X/g, "[0-9A-F]")}$`);
}

/** True when any collector path matches one of the module's rows. */
function moduleInUse(rows, paths) {
    for (const row of rows) {
        if (row.path.includes("X")) {
            const matcher = wildcardMatcher(row.path);
            for (const path of paths.keys()) {
                if (matcher.test(path)) {
                    return true;
                }
            }
        } else if (paths.has(row.path)) {
            return true;
        }
    }
    return false;
}

/** True when every dot-path segment is a non-private, non-group-length tag. */
function isCheckableDataPath(path) {
    for (const segment of path.split(".")) {
        if (segment.slice(4) === "0000") {
            return false; // group length
        }
        if (parseInt(segment.charAt(3), 16) % 2 === 1) {
            return false; // private
        }
    }
    return true;
}

const FG_SHARED_PREFIX = `${FG_SHARED}.`;
const FG_PER_FRAME_PREFIX = `${FG_PER_FRAME}.`;

function underFgContainer(path) {
    return (
        path.startsWith(FG_SHARED_PREFIX) ||
        path.startsWith(FG_PER_FRAME_PREFIX)
    );
}

/**
 * Enforce one Type 1/2/1C/2C row of an enforced module.
 * @returns {Object|null} issue fields or null
 */
function checkRow(row, moduleId, paths, isFg) {
    const { path, type } = row;
    if (type === "3" || path.includes("X")) {
        return null;
    }
    if (!isFg && underFgContainer(path)) {
        // Re-encoded macro row in a "*-multi-frame-functional-groups"
        // module — the fg:* synthetic module owns this namespace (see the
        // module docblock).
        return null;
    }
    const lastDot = path.lastIndexOf(".");
    const nested = lastDot !== -1;
    let entry = paths.get(path);

    if (isFg && nested && path.indexOf(".") === lastDot) {
        // Macro root row ("52009229.XXXXXXXX"): shared-vs-per-frame is an
        // instance choice, so evaluate ONCE (on the Shared copy) with the
        // two containers merged; skip the Per-Frame duplicate.
        if (path.startsWith(FG_PER_FRAME_PREFIX)) {
            return null;
        }
        const tail = path.slice(lastDot + 1);
        const shared = paths.get(FG_SHARED);
        const perFrame = paths.get(FG_PER_FRAME);
        if (!(shared && shared.nonEmpty) && !(perFrame && perFrame.nonEmpty)) {
            return null; // neither container has items
        }
        const a = paths.get(path);
        const b = paths.get(`${FG_PER_FRAME_PREFIX}${tail}`);
        entry =
            a || b
                ? {
                      present: true,
                      nonEmpty: !!((a && a.nonEmpty) || (b && b.nonEmpty))
                  }
                : undefined;
    } else if (nested) {
        // Nested row: only enforced when the parent sequence is present with
        // at least one item (see the granularity limitation above).
        const parent = paths.get(path.slice(0, lastDot));
        if (!parent || !parent.nonEmpty) {
            return null;
        }
    }

    if (type === "1C" || type === "2C") {
        if (entry) {
            return null;
        }
        const condition =
            row.condition ||
            "condition recorded on an enclosing sequence or macro";
        return {
            severity: Severity.INFO,
            rule: "iod.conditional",
            ...locate(path, moduleId),
            message:
                `Conditional (Type ${type}) attribute ` +
                `${describeTag(path.slice(lastDot + 1))} of module ` +
                `${moduleId} is absent — ${condition}`
        };
    }
    // Nested tables are often item-type dependent (see docblock): nested
    // Type 1/2 findings are WARNING, top-level stay ERROR — except in
    // modules whose types hang off a per-item discriminator we don't model.
    const severity =
        nested || VALUE_TYPE_DEPENDENT_MODULES.has(moduleId)
            ? Severity.WARNING
            : Severity.ERROR;
    if (type === "1") {
        if (!entry) {
            return {
                severity,
                rule: "iod.type1.missing",
                ...locate(path, moduleId),
                message:
                    `Type 1 attribute ${describeTag(path.slice(lastDot + 1))}` +
                    ` of module ${moduleId} is missing`
            };
        }
        if (!entry.nonEmpty) {
            return {
                severity,
                rule: "iod.type1.empty",
                ...locate(path, moduleId),
                message:
                    `Type 1 attribute ${describeTag(path.slice(lastDot + 1))}` +
                    ` of module ${moduleId} is present but empty`
            };
        }
        return null;
    }
    // Type 2: present is enough, empty is fine.
    if (!entry) {
        return {
            severity,
            rule: "iod.type2.missing",
            ...locate(path, moduleId),
            message:
                `Type 2 attribute ${describeTag(path.slice(lastDot + 1))}` +
                ` of module ${moduleId} is missing`
        };
    }
    return null;
}

/**
 * Run layer 3 against the collector snapshot.
 * @param {import("./collector.js").ValidationCollector} collector
 * @param {Object} [options] validate() options; options.sopClassUid
 *        overrides the collected (0008,0016) value (asIod uses this)
 * @returns {Array} issues
 */
export function runLayer3(collector, options = {}) {
    const sopClassUid = options.sopClassUid || collector.sopClassUid;
    if (!sopClassUid) {
        return [
            makeIssue({
                severity: Severity.WARNING,
                rule: "iod.unknownSopClass",
                message: "No SOP Class UID (0008,0016) — IOD validation skipped"
            })
        ];
    }
    const iod = getIodForSopClass(sopClassUid);
    if (!iod) {
        return [
            makeIssue({
                severity: Severity.WARNING,
                rule: "iod.unknownSopClass",
                message:
                    `SOP Class UID ${sopClassUid} is not in the IOD ` +
                    "catalog — IOD validation skipped"
            })
        ];
    }

    const issues = [];
    const { paths } = collector;
    const knownExact = new Set();
    const knownWildcards = [];

    for (const moduleRef of iod.modules) {
        const rows = getModuleAttributes(moduleRef.id);
        for (const row of rows) {
            if (row.path.includes("X")) {
                knownWildcards.push(wildcardMatcher(row.path));
            } else {
                knownExact.add(row.path);
            }
        }

        let enforced = moduleRef.usage === "M";
        if (moduleRef.usage === "C") {
            if (moduleInUse(rows, paths)) {
                enforced = true;
            } else {
                issues.push(
                    makeIssue({
                        severity: Severity.INFO,
                        rule: "iod.conditionalModule",
                        module: moduleRef.id,
                        message:
                            `Conditional module ${moduleRef.id} is not in ` +
                            `use — ${
                                moduleRef.condition ||
                                "no condition text recorded"
                            }`
                    })
                );
            }
        }
        if (!enforced) {
            continue;
        }
        const isFg = moduleRef.id.startsWith("fg:");
        for (const row of rows) {
            const fields = checkRow(row, moduleRef.id, paths, isFg);
            if (fields) {
                issues.push(makeIssue(fields));
            }
        }
    }

    // Unknown-attribute sweep: dataset paths that belong to no module of
    // this CIOD (any usage). Only the shallowest unknown path per subtree is
    // reported/counted — children of an unknown sequence add no signal.
    let unknownCount = 0;
    const unknownPaths = new Set();
    for (const path of [...paths.keys()].sort()) {
        if (!isCheckableDataPath(path)) {
            continue;
        }
        const lastDot = path.lastIndexOf(".");
        if (lastDot !== -1 && unknownPaths.has(path.slice(0, lastDot))) {
            continue;
        }
        if (knownExact.has(path)) {
            continue;
        }
        if (knownWildcards.some(matcher => matcher.test(path))) {
            continue;
        }
        unknownPaths.add(path);
        unknownCount++;
        if (unknownCount <= UNKNOWN_ATTRIBUTE_LIMIT) {
            issues.push(
                makeIssue({
                    severity: Severity.INFO,
                    rule: "iod.unknownAttribute",
                    ...locate(path, undefined),
                    message:
                        `Attribute ${describeTag(path.slice(lastDot + 1))} ` +
                        `at ${path} is not part of any module of CIOD ` +
                        iod.ciodId
                })
            );
        }
    }
    if (unknownCount > UNKNOWN_ATTRIBUTE_LIMIT) {
        issues.push(
            makeIssue({
                severity: Severity.INFO,
                rule: "iod.unknownAttribute",
                message:
                    `${unknownCount - UNKNOWN_ATTRIBUTE_LIMIT} additional ` +
                    `attributes are not part of any module of CIOD ` +
                    `${iod.ciodId} (${unknownCount} total)`
            })
        );
    }
    return issues;
}
