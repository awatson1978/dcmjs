/**
 * Corpus reproducer: PN component groups (alphabetic=ideographic=phonetic).
 *
 * Diagnosed against (corpus-cache, not copied):
 *   - gdcmdata/EmptyIcon_Bug417.dcm — PatientName "ANON^PATIENT=>NASALFLOW"
 *
 * The wave-2 sweep reported the "=..." component group as dropped. Diagnosis
 * showed dcmjs preserves it correctly ({Alphabetic, Ideographic} both
 * populate) — the sweep's dicom-parser comparator was flattening the PN
 * model object to its Alphabetic group only (fixed in
 * scripts/corpus-runner.mjs). These tests pin the library behavior so a
 * real regression in PN group handling cannot hide behind the comparator.
 *
 * Byte pattern synthesized: PN values with 2 and 3 component groups
 * (PS3.5 6.2.1), including the corpus file's quirk shape where the second
 * group starts with a non-alphabetic character (">").
 */
import dcmjs from "../../src/index.js";
import { fromPart10 } from "../../src/eventStream/fromPart10.js";
import { CollectorListener } from "../../src/eventStream/CollectorListener.js";
import {
    EXPLICIT_LE,
    concatBytes,
    evrEl,
    part10,
    toArrayBuffer
} from "./syntheticPart10.js";

const { DicomMessage } = dcmjs.data;

function buildPnFile() {
    const body = concatBytes(
        // Three full component groups.
        evrEl(0x0010, 0x0010, "PN", "DOE^JANE=DOE^JANE^IDEO=DOE^JANE^PHON"),
        // The EmptyIcon_Bug417 quirk shape: "=>" — an ideographic group
        // whose first character is ">".
        evrEl(0x0010, 0x1001, "PN", "DOE^JANE=>SYNTHFLOW ")
    );
    return part10(EXPLICIT_LE, body);
}

describe("PN component groups are preserved (EmptyIcon_Bug417 corpus shape)", () => {
    const file = buildPnFile();

    it("classic readFile populates Alphabetic/Ideographic/Phonetic", () => {
        const dict = DicomMessage.readFile(toArrayBuffer(file)).dict;
        expect(dict["00100010"].Value).toEqual([
            {
                Alphabetic: "DOE^JANE",
                Ideographic: "DOE^JANE^IDEO",
                Phonetic: "DOE^JANE^PHON"
            }
        ]);
        expect(dict["00101001"].Value).toEqual([
            { Alphabetic: "DOE^JANE", Ideographic: ">SYNTHFLOW" }
        ]);
    });

    it("buffered fromPart10 preserves the same component groups", async () => {
        const listener = new CollectorListener();
        await fromPart10(toArrayBuffer(file), listener);
        const pn = listener.result.dict["00100010"].Value[0];
        expect(pn.Alphabetic).toBe("DOE^JANE");
        expect(pn.Ideographic).toBe("DOE^JANE^IDEO");
        expect(pn.Phonetic).toBe("DOE^JANE^PHON");
    });
});
