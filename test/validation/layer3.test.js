/**
 * Layer 3 (IOD/module) rule coverage: real-fixture calibration expectations
 * plus synthetic Part 10 datasets from the sampleDicomPart10 helper (default
 * SOP Class: Computed Radiography Image Storage, CIOD
 * "computed-radiography-image"). JANE DOE identities only.
 */

import "../../src/index.js"; // side effect: DicomMessage/VR/Tag class wiring
import fs from "fs";
import path from "path";
import {
    validate,
    ValidationListener,
    Severity
} from "../../src/validation/index.js";
import { UNKNOWN_ATTRIBUTE_LIMIT } from "../../src/validation/layer3.js";
import { fromPart10Stream } from "../../src/eventStream/fromPart10Stream.js";
import { DicomMessage } from "../../src/DicomMessage.js";
import { createSampleDicom } from "../helper/sampleDicomPart10.js";

const LAYERS = { layers: [1, 2, 3] };
const CR_SOP_CLASS = "1.2.840.10008.5.1.4.1.1.1";

function ofRule(result, rule) {
    return result.issues.filter(issue => issue.rule === rule);
}

function readArrayBuffer(name) {
    const data = fs.readFileSync(path.join(__dirname, "..", name));
    return data.buffer.slice(
        data.byteOffset,
        data.byteOffset + data.byteLength
    );
}

/**
 * Default synthetic CR file as a DicomDict, with optional dict mutation.
 * The helper only writes (0008,0016) into the file meta, so mirror it into
 * the dataset — layer 3 resolves the CIOD from the dataset SOP Class UID.
 */
function sampleDict(mutate) {
    const dicomDict = DicomMessage.readFile(createSampleDicom(), {
        ignoreErrors: true
    });
    dicomDict.dict["00080016"] = { vr: "UI", Value: [CR_SOP_CLASS] };
    if (mutate) {
        mutate(dicomDict.dict);
    }
    return dicomDict;
}

describe("validation layer 3 — real fixture (sample-dicom.dcm)", () => {
    let result;
    beforeAll(async () => {
        // sample-dicom.dcm is MR Image Storage (NOT CT — verified):
        // (0008,0016) = 1.2.840.10008.5.1.4.1.1.4 -> CIOD "mr-image".
        const dicomDict = DicomMessage.readFile(
            readArrayBuffer("sample-dicom.dcm"),
            { ignoreErrors: true }
        );
        result = await validate(dicomDict, LAYERS);
    });

    test("resolves the real CIOD and runs all three layers", () => {
        expect(result.summary.sopClassUid).toBe("1.2.840.10008.5.1.4.1.1.4");
        expect(result.summary.iod).toBe("mr-image");
        expect(result.summary.layersRun).toEqual([1, 2, 3]);
        expect(ofRule(result, "iod.unknownSopClass")).toEqual([]);
    });

    test("calibration: a conformant fixture has no layer-3 errors", () => {
        const iodErrors = result.issues.filter(
            issue =>
                issue.rule.startsWith("iod.") &&
                issue.severity === Severity.ERROR
        );
        expect(iodErrors).toEqual([]);
        expect(result.ok).toBe(true);
    });

    test("absent conditionals and unknown attributes surface as INFO", () => {
        const conditionals = ofRule(result, "iod.conditional");
        expect(conditionals.length).toBeGreaterThan(0);
        for (const issue of conditionals) {
            expect(issue.severity).toBe(Severity.INFO);
        }
        // Rate limit holds: at most the cap plus one remainder summary.
        const unknown = ofRule(result, "iod.unknownAttribute");
        expect(unknown.length).toBeLessThanOrEqual(UNKNOWN_ATTRIBUTE_LIMIT + 1);
    });
});

describe("validation layer 3 — synthetic CR datasets", () => {
    test("missing Rows -> iod.type1.missing ERROR", async () => {
        const result = await validate(
            sampleDict(dict => {
                delete dict["00280010"];
            }),
            LAYERS
        );
        const issues = ofRule(result, "iod.type1.missing").filter(
            issue => issue.tag === "00280010"
        );
        expect(issues).toHaveLength(1);
        expect(issues[0]).toMatchObject({
            severity: Severity.ERROR,
            tag: "00280010",
            keyword: "Rows",
            path: "00280010",
            module: "image-pixel"
        });
        expect(result.ok).toBe(false);
    });

    test("present-but-empty Type 1 -> iod.type1.empty ERROR", async () => {
        const result = await validate(
            sampleDict(dict => {
                dict["00280010"] = { vr: "US", Value: [] };
            }),
            LAYERS
        );
        const issues = ofRule(result, "iod.type1.empty").filter(
            issue => issue.tag === "00280010"
        );
        expect(issues).toHaveLength(1);
        expect(issues[0].severity).toBe(Severity.ERROR);
        expect(ofRule(result, "iod.type1.missing")).not.toContainEqual(
            expect.objectContaining({ tag: "00280010" })
        );
    });

    test("missing Type 2 -> iod.type2.missing ERROR (default file lacks patient data)", async () => {
        const result = await validate(sampleDict(), LAYERS);
        const issues = ofRule(result, "iod.type2.missing");
        expect(issues).toContainEqual(
            expect.objectContaining({
                severity: Severity.ERROR,
                tag: "00100010",
                keyword: "PatientName",
                module: "patient"
            })
        );
    });

    test("absent Type 2C -> INFO iod.conditional carrying the condition text", async () => {
        const result = await validate(sampleDict(), LAYERS);
        const laterality = ofRule(result, "iod.conditional").filter(
            issue => issue.tag === "00200060"
        );
        expect(laterality).toHaveLength(1);
        expect(laterality[0].severity).toBe(Severity.INFO);
        expect(laterality[0].module).toBe("general-series");
        expect(laterality[0].message).toContain(
            "Required if the body part examined is a paired structure"
        );
    });

    test("usage C module not in use -> INFO iod.conditionalModule with condition", async () => {
        const result = await validate(sampleDict(), LAYERS);
        const contrast = ofRule(result, "iod.conditionalModule").filter(
            issue => issue.module === "contrast-bolus"
        );
        expect(contrast).toHaveLength(1);
        expect(contrast[0].severity).toBe(Severity.INFO);
        expect(contrast[0].message).toContain(
            "Required if contrast media was used"
        );
    });

    test("usage C module IN use enforces its Type 2 rows (dciodvfy behavior)", async () => {
        const result = await validate(
            sampleDict(dict => {
                // ContrastBolusRoute is Type 3 in contrast-bolus — its
                // presence flips the module to in-use.
                dict["00181040"] = { vr: "LO", Value: ["ORAL"] };
            }),
            LAYERS
        );
        expect(ofRule(result, "iod.conditionalModule")).not.toContainEqual(
            expect.objectContaining({ module: "contrast-bolus" })
        );
        expect(ofRule(result, "iod.type2.missing")).toContainEqual(
            expect.objectContaining({
                tag: "00180010",
                keyword: "ContrastBolusAgent",
                module: "contrast-bolus",
                severity: Severity.ERROR
            })
        );
    });

    test("unknown SOP Class -> single WARNING, layer 3 stops", async () => {
        const result = await validate(
            sampleDict(dict => {
                dict["00080016"] = { vr: "UI", Value: ["1.2.3.4"] };
            }),
            LAYERS
        );
        const warnings = ofRule(result, "iod.unknownSopClass");
        expect(warnings).toHaveLength(1);
        expect(warnings[0].severity).toBe(Severity.WARNING);
        expect(warnings[0].message).toContain("1.2.3.4");
        const otherIod = result.issues.filter(
            issue =>
                issue.rule.startsWith("iod.") &&
                issue.rule !== "iod.unknownSopClass"
        );
        expect(otherIod).toEqual([]);
        expect(result.summary.iod).toBeUndefined();
    });

    test("iod.unknownAttribute is rate-limited with a remainder count", async () => {
        const result = await validate(
            sampleDict(dict => {
                // 13 RT-domain tags no CR module knows about.
                for (let i = 1; i <= 13; i++) {
                    const tag = `3010${String(i).padStart(4, "0")}`;
                    dict[tag] = { vr: "LO", Value: ["X"] };
                }
            }),
            { layers: [3] }
        );
        const unknown = ofRule(result, "iod.unknownAttribute");
        const located = unknown.filter(issue => issue.path);
        const remainder = unknown.filter(issue => !issue.path);
        expect(located).toHaveLength(UNKNOWN_ATTRIBUTE_LIMIT);
        expect(remainder).toHaveLength(1);
        expect(remainder[0].message).toMatch(/\d+ additional attributes/);
        for (const issue of unknown) {
            expect(issue.severity).toBe(Severity.INFO);
        }
    });

    test("known module attributes are not reported unknown", async () => {
        const result = await validate(sampleDict(), { layers: [3] });
        const unknownTags = ofRule(result, "iod.unknownAttribute").map(
            issue => issue.tag
        );
        expect(unknownTags).not.toContain("00280010"); // image-pixel
        expect(unknownTags).not.toContain("7FE00010"); // image-pixel (1C)
        // NumberOfFrames belongs to no CR module — honest INFO.
        expect(unknownTags).toContain("00280008");
    });
});

describe("validation layer 3 — streamed parity ([1,2,3])", () => {
    const FIXTURES = [
        "sample-dicom.dcm",
        "cine-test.dcm",
        "sample-op.dcm",
        "sample-sr.dcm",
        "invalid-vr-length-test.dcm",
        "no-meta-length-test.dcm"
    ];

    async function* chunked(arrayBuffer, size) {
        const bytes = new Uint8Array(arrayBuffer);
        for (let offset = 0; offset < bytes.byteLength; offset += size) {
            yield bytes.subarray(
                offset,
                Math.min(offset + size, bytes.byteLength)
            );
        }
    }

    function issueMultiset(result) {
        return result.issues
            .map(issue =>
                [
                    issue.rule,
                    issue.severity,
                    issue.tag || "",
                    issue.path || "",
                    issue.keyword || "",
                    issue.module || ""
                ].join("|")
            )
            .sort();
    }

    test.each(FIXTURES)("identical issue multisets for %s", async name => {
        const arrayBuffer = readArrayBuffer(name);

        const dicomDict = DicomMessage.readFile(arrayBuffer, {
            ignoreErrors: true
        });
        const eager = await validate(dicomDict, LAYERS);

        const listener = new ValidationListener(LAYERS);
        await fromPart10Stream(chunked(arrayBuffer, 4096), listener, {
            ignoreErrors: true
        });
        const streamed = listener.finish();

        expect(issueMultiset(streamed)).toEqual(issueMultiset(eager));
        expect(streamed.summary).toEqual(eager.summary);
        expect(streamed.ok).toBe(eager.ok);
    });
});
