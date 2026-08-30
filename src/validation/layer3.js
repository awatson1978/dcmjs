/**
 * Layer 3 — IOD/module validation. STUB in this PR.
 *
 * The Part 3 catalog (src/schema/iodIndex.js + iodModules.packed.js, PR 2)
 * is wired here as the seam: PR 4 replaces the body of `runLayer3` with the
 * real CIOD walk (Type 1/2/1C/2C checks over `collector.paths`) while
 * keeping this exact signature. Callers already receive the collector with
 * presence paths, the SOP Class UID, and the resolved CIOD.
 */

import { getIodForSopClass } from "../schema/iodIndex.js";
import { makeIssue, Severity } from "./result.js";

/** Resolve the CIOD for a SOP Class UID (null when unknown/absent). */
export function resolveIod(sopClassUid) {
    return sopClassUid ? getIodForSopClass(sopClassUid) : null;
}

/**
 * Run layer 3 against the collector snapshot.
 * @param {import("./collector.js").ValidationCollector} collector
 * @param {Object} options validate() options (reserved for PR 4)
 * @returns {Array} issues
 */
// eslint-disable-next-line no-unused-vars
export function runLayer3(collector, options = {}) {
    return [
        makeIssue({
            severity: Severity.INFO,
            rule: "iod.unavailable",
            message: "IOD validation lands in a later PR"
        })
    ];
}
