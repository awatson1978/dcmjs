/**
 * Corpus reproducer: defined-length SQ encoded as VR "UN" (explicit VR LE).
 *
 * Diagnosed against (corpus-cache, not copied):
 *   - gdcmdata/MEDILABInvalidCP246_EVRLESQasUN.dcm     (0008,9215) SQ as UN
 *   - gdcmdata/CT-SIEMENS-MissingPixelDataInIconSQ.dcm (0029,1140) SQ as UN
 *   - pydicom-data/data_store/data/bad_sequence.dcm    (0018,9346) SQ as UN
 *
 * Byte pattern synthesized: an explicit-VR-LE element whose stored VR is UN
 * with a DEFINED length, whose dictionary VR is SQ, and whose value bytes are
 * an item (FFFE,E000) of explicit-VR elements (the "invalid CP246" shape —
 * item content explicit despite PS3.5 CP246 mandating implicit for UN).
 *
 * The classic reader re-parses such an element as a sequence
 * (ParsedUnknownValue). The buffered event-stream path (fromPart10 →
 * CollectorListener) instead pushed the decoded item dicts through the
 * scalar value() path and crashed with a bare
 * "TypeError: Cannot read properties of undefined (reading '0')"
 * (rawValues[index] with rawValues undefined). Fixed: sequence-shaped
 * decodes are emitted as sequence events on every path.
 */
import dcmjs from "../../src/index.js";
import { fromPart10 } from "../../src/eventStream/fromPart10.js";
import { fromPart10Stream } from "../../src/eventStream/fromPart10Stream.js";
import { CollectorListener } from "../../src/eventStream/CollectorListener.js";

const { DicomMessage } = dcmjs.data;
import {
    EXPLICIT_LE,
    chunked,
    concatBytes,
    evrEl,
    item,
    part10,
    toArrayBuffer
} from "./syntheticPart10.js";

// (0008,9215) DerivationCodeSequence — dictionary VR SQ — stored as UN with
// a defined length; item content is explicit-VR encoded.
function buildSqAsUnFile() {
    const itemContent = concatBytes(
        evrEl(0x0008, 0x0100, "SH", "121327"),
        evrEl(0x0008, 0x0102, "SH", "DCM "),
        evrEl(0x0008, 0x0104, "LO", "JANE DOE SYNTHETIC DERIVATION ENTRY ")
    );
    const sqValue = item(itemContent);
    const body = concatBytes(
        evrEl(0x0008, 0x0060, "CS", "OT"),
        evrEl(0x0008, 0x9215, "UN", sqValue),
        evrEl(0x0010, 0x0010, "PN", "DOE^JANE"),
        evrEl(0x0010, 0x0020, "LO", "JD000001")
    );
    return part10(EXPLICIT_LE, body);
}

describe("defined-length SQ encoded as UN (MEDILAB/SIEMENS corpus shape)", () => {
    const file = buildSqAsUnFile();

    it("classic readFile re-parses the UN element as a sequence", () => {
        const dict = DicomMessage.readFile(toArrayBuffer(file)).dict;
        const seq = dict["00089215"];
        expect(seq.vr).toBe("SQ");
        expect(seq.Value).toHaveLength(1);
        expect(seq.Value[0]["00080100"].Value).toEqual(["121327"]);
        expect(seq.Value[0]["00080104"].Value).toEqual([
            "JANE DOE SYNTHETIC DERIVATION ENTRY"
        ]);
        expect(dict["00100010"].Value[0].Alphabetic).toBe("DOE^JANE");
    });

    it("buffered fromPart10 emits it as sequence events (no bare TypeError)", async () => {
        const listener = new CollectorListener();
        await fromPart10(toArrayBuffer(file), listener);
        const seq = listener.result.dict["00089215"];
        expect(seq.vr).toBe("SQ");
        expect(seq.Value).toHaveLength(1);
        expect(seq.Value[0]["00080100"].Value).toEqual(["121327"]);
        expect(seq.Value[0]["00080104"].Value).toEqual([
            "JANE DOE SYNTHETIC DERIVATION ENTRY"
        ]);
        // The rest of the dataset survives the sequence.
        expect(listener.result.dict["00100010"].Value[0].Alphabetic).toBe(
            "DOE^JANE"
        );
        expect(listener.result.dict["00100020"].Value).toEqual(["JD000001"]);
    });

    it("streamed fromPart10Stream agrees with the buffered tree", async () => {
        const buffered = new CollectorListener();
        await fromPart10(toArrayBuffer(file), buffered);
        const streamed = new CollectorListener();
        await fromPart10Stream(chunked(file, 64), streamed);
        const seqA = buffered.result.dict["00089215"];
        const seqB = streamed.result.dict["00089215"];
        expect(seqB.vr).toBe(seqA.vr);
        expect(JSON.parse(JSON.stringify(seqB.Value))).toEqual(
            JSON.parse(JSON.stringify(seqA.Value))
        );
    });
});
