/**
 * Corpus reproducer: wrong (0002,0000) FileMetaInformationGroupLength that
 * silently derails the classic body walk.
 *
 * Diagnosed against (corpus-cache, not copied):
 *   - gdcmdata/PHILIPS_Gyroscan-8-MONO2-Odd_Sequence.dcm
 *
 * Byte pattern synthesized: the declared meta group length is 4 bytes SHORT
 * of the actual meta span, cutting the final (0002,0016) AE value (space
 * padding) in half. The classic reader used to accept the truncated window
 * (it still contained TransferSyntaxUID) and then start the body walk 4
 * bytes early — inside the AE's "    " padding — reading garbage tag
 * (2020,2020) whose bogus length swallowed the ENTIRE body: PatientName /
 * PatientID / StudyInstanceUID silently lost.
 *
 * Fixed via the element-length overrun guard in DicomMessage._readTag: the
 * truncated declared window now fails its strict parse, which triggers the
 * existing issue-#338 structural meta re-walk, and the body parses fully.
 */
import dcmjs from "../../src/index.js";
import {
    IMPLICIT_LE,
    concatBytes,
    evrEl,
    ivrEl,
    part10,
    toArrayBuffer
} from "./syntheticPart10.js";

const { DicomMessage } = dcmjs.data;

dcmjs.log.setLevel("silent");

function buildShortMetaFile() {
    const body = concatBytes(
        ivrEl(0x0008, 0x0060, "MR"),
        ivrEl(0x0010, 0x0010, "DOE^JANE"),
        ivrEl(0x0010, 0x0020, "JD-00000001 "),
        ivrEl(0x0020, 0x000d, "1.2.826.0.1.3680043.8.999.1\0"),
        ivrEl(0x0020, 0x000e, "1.2.826.0.1.3680043.8.999.2\0")
    );
    return part10(IMPLICIT_LE, body, {
        // (0002,0016) SourceApplicationEntityTitle: 16 bytes of space padding
        // — the element the short group length cuts into, exactly like the
        // Philips file's meta tail.
        extraMeta: evrEl(0x0002, 0x0016, "AE", "                "),
        groupLengthDelta: -4
    });
}

describe("short (0002,0000) meta group length (PHILIPS Gyroscan corpus shape)", () => {
    it("classic readFile recovers the meta boundary and reads the whole body", () => {
        const dicomDict = DicomMessage.readFile(
            toArrayBuffer(buildShortMetaFile())
        );
        expect(dicomDict.meta["00020010"].Value).toEqual([IMPLICIT_LE]);
        // Before the fix the body collapsed into a single garbage tag
        // ("20202020") and every real element was silently lost.
        expect(dicomDict.dict["20202020"]).toBeUndefined();
        expect(dicomDict.dict["00100010"].Value[0].Alphabetic).toBe("DOE^JANE");
        expect(dicomDict.dict["00100020"].Value).toEqual(["JD-00000001"]);
        expect(dicomDict.dict["0020000D"].Value).toEqual([
            "1.2.826.0.1.3680043.8.999.1"
        ]);
        expect(dicomDict.dict["0020000E"].Value).toEqual([
            "1.2.826.0.1.3680043.8.999.2"
        ]);
    });

    it("a correct group length still parses identically (control)", () => {
        const bytes = part10(
            IMPLICIT_LE,
            concatBytes(ivrEl(0x0010, 0x0010, "DOE^JANE")),
            { extraMeta: evrEl(0x0002, 0x0016, "AE", "                ") }
        );
        const dicomDict = DicomMessage.readFile(toArrayBuffer(bytes));
        expect(dicomDict.dict["00100010"].Value[0].Alphabetic).toBe("DOE^JANE");
    });
});
