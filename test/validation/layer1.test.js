/**
 * Layer 1 (structural) rule coverage: every rule id firing AND not firing,
 * over hand-built dict entries (tag-keyed {vr, Value} trees) and naturalized
 * datasets. JANE DOE identities only.
 */

import { validate, Severity, RULES } from "../../src/validation/index.js";

const ELE = "1.2.840.10008.1.2.1";

function baseDict(dictEntries, metaEntries = {}) {
    return {
        meta: {
            "00020010": { vr: "UI", Value: [ELE] },
            ...metaEntries
        },
        dict: dictEntries
    };
}

function ofRule(result, rule) {
    return result.issues.filter(issue => issue.rule === rule);
}

describe("validation layer 1 — structural checks", () => {
    test("result shape and layersRun", async () => {
        const result = await validate(baseDict({}));
        expect(result.ok).toBe(true);
        expect(result.issues).toEqual([]);
        expect(result.summary).toMatchObject({
            errors: 0,
            warnings: 0,
            infos: 0,
            layersRun: [1, 2]
        });
    });

    describe("vr.legality", () => {
        test("fires (ERROR) for an illegal VR code", async () => {
            const result = await validate(
                baseDict({
                    "00100020": { vr: "ZZ", Value: ["JANEDOE-MRN-1"] }
                })
            );
            const issues = ofRule(result, "vr.legality");
            expect(issues).toHaveLength(1);
            expect(issues[0].severity).toBe(Severity.ERROR);
            expect(issues[0].tag).toBe("00100020");
            expect(result.ok).toBe(false);
        });

        test("fires (WARNING) when the VR disagrees with the dictionary", async () => {
            const result = await validate(
                baseDict({
                    "00100020": { vr: "DA", Value: ["19700101"] } // PatientID is LO
                })
            );
            const issues = ofRule(result, "vr.legality");
            expect(issues).toHaveLength(1);
            expect(issues[0].severity).toBe(Severity.WARNING);
            expect(issues[0].keyword).toBe("PatientID");
        });

        test("does not fire for the dictionary VR, UN, or private tags", async () => {
            const result = await validate(
                baseDict({
                    "00100020": { vr: "LO", Value: ["JANEDOE-MRN-1"] },
                    "00100030": { vr: "UN", Value: [] },
                    "00090010": { vr: "LO", Value: ["JANE DOE VENDOR"] }
                })
            );
            expect(ofRule(result, "vr.legality")).toEqual([]);
        });
    });

    describe("vr.pattern", () => {
        test("fires for a malformed DA and a lowercase CS", async () => {
            const result = await validate(
                baseDict({
                    "00100030": { vr: "DA", Value: ["01/01/1970"] }, // PatientBirthDate
                    "00080060": { vr: "CS", Value: ["mr"] } // Modality
                })
            );
            const issues = ofRule(result, "vr.pattern");
            expect(issues.map(issue => issue.tag).sort()).toEqual([
                "00080060",
                "00100030"
            ]);
            issues.forEach(issue =>
                expect(issue.severity).toBe(Severity.ERROR)
            );
        });

        test("does not fire for conformant values or empty values", async () => {
            const result = await validate(
                baseDict({
                    "00100030": { vr: "DA", Value: ["19700101"] },
                    "00080060": { vr: "CS", Value: ["MR"] },
                    "00080020": { vr: "DA", Value: [] } // StudyDate, empty (Type 2)
                })
            );
            expect(ofRule(result, "vr.pattern")).toEqual([]);
        });
    });

    describe("vr.maxLength", () => {
        test("fires for a 17-char DS (#398 seed)", async () => {
            const result = await validate(
                baseDict({
                    // PatientWeight (0010,1030), DS
                    "00101030": { vr: "DS", Value: ["1.234567890123456"] }
                })
            );
            const issues = ofRule(result, "vr.maxLength");
            expect(issues).toHaveLength(1);
            expect(issues[0].tag).toBe("00101030");
            expect(issues[0].severity).toBe(Severity.ERROR);
        });

        test("does not fire at exactly 16 chars", async () => {
            const result = await validate(
                baseDict({
                    "00101030": { vr: "DS", Value: ["1.23456789012345"] }
                })
            );
            expect(ofRule(result, "vr.maxLength")).toEqual([]);
        });
    });

    describe("vm.count", () => {
        test("fires for a multivalued CS over VM 1 (#487 seed)", async () => {
            const result = await validate(
                baseDict({
                    // PhotometricInterpretation, VM 1
                    "00280004": {
                        vr: "CS",
                        Value: ["MONOCHROME2", "MONOCHROME1"]
                    }
                })
            );
            const issues = ofRule(result, "vm.count");
            expect(issues).toHaveLength(1);
            expect(issues[0]).toMatchObject({
                severity: Severity.ERROR,
                tag: "00280004",
                keyword: "PhotometricInterpretation"
            });
        });

        test("fires below a fixed VM (ImageOrientationPatient 5/6)", async () => {
            const result = await validate(
                baseDict({
                    "00200037": {
                        vr: "DS",
                        Value: ["1", "0", "0", "0", "1"]
                    }
                })
            );
            expect(ofRule(result, "vm.count")).toHaveLength(1);
        });

        test("does not fire for conformant counts, empties, or sequences", async () => {
            const result = await validate(
                baseDict({
                    "00280004": { vr: "CS", Value: ["MONOCHROME2"] },
                    "00200037": {
                        vr: "DS",
                        Value: ["1", "0", "0", "0", "1", "0"]
                    },
                    "00201041": { vr: "DS", Value: [] }, // empty is Type 2 legal
                    // multi-item sequence: item count is NOT VM
                    "00081110": {
                        vr: "SQ",
                        Value: [
                            {
                                "00100010": {
                                    vr: "PN",
                                    Value: ["DOE^JANE"]
                                }
                            },
                            {
                                "00100010": {
                                    vr: "PN",
                                    Value: ["DOE^JANE"]
                                }
                            }
                        ]
                    }
                })
            );
            expect(ofRule(result, "vm.count")).toEqual([]);
        });
    });

    describe("uid.format", () => {
        test.each([
            ["letters", "1.2.NOT-A-UID.3"],
            ["empty component", "1..2"],
            ["too long", "1." + "2".repeat(63) + ".3"]
        ])("fires for %s", async (_name, uid) => {
            const result = await validate(
                baseDict({
                    "00080018": { vr: "UI", Value: [uid] } // SOPInstanceUID
                })
            );
            const issues = ofRule(result, "uid.format");
            expect(issues).toHaveLength(1);
            expect(issues[0].severity).toBe(Severity.ERROR);
        });

        test("does not fire for a valid UID (and does not double-report as vr.*)", async () => {
            const result = await validate(
                baseDict({
                    "00080018": { vr: "UI", Value: ["1.2.840.10008.1.1"] }
                })
            );
            expect(ofRule(result, "uid.format")).toEqual([]);
            expect(ofRule(result, "vr.pattern")).toEqual([]);
            expect(ofRule(result, "vr.maxLength")).toEqual([]);
        });
    });

    describe("charset.terms", () => {
        test("fires ERROR for an unsupported term", async () => {
            const result = await validate(
                baseDict({
                    "00080005": { vr: "CS", Value: ["KLINGON"] }
                })
            );
            const issues = ofRule(result, "charset.terms");
            expect(issues).toHaveLength(1);
            expect(issues[0].severity).toBe(Severity.ERROR);
        });

        test("fires WARNING for the lenient bare GB2312 alias", async () => {
            const result = await validate(
                baseDict({
                    "00080005": { vr: "CS", Value: ["GB2312"] }
                })
            );
            const issues = ofRule(result, "charset.terms");
            expect(issues).toHaveLength(1);
            expect(issues[0].severity).toBe(Severity.WARNING);
        });

        test("does not fire for defined terms", async () => {
            for (const term of ["ISO_IR 100", "ISO_IR 192", "GB18030"]) {
                const result = await validate(
                    baseDict({
                        "00080005": { vr: "CS", Value: [term] }
                    })
                );
                expect(ofRule(result, "charset.terms")).toEqual([]);
            }
        });
    });

    describe("charset.valueOrder", () => {
        test("fires when ISO 2022 IR 87 is value 1", async () => {
            const result = await validate(
                baseDict({
                    "00080005": {
                        vr: "CS",
                        Value: ["ISO 2022 IR 87", "ISO 2022 IR 13"]
                    }
                })
            );
            const issues = ofRule(result, "charset.valueOrder");
            expect(issues.length).toBeGreaterThanOrEqual(1);
            expect(issues[0].severity).toBe(Severity.ERROR);
        });

        test("fires when value 1 of a multi-valued list is not ISO 2022", async () => {
            const result = await validate(
                baseDict({
                    "00080005": {
                        vr: "CS",
                        Value: ["ISO_IR 100", "ISO 2022 IR 87"]
                    }
                })
            );
            expect(
                ofRule(result, "charset.valueOrder").length
            ).toBeGreaterThanOrEqual(1);
        });

        test("fires when a later value is not an ISO 2022 term", async () => {
            const result = await validate(
                baseDict({
                    "00080005": {
                        vr: "CS",
                        Value: ["ISO 2022 IR 13", "ISO_IR 100"]
                    }
                })
            );
            expect(
                ofRule(result, "charset.valueOrder").length
            ).toBeGreaterThanOrEqual(1);
        });

        test("does not fire for a conformant code-extension list", async () => {
            for (const values of [
                ["", "ISO 2022 IR 87"],
                ["ISO 2022 IR 13", "ISO 2022 IR 87"],
                ["ISO 2022 IR 6", "ISO 2022 IR 149"]
            ]) {
                const result = await validate(
                    baseDict({
                        "00080005": { vr: "CS", Value: values }
                    })
                );
                expect(ofRule(result, "charset.valueOrder")).toEqual([]);
            }
        });
    });

    describe("naturalized dataset input", () => {
        test("runs the same checks on keyword-keyed datasets", async () => {
            const result = await validate({
                PatientName: { Alphabetic: "DOE^JANE" },
                PatientID: "JANEDOE-MRN-1",
                Modality: "mr", // vr.pattern (CS lowercase)
                PhotometricInterpretation: ["MONOCHROME2", "MONOCHROME1"], // vm.count
                SOPInstanceUID: "1..2", // uid.format
                ReferencedStudySequence: [{ ReferencedSOPInstanceUID: "1.2.3" }]
            });
            expect(ofRule(result, "vr.pattern")).toHaveLength(1);
            expect(ofRule(result, "vm.count")).toHaveLength(1);
            expect(ofRule(result, "uid.format")).toHaveLength(1);
        });

        test("clean naturalized dataset validates ok", async () => {
            const result = await validate({
                PatientName: { Alphabetic: "DOE^JANE" },
                PatientID: "JANEDOE-MRN-1",
                Modality: "MR",
                SOPInstanceUID: "1.2.3.4"
            });
            expect(result.ok).toBe(true);
            expect(result.issues).toEqual([]);
        });
    });

    describe("options surface", () => {
        test("options.ignore suppresses rule ids", async () => {
            const result = await validate(
                baseDict({
                    "00080060": { vr: "CS", Value: ["mr"] }
                }),
                { ignore: ["vr.pattern"] }
            );
            expect(result.issues).toEqual([]);
            expect(result.ok).toBe(true);
        });

        test("options.maxIssues caps the issue list", async () => {
            const result = await validate(
                baseDict({
                    "00080060": { vr: "CS", Value: ["mr"] },
                    "00100030": { vr: "DA", Value: ["01/01/1970"] },
                    "00080018": { vr: "UI", Value: ["1..2"] }
                }),
                { maxIssues: 2 }
            );
            expect(result.issues).toHaveLength(2);
        });

        test("options.layers = [1] skips layer 2, [1,2,3] runs layer 3", async () => {
            const layer1Only = await validate(baseDict({}), { layers: [1] });
            expect(layer1Only.summary.layersRun).toEqual([1]);

            // No SOP Class UID in the dataset: layer 3 runs and reports the
            // single skip WARNING (real IOD coverage: layer3.test.js).
            const withLayer3 = await validate(baseDict({}), {
                layers: [1, 2, 3]
            });
            expect(withLayer3.summary.layersRun).toEqual([1, 2, 3]);
            const skipped = ofRule(withLayer3, "iod.unknownSopClass");
            expect(skipped).toHaveLength(1);
            expect(skipped[0].severity).toBe(Severity.WARNING);
        });

        test("every emitted rule id is declared in RULES", async () => {
            const result = await validate(
                baseDict({
                    "00080060": { vr: "CS", Value: ["mr"] },
                    "00080018": { vr: "UI", Value: ["1..2"] }
                }),
                { layers: [1, 2, 3] }
            );
            for (const issue of result.issues) {
                expect(RULES).toContain(issue.rule);
            }
        });
    });
});
