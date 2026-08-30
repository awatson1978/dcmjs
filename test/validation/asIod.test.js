/**
 * asIod() runtime narrowing (v2.0 Workstream D): validate layers 1+3 and
 * throw IodValidationError or return the dataset. The conformant fixture is
 * built FROM the catalog (top-level Type 1/2 rows of usage-M modules), so
 * it tracks standard refreshes automatically. JANE DOE identities only.
 */

import {
    asIod,
    IodValidationError,
    validate
} from "../../src/validation/index.js";
import { getIodForSopClass } from "../../src/schema/iodIndex.js";
import { getModuleAttributes } from "../../src/schema/iodModules.packed.js";
import { ruleForTag, allowedVrs } from "../../src/validation/rulesIndex.js";

const CR_SOP_CLASS = "1.2.840.10008.5.1.4.1.1.1";

/** Minimal valid value for a Type 1 attribute, by VR. */
function valueFor(rule) {
    const vr = allowedVrs(rule)[0];
    switch (vr) {
        case "UI":
            return "1.2.826.0.1.3680043.8.498.1";
        case "CS":
            return "JANEDOE";
        case "US":
        case "UL":
        case "SS":
        case "SL":
        case "IS":
        case "DS":
        case "FL":
        case "FD":
            return 1;
        case "DA":
            return "19700101";
        case "TM":
            return "000000";
        case "SQ":
            return [{}];
        default:
            return "X";
    }
}

/**
 * Naturalized dataset satisfying every top-level Type 1/2 row of the CIOD's
 * mandatory modules (Type 2 keys present-but-empty via null).
 */
function conformantDataset(sopClassUid = CR_SOP_CLASS) {
    const dataset = { SOPClassUID: sopClassUid };
    const iod = getIodForSopClass(sopClassUid);
    for (const moduleRef of iod.modules) {
        if (moduleRef.usage !== "M") {
            continue;
        }
        for (const row of getModuleAttributes(moduleRef.id)) {
            if (
                (row.type !== "1" && row.type !== "2") ||
                row.path.includes(".") ||
                row.path.includes("X")
            ) {
                continue;
            }
            const rule = ruleForTag(row.path);
            if (!rule || dataset[rule.keyword] !== undefined) {
                continue;
            }
            dataset[rule.keyword] = row.type === "1" ? valueFor(rule) : null;
        }
    }
    return dataset;
}

describe("asIod", () => {
    test("happy path: a conformant dataset is returned unchanged", async () => {
        const dataset = conformantDataset();
        // Sanity: the fixture builder really produced the CR requireds.
        expect(dataset.Rows).toBe(1);
        expect(dataset.PatientName).toBeNull();
        await expect(asIod(dataset)).resolves.toBe(dataset);
    });

    test("SOP Class UID defaults from dataset.SOPClassUID (override works too)", async () => {
        const dataset = conformantDataset();
        await expect(asIod(dataset, CR_SOP_CLASS)).resolves.toBe(dataset);
    });

    test("missing Type 1 throws IodValidationError with the right rule", async () => {
        const dataset = conformantDataset();
        delete dataset.Rows;
        expect.assertions(4);
        try {
            await asIod(dataset);
        } catch (error) {
            expect(error).toBeInstanceOf(IodValidationError);
            expect(error.name).toBe("IodValidationError");
            expect(error.message).toContain("computed-radiography-image");
            expect(error.issues).toContainEqual(
                expect.objectContaining({
                    rule: "iod.type1.missing",
                    tag: "00280010",
                    keyword: "Rows",
                    severity: "error"
                })
            );
        }
    });

    test("lenient: returns the dataset despite errors (issues via validate)", async () => {
        const dataset = conformantDataset();
        delete dataset.Rows;
        await expect(
            asIod(dataset, undefined, { lenient: true })
        ).resolves.toBe(dataset);
        // Design: asIod stays a simple guard — the issue list is one
        // validate() call away, not attached to the dataset.
        const result = await validate(dataset, {
            layers: [1, 3],
            sopClassUid: CR_SOP_CLASS
        });
        expect(result.ok).toBe(false);
        expect(result.issues).toContainEqual(
            expect.objectContaining({ rule: "iod.type1.missing" })
        );
    });

    test("unknown SOP Class is a WARNING, not a throw (layer 3 skips)", async () => {
        const dataset = conformantDataset();
        await expect(asIod(dataset, "1.2.3.4")).resolves.toBe(dataset);
    });

    test("options.ignore passes through to validate", async () => {
        const dataset = conformantDataset();
        delete dataset.Rows;
        await expect(
            asIod(dataset, undefined, { ignore: ["iod.type1.missing"] })
        ).resolves.toBe(dataset);
    });
});
