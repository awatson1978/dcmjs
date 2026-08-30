/**
 * asIod — runtime narrowing to a typed IOD dataset (v2.0 Workstream D).
 *
 * Runs validate() layers 1 (structural) + 3 (IOD/module) for the given SOP
 * Class and either throws IodValidationError (ERROR-severity issues) or
 * returns the dataset unchanged. The generated types/dcmjs-iods.d.ts types
 * this as `asIod<T extends SopClassUid>(...): Promise<DicomDataset<T>>`, so
 * the successful return is the compile-time counterpart of the runtime
 * check.
 *
 *   const ct = await asIod(dataset, "1.2.840.10008.5.1.4.1.1.2");
 *   ct.Rows; // required per the CT Image IOD
 *
 * `options.lenient` skips the throw and returns the dataset regardless —
 * callers who want the issue list run validate() themselves (asIod stays a
 * simple guard and does not attach issues to the dataset).
 */

import { validate } from "./index.js";
import { Severity } from "./result.js";

export class IodValidationError extends Error {
    /**
     * @param {string} message
     * @param {Array} issues full validate() issue list (all severities)
     */
    constructor(message, issues) {
        super(message);
        this.name = "IodValidationError";
        this.issues = issues;
    }
}

/**
 * Validate a dataset against its IOD and return it (typed via
 * types/dcmjs-iods.d.ts) or throw.
 * @param {Object} dataset naturalized dataset (or DicomDict / tag-keyed
 *        dict — anything validate() accepts)
 * @param {string} [sopClassUid=dataset.SOPClassUID] SOP Class UID selecting
 *        the CIOD to validate against
 * @param {Object} [options]
 * @param {boolean} [options.lenient] return the dataset even with errors
 * @param {string[]} [options.ignore] rule ids to suppress (validate())
 * @param {number} [options.maxIssues] hard cap (validate())
 * @returns {Promise<Object>} the dataset, unchanged
 * @throws {IodValidationError} when any ERROR-severity issue is found and
 *         options.lenient is not set
 */
export async function asIod(dataset, sopClassUid, options = {}) {
    const uid = sopClassUid || (dataset && dataset.SOPClassUID) || undefined;
    const result = await validate(dataset, {
        ...options,
        layers: [1, 3],
        sopClassUid: uid
    });
    if (!result.ok && !options.lenient) {
        const errors = result.issues.filter(
            issue => issue.severity === Severity.ERROR
        );
        throw new IodValidationError(
            `Dataset is not a valid ${result.summary.iod || uid || "IOD"} ` +
                `instance: ${errors.length} error(s), first: ` +
                errors[0].message,
            result.issues
        );
    }
    return dataset;
}
