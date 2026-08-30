/**
 * Layer 2 (cross-field) rule coverage: every rule id firing AND not firing,
 * over hand-built dict entries, synthesized Part 10 bytes
 * (test/helper/sampleDicomPart10.js), and direct ValidationListener event
 * feeds. JANE DOE identities only.
 */

import "../../src/index.js"; // side effect: DicomMessage/VR/Tag class wiring
import {
    validate,
    ValidationListener,
    Severity
} from "../../src/validation/index.js";
import { fromPart10Stream } from "../../src/eventStream/fromPart10Stream.js";
import {
    createSampleDicom,
    defaultImage
} from "../helper/sampleDicomPart10.js";
import { TagHex } from "../../src/constants/dicom.js";

const ELE = "1.2.840.10008.1.2.1";
const JPEG_BASELINE = "1.2.840.10008.1.2.4.50";

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

function imageDict(overrides = {}, pixelBytes) {
    return {
        "00280010": { vr: "US", Value: [defaultImage.rows] },
        "00280011": { vr: "US", Value: [defaultImage.columns] },
        "00280002": { vr: "US", Value: [defaultImage.samplesPerPixel] },
        "00280100": { vr: "US", Value: [defaultImage.bitsAllocated] },
        "00280008": {
            vr: "IS",
            Value: [String(defaultImage.numberOfFrames)]
        },
        "7FE00010": {
            vr: "OB",
            Value: [
                new ArrayBuffer(
                    pixelBytes === undefined
                        ? defaultImage.totalPixelBytes
                        : pixelBytes
                )
            ]
        },
        ...overrides
    };
}

async function validateStreamed(part10Buffer, options) {
    const bytes = new Uint8Array(part10Buffer);
    async function* chunks() {
        for (let offset = 0; offset < bytes.byteLength; offset += 4096) {
            yield bytes.subarray(
                offset,
                Math.min(offset + 4096, bytes.byteLength)
            );
        }
    }
    const listener = new ValidationListener(options || {});
    await fromPart10Stream(chunks(), listener, { ignoreErrors: true });
    return listener.finish();
}

describe("validation layer 2 — cross-field checks", () => {
    describe("pixel.dataLength (native)", () => {
        test("fires when PixelData is short of the geometry product", async () => {
            const result = await validate(baseDict(imageDict({}, 6000)));
            const issues = ofRule(result, "pixel.dataLength");
            expect(issues).toHaveLength(1);
            expect(issues[0]).toMatchObject({
                severity: Severity.ERROR,
                tag: TagHex.PixelData
            });
        });

        test("does not fire for coherent geometry (exact or +1 padding)", async () => {
            for (const bytes of [
                defaultImage.totalPixelBytes,
                defaultImage.totalPixelBytes + 1
            ]) {
                const result = await validate(baseDict(imageDict({}, bytes)));
                expect(ofRule(result, "pixel.dataLength")).toEqual([]);
            }
        });

        test("does not fire when the transfer syntax is not native", async () => {
            const result = await validate(
                baseDict(imageDict({}, 6000), {
                    "00020010": { vr: "UI", Value: [JPEG_BASELINE] }
                })
            );
            expect(ofRule(result, "pixel.dataLength")).toEqual([]);
        });

        test("end-to-end over synthesized Part 10 bytes (streamed)", async () => {
            const shortFile = createSampleDicom(
                {},
                { pixelDataLength: 6000, pixelData: [new ArrayBuffer(6000)] }
            );
            const short = await validateStreamed(shortFile);
            expect(ofRule(short, "pixel.dataLength")).toHaveLength(1);

            const goodFile = createSampleDicom();
            const good = await validateStreamed(goodFile);
            expect(ofRule(good, "pixel.dataLength")).toEqual([]);
        });
    });

    describe("pixel.dataLength (encapsulated fragment coherence)", () => {
        function feedEncapsulated(listener, fragments, basicOffsetTable) {
            listener.startDataSet({ transferSyntaxUID: JPEG_BASELINE });
            listener.startFileMetaInformation();
            listener.startElement("00020010", { vr: "UI" });
            listener.value(JPEG_BASELINE, { index: 0 });
            listener.endElement();
            listener.endFileMetaInformation();
            listener.startElement(TagHex.PixelData, { vr: "OB" });
            listener.startBinary({ encapsulated: true, basicOffsetTable });
            for (const fragment of fragments) {
                listener.binaryFragment(fragment);
            }
            listener.endBinary();
            listener.endElement();
            listener.endDataSet();
        }

        test("fires for zero fragments and zero-length fragments", () => {
            const empty = new ValidationListener();
            feedEncapsulated(empty, []);
            const emptyIssues = ofRule(empty.finish(), "pixel.dataLength");
            expect(emptyIssues).toHaveLength(1);
            expect(emptyIssues[0].severity).toBe(Severity.ERROR);

            const zeroLen = new ValidationListener();
            feedEncapsulated(zeroLen, [
                new ArrayBuffer(100),
                new ArrayBuffer(0)
            ]);
            const zeroIssues = ofRule(zeroLen.finish(), "pixel.dataLength");
            expect(zeroIssues).toHaveLength(1);
            expect(zeroIssues[0].severity).toBe(Severity.WARNING);
        });

        test("fires WARNING for an insane Basic Offset Table", () => {
            const listener = new ValidationListener();
            feedEncapsulated(
                listener,
                [new ArrayBuffer(100), new ArrayBuffer(100)],
                [108, 0]
            );
            const issues = ofRule(listener.finish(), "pixel.dataLength");
            expect(issues).toHaveLength(1);
            expect(issues[0].severity).toBe(Severity.WARNING);
        });

        test("does not fire for coherent fragments and BOT", () => {
            const listener = new ValidationListener();
            feedEncapsulated(
                listener,
                [new ArrayBuffer(100), new ArrayBuffer(100)],
                [0, 108]
            );
            expect(ofRule(listener.finish(), "pixel.dataLength")).toEqual([]);
        });
    });

    describe("pixel.bitsStored / pixel.highBit", () => {
        test("fire for BitsStored > BitsAllocated and HighBit mismatch", async () => {
            const result = await validate(
                baseDict(
                    imageDict({
                        "00280101": { vr: "US", Value: [12] },
                        "00280102": { vr: "US", Value: [7] }
                    })
                )
            );
            expect(ofRule(result, "pixel.bitsStored")).toHaveLength(1);
            expect(ofRule(result, "pixel.highBit")).toHaveLength(1);
        });

        test("do not fire for coherent bit fields", async () => {
            const result = await validate(
                baseDict(
                    imageDict({
                        "00280101": { vr: "US", Value: [8] },
                        "00280102": { vr: "US", Value: [7] }
                    })
                )
            );
            expect(ofRule(result, "pixel.bitsStored")).toEqual([]);
            expect(ofRule(result, "pixel.highBit")).toEqual([]);
        });
    });

    describe("palette.descriptor", () => {
        function paletteDict(dataBytes, descriptor = [256, 0, 16]) {
            return baseDict({
                "00281101": { vr: "US", Value: descriptor },
                "00281201": { vr: "OW", Value: [new ArrayBuffer(dataBytes)] }
            });
        }

        test("fires when LUT data length contradicts the descriptor", async () => {
            const result = await validate(paletteDict(300));
            const issues = ofRule(result, "palette.descriptor");
            expect(issues).toHaveLength(1);
            expect(issues[0].severity).toBe(Severity.ERROR);
        });

        test("does not fire for coherent descriptors (incl. 0 = 65536 entries and 8-bit-in-words)", async () => {
            expect(
                ofRule(await validate(paletteDict(512)), "palette.descriptor")
            ).toEqual([]);
            expect(
                ofRule(
                    await validate(paletteDict(131072, [0, 0, 16])),
                    "palette.descriptor"
                )
            ).toEqual([]);
            // 8-bit entries stored one per 16-bit word
            expect(
                ofRule(
                    await validate(paletteDict(512, [256, 0, 8])),
                    "palette.descriptor"
                )
            ).toEqual([]);
        });
    });

    describe("ts.encapsulation", () => {
        test("fires for encapsulated PixelData under a native syntax", async () => {
            const result = await validate(
                baseDict({
                    "7FE00010": {
                        vr: "OB",
                        Value: [new ArrayBuffer(100)],
                        encapsulatedPixelData: true
                    }
                })
            );
            const issues = ofRule(result, "ts.encapsulation");
            expect(issues).toHaveLength(1);
            expect(issues[0].severity).toBe(Severity.ERROR);
        });

        test("does not fire under an encapsulated syntax", async () => {
            const result = await validate(
                baseDict(
                    {
                        "7FE00010": {
                            vr: "OB",
                            Value: [new ArrayBuffer(100)],
                            encapsulatedPixelData: true
                        }
                    },
                    { "00020010": { vr: "UI", Value: [JPEG_BASELINE] } }
                )
            );
            expect(ofRule(result, "ts.encapsulation")).toEqual([]);
        });
    });

    describe("fmi.groupLength", () => {
        // Canonical sizes: (0002,0002) 8+26, (0002,0003) 8+6, (0002,0010) 8+20
        const META = {
            "00020002": {
                vr: "UI",
                Value: ["1.2.840.10008.5.1.4.1.1.7"]
            },
            "00020003": { vr: "UI", Value: ["1.2.3"] },
            "00020010": { vr: "UI", Value: [ELE] }
        };
        const CORRECT = 34 + 14 + 28;

        test("fires when the declared value disagrees with the recomputed size", async () => {
            const result = await validate({
                meta: {
                    "00020000": { vr: "UL", Value: [CORRECT + 8] },
                    ...META
                },
                dict: {}
            });
            const issues = ofRule(result, "fmi.groupLength");
            expect(issues).toHaveLength(1);
            expect(issues[0]).toMatchObject({
                severity: Severity.ERROR,
                tag: "00020000"
            });
        });

        test("does not fire when the declared value matches", async () => {
            const result = await validate({
                meta: {
                    "00020000": { vr: "UL", Value: [CORRECT] },
                    ...META
                },
                dict: {}
            });
            expect(ofRule(result, "fmi.groupLength")).toEqual([]);
        });

        test("#338 fixture pattern: patched (0002,0000) fires on the streamed path", async () => {
            // (0002,0000) UL value sits at byte offset 140 (preamble 128 +
            // "DICM" 4 + tag 4 + VR 2 + len 2) — the issue #338 reproducer.
            const buffer = createSampleDicom();
            const patched = buffer.slice(0);
            const view = new DataView(patched);
            view.setUint32(140, view.getUint32(140, true) + 8, true);

            const result = await validateStreamed(patched);
            expect(
                ofRule(result, "fmi.groupLength").length
            ).toBeGreaterThanOrEqual(1);
        });
    });

    describe("charset.observed", () => {
        test("INFO when non-ASCII text rides an ASCII (implied) charset", async () => {
            const result = await validate(
                baseDict({
                    // InstitutionName (0008,0080), LO — not an identity
                    "00080080": { vr: "LO", Value: ["HÔPITAL GÉNÉRAL"] }
                })
            );
            const issues = ofRule(result, "charset.observed");
            expect(issues).toHaveLength(1);
            expect(issues[0].severity).toBe(Severity.INFO);
            expect(result.ok).toBe(true); // INFO does not fail validation
        });

        test("does not fire when a non-ASCII charset is declared", async () => {
            const result = await validate(
                baseDict({
                    "00080005": { vr: "CS", Value: ["ISO_IR 100"] },
                    "00080080": { vr: "LO", Value: ["HÔPITAL"] }
                })
            );
            expect(ofRule(result, "charset.observed")).toEqual([]);
        });
    });

    describe("layers option", () => {
        test("layers [1] skips every layer-2 rule", async () => {
            const result = await validate(baseDict(imageDict({}, 6000)), {
                layers: [1]
            });
            expect(ofRule(result, "pixel.dataLength")).toEqual([]);
            expect(result.summary.layersRun).toEqual([1]);
        });
    });
});
