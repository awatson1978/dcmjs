/**
 * Corpus reproducer: element with a defined length that overruns the
 * remaining stream.
 *
 * Diagnosed against (corpus-cache, not copied):
 *   - gdcmdata/LengthOfItemLarger.dcm  — a derailed walk reads a garbage tag
 *     declaring 281685 bytes with 8592 left.
 *   - gdcmdata/GE_GENESIS-16-MONO2-WrongLengthItem.dcm — garbage tag
 *     declaring 1.3 GB (phantom-allocation hazard).
 *   - gdcmdata/IM-0001-0066.dcm — trailing garbage after pixel data
 *     declaring 1.7 GB.
 *   - The dcmjs release fixture empty-tag-round-trip/zero-length-US.dcm pins
 *     the OPPOSITE requirement: a truncated trailing (5600,0010) OF element
 *     must still read (upstream leniency), so a hard overrun error is not
 *     an option for the classic/buffered paths.
 *
 * Byte pattern synthesized: a valid dataset followed by an element whose
 * declared length exceeds the bytes remaining. Pinned policy:
 *   - classic reads the truncated element by CLAMPING to the remaining
 *     bytes — with a warning, never a silent multi-GB phantom span;
 *   - every failing path fails with a real corrective Error (never a bare
 *     TypeError, never a raw non-Error object);
 *   - the streaming parser stays strict (a truncated element is
 *     indistinguishable from a cut network stream): corrective error.
 */
import dcmjs from "../../src/index.js";
import { fromPart10 } from "../../src/eventStream/fromPart10.js";
import { fromPart10Stream } from "../../src/eventStream/fromPart10Stream.js";
import { CollectorListener } from "../../src/eventStream/CollectorListener.js";
import {
    EXPLICIT_LE,
    chunked,
    concatBytes,
    evrEl,
    part10,
    toArrayBuffer
} from "./syntheticPart10.js";

const { DicomMessage } = dcmjs.data;

dcmjs.log.setLevel("silent");

function buildOverrunFile() {
    const body = concatBytes(
        evrEl(0x0010, 0x0010, "PN", "DOE^JANE"),
        evrEl(0x0010, 0x0020, "LO", "JD000002"),
        // Overrunning element: UN declaring 64 KiB with only 4 bytes present.
        evrEl(0x0009, 0x0001, "UN", "XXXX", 0x00010000)
    );
    return part10(EXPLICIT_LE, body);
}

describe("declared-length overrun (LengthOfItemLarger / zero-length-US corpus shapes)", () => {
    const file = buildOverrunFile();

    it("classic readFile clamps the truncated element and keeps prior data", () => {
        const dicomDict = DicomMessage.readFile(toArrayBuffer(file));
        expect(dicomDict.dict["00100010"].Value[0].Alphabetic).toBe("DOE^JANE");
        expect(dicomDict.dict["00100020"].Value).toEqual(["JD000002"]);
        // The overrun element reads the bytes that actually exist — not a
        // phantom 64 KiB span.
        const clamped = dicomDict.dict["00090001"];
        expect(clamped.vr).toBe("UN");
        expect(clamped.Value[0].byteLength).toBe(4);
    });

    it("buffered fromPart10 never bare-crashes: clamps or rejects with a real Error", async () => {
        const listener = new CollectorListener();
        let error = null;
        try {
            await fromPart10(toArrayBuffer(file), listener);
        } catch (e) {
            error = e;
        }
        if (error !== null) {
            // The @dcmjs/parser tokenizer may reject the overrun outright —
            // that must surface as a real corrective Error (it used to be a
            // raw `{ exception, dataSet }` object printing "[object
            // Object]").
            expect(error).toBeInstanceOf(Error);
            expect(error).not.toBeInstanceOf(TypeError);
            expect(String(error.message)).not.toBe("[object Object]");
        } else {
            expect(listener.result.dict["00100010"].Value[0].Alphabetic).toBe(
                "DOE^JANE"
            );
        }
    });

    it("streamed fromPart10Stream stays strict: corrective truncation error", async () => {
        const listener = new CollectorListener();
        await expect(
            fromPart10Stream(chunked(file, 64), listener)
        ).rejects.toThrow(/truncated|declares/);
    });

    it("a trailing truncated element after good data still reads on the classic path (zero-length-US fixture shape)", () => {
        // (5600,0010) OF declaring far more than remains — the upstream
        // fixture's exact shape, synthesized.
        const body = concatBytes(
            evrEl(0x0010, 0x0010, "PN", "DOE^JANE"),
            evrEl(0x5600, 0x0010, "OF", "\x01\x02\x03\x04\x05\x06\x07\x08", 0x00205600)
        );
        const dicomDict = DicomMessage.readFile(
            toArrayBuffer(part10(EXPLICIT_LE, body))
        );
        expect(dicomDict.dict["00100010"].Value[0].Alphabetic).toBe("DOE^JANE");
        expect(dicomDict.dict["56000010"]).toBeTruthy();
    });
});
