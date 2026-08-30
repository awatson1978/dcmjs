/**
 * Corpus reproducer: preamble-less and meta-less inputs under the
 * readFile allowMissingHeader opt-in (issue #93).
 *
 * Diagnosed against (corpus-cache, not copied):
 *   - pydicom-data/data_store/data/JLSL_RGB_ILV0/1/2.dcm, JLSN_RGB_ILV0.dcm —
 *     no 128-byte preamble/DICM; the FMI starts DIRECTLY at (0002,0010)
 *     with no (0002,0000) group length. allowMissingHeader previously still
 *     threw "meta length tag is malformed or not present"; it now extends
 *     to group-length-less FMI (it is an explicit leniency opt-in).
 *   - gdcmdata/OT-PAL-8-face.dcm (also in pydicom-data) — a completely bare
 *     implicit-VR dataset (starts at (0008,0000), no preamble, no FMI),
 *     which allowMissingHeader already handled; pinned here.
 *
 * Byte patterns synthesized: (a) FMI-first file without (0002,0000);
 * (b) bare implicit-VR dataset.
 */
import dcmjs from "../../src/index.js";
import {
    EXPLICIT_LE,
    concatBytes,
    evrEl,
    ivrEl,
    toArrayBuffer
} from "./syntheticPart10.js";

const { DicomMessage } = dcmjs.data;

dcmjs.log.setLevel("silent");

describe("allowMissingHeader corpus shapes", () => {
    it("reads a preamble-less file whose FMI lacks (0002,0000) (JPEG-LS corpus shape)", () => {
        const tsValue =
            EXPLICIT_LE.length % 2 ? EXPLICIT_LE + "\0" : EXPLICIT_LE;
        const bytes = concatBytes(
            evrEl(0x0002, 0x0010, "UI", tsValue),
            evrEl(0x0002, 0x0013, "SH", "SYNTH-JD  "),
            evrEl(0x0008, 0x0060, "CS", "OT"),
            evrEl(0x0010, 0x0010, "PN", "DOE^JANE")
        );
        // Default read refuses (no DICM magic).
        expect(() => DicomMessage.readFile(toArrayBuffer(bytes))).toThrow(
            /expected header is missing/
        );
        // The opt-in reads it.
        const dicomDict = DicomMessage.readFile(toArrayBuffer(bytes), {
            allowMissingHeader: true
        });
        expect(dicomDict.meta["00020010"].Value).toEqual([EXPLICIT_LE]);
        expect(dicomDict.dict["00100010"].Value[0].Alphabetic).toBe("DOE^JANE");
    });

    it("reads a bare implicit-VR dataset with no preamble and no FMI (OT-PAL corpus shape)", () => {
        const bytes = concatBytes(
            ivrEl(0x0008, 0x0060, "OT"),
            ivrEl(0x0010, 0x0010, "DOE^JANE"),
            ivrEl(0x0028, 0x0010, new Uint8Array([0xe0, 0x01])), // Rows 480
            ivrEl(0x0028, 0x0011, new Uint8Array([0x40, 0x02])) // Columns 576
        );
        expect(() => DicomMessage.readFile(toArrayBuffer(bytes))).toThrow(
            /expected header is missing/
        );
        const dicomDict = DicomMessage.readFile(toArrayBuffer(bytes), {
            allowMissingHeader: true
        });
        expect(dicomDict.dict["00100010"].Value[0].Alphabetic).toBe("DOE^JANE");
        expect(dicomDict.dict["00280010"].Value).toEqual([480]);
        expect(dicomDict.dict["00280011"].Value).toEqual([576]);
    });
});
