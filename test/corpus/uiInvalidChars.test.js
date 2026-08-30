/**
 * Corpus reproducer: UI values with invalid characters must not be silently
 * rewritten into DIFFERENT valid-looking UIDs.
 *
 * Diagnosed against (corpus-cache, not copied):
 *   - gdcmdata/CT-MONO2-8-abdo.dcm — SeriesInstanceUID "REM SAMPLES 1";
 *     dcmjs read it as "1" (every non-[0-9.] character stripped) while
 *     dicom-parser kept the raw string.
 *   - pydicom-data/data_store/data/bad_sequence.dcm — StudyInstanceUID with
 *     hex letters, silently reduced to a digits-only string.
 *
 * Byte pattern synthesized: UI elements whose stored values contain
 * spaces/letters. Lenient-read policy pinned here: the stored value is
 * preserved (padding-trimmed only) — a corrupt UID stays visibly corrupt
 * for validation to flag, instead of mutating into a plausible identity.
 */
import dcmjs from "../../src/index.js";
import {
    EXPLICIT_LE,
    concatBytes,
    evrEl,
    part10,
    toArrayBuffer
} from "./syntheticPart10.js";

const { DicomMessage } = dcmjs.data;

describe("UI invalid characters are preserved on read (CT-MONO2-8-abdo corpus shape)", () => {
    it("keeps the raw string instead of stripping to a different UID", () => {
        const body = concatBytes(
            evrEl(0x0020, 0x000d, "UI", "2b9a0c3f.1.7d\0"),
            evrEl(0x0020, 0x000e, "UI", "REM SAMPLES 1\0")
        );
        const dict = DicomMessage.readFile(
            toArrayBuffer(part10(EXPLICIT_LE, body))
        ).dict;
        // Old behavior: "REM SAMPLES 1" -> "1" and "2b9a0c3f.1.7d" -> "203.17"
        // — silent mutation into different valid-looking UIDs.
        expect(dict["0020000E"].Value).toEqual(["REM SAMPLES 1"]);
        expect(dict["0020000D"].Value).toEqual(["2b9a0c3f.1.7d"]);
        // The raw stored value (pad byte already stripped by the padded
        // read) is retained for round-trips.
        expect(dict["0020000E"]._rawValue).toEqual(["REM SAMPLES 1"]);
    });

    it("still trims NUL padding and whitespace from valid UIDs", () => {
        const body = concatBytes(
            evrEl(0x0020, 0x000d, "UI", "1.2.826.0.1.3680043.8.999.3\0"),
            evrEl(0x0020, 0x000e, "UI", "1.2.840.10008.1.1\0")
        );
        const dict = DicomMessage.readFile(
            toArrayBuffer(part10(EXPLICIT_LE, body))
        ).dict;
        expect(dict["0020000D"].Value).toEqual(["1.2.826.0.1.3680043.8.999.3"]);
        expect(dict["0020000E"].Value).toEqual(["1.2.840.10008.1.1"]);
    });
});
