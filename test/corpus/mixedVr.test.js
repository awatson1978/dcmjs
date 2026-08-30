/**
 * Corpus reproducer: mixed explicit/implicit VR datasets must fail with
 * corrective errors on every path — never hang, never throw a raw
 * non-Error object, never a bare TypeError.
 *
 * Diagnosed against (corpus-cache, not copied):
 *   - gdcmdata/DMCPACS_ExplicitImplicit_BogusIOP.dcm
 *   - gdcmdata/ExplicitVRforPublicElementsImplicitVRforShadowElements.dcm
 *     (the second one previously HUNG the stream parser in a wave-2 sweep
 *     before dying with a truncation error; the buffered path surfaced the
 *     parser's raw `{ exception, dataSet }` object as "[object Object]")
 *
 * Byte pattern synthesized: a file that declares Explicit VR Little Endian
 * but encodes body elements implicitly (tag + 4-byte length, no VR bytes),
 * so the explicit walk reads value bytes as VR/length and derails into a
 * huge phantom length.
 *
 * NOTE for the team: actually PARSING these files (per-element explicit/
 * implicit sniffing, like GDCM/dcm4che do) is a mixed-VR leniency
 * enhancement — a design decision deliberately NOT taken here. This test
 * pins only the failure MODE: prompt, corrective, Error-typed.
 */
import dcmjs from "../../src/index.js";
import { fromPart10 } from "../../src/eventStream/fromPart10.js";
import { fromPart10Stream } from "../../src/eventStream/fromPart10Stream.js";
import { CollectorListener } from "../../src/eventStream/CollectorListener.js";
import {
    EXPLICIT_LE,
    concatBytes,
    chunked,
    evrEl,
    ivrEl,
    part10,
    toArrayBuffer
} from "./syntheticPart10.js";

const { DicomMessage } = dcmjs.data;

dcmjs.log.setLevel("silent");

function buildMixedVrFile() {
    const body = concatBytes(
        // Public elements: explicit VR.
        evrEl(0x0008, 0x0060, "CS", "OT"),
        evrEl(0x0010, 0x0010, "PN", "DOE^JANE"),
        // Shadow (private) elements: implicit VR inside the explicit dataset.
        // The explicit walk reads the first value bytes as VR/length and
        // derails (the "ExplicitVRforPublicElementsImplicitVRforShadow
        // Elements" corpus shape).
        ivrEl(0x0009, 0x0010, "SYNTHETIC PRIVATE CREATOR JD"),
        ivrEl(0x0009, 0x1001, "MORE SYNTHETIC PRIVATE PAYLOAD BYTES"),
        evrEl(0x0020, 0x000d, "UI", "1.2.826.0.1.3680043.8.999.4\0")
    );
    return part10(EXPLICIT_LE, body);
}

describe("mixed explicit/implicit VR fails correctively on every path (DMCPACS corpus shape)", () => {
    const file = buildMixedVrFile();

    it("classic readFile never hangs or bare-crashes (lenient partial parse or real Error)", () => {
        // The classic reader's pinned upstream leniency clamp-parses the
        // derailed elements (with warnings) — on the real corpus files it
        // returns a partial dict. Pin the failure MODE only: prompt (the
        // 15s jest timeout is the hang guard), and if it throws, a real
        // Error — never a raw object, never a bare TypeError.
        let error = null;
        let dicomDict = null;
        try {
            dicomDict = DicomMessage.readFile(toArrayBuffer(file));
        } catch (e) {
            error = e;
        }
        if (error !== null) {
            expect(error).toBeInstanceOf(Error);
            expect(error).not.toBeInstanceOf(TypeError);
            expect(String(error.message)).not.toBe("[object Object]");
        } else {
            // Lenient partial parse: the explicit elements before the VR
            // switch must be intact.
            expect(dicomDict.dict["00100010"].Value[0].Alphabetic).toBe(
                "DOE^JANE"
            );
        }
    }, 15000);

    it("buffered fromPart10 rejects with a real Error (parser object throws are wrapped)", async () => {
        const listener = new CollectorListener();
        let error = null;
        try {
            await fromPart10(toArrayBuffer(file), listener);
        } catch (e) {
            error = e;
        }
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(TypeError);
        expect(String(error.message)).not.toBe("[object Object]");
    }, 15000);

    it("streamed fromPart10Stream rejects promptly (hang guard)", async () => {
        const listener = new CollectorListener();
        let error = null;
        try {
            await fromPart10Stream(chunked(file, 64), listener);
        } catch (e) {
            error = e;
        }
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(TypeError);
    }, 15000);
});
