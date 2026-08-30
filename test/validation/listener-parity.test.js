/**
 * Streamed-vs-eager parity gate: the streaming ValidationListener (driven by
 * fromPart10Stream in network-sized chunks) and the eager validate() (over
 * the classic DicomMessage.readFile dict) must produce identical issue
 * multisets over the fixture corpus.
 *
 * Note: the eager reader rewrites (0008,0005) to ISO_IR 192 and does not
 * retain (0002,0000), so this gate additionally proves those path
 * differences do not surface as issue divergence on real files.
 */

import "../../src/index.js"; // side effect: DicomMessage/VR/Tag class wiring
import fs from "fs";
import path from "path";
import { validate, ValidationListener } from "../../src/validation/index.js";
import { fromPart10Stream } from "../../src/eventStream/fromPart10Stream.js";
import { DicomMessage } from "../../src/DicomMessage.js";

const FIXTURES = [
    "sample-dicom.dcm",
    "cine-test.dcm",
    "sample-op.dcm",
    "sample-sr.dcm",
    "invalid-vr-length-test.dcm",
    "no-meta-length-test.dcm"
];

function readArrayBuffer(name) {
    const data = fs.readFileSync(path.join(__dirname, "..", name));
    return data.buffer.slice(
        data.byteOffset,
        data.byteOffset + data.byteLength
    );
}

async function* chunked(arrayBuffer, size) {
    const bytes = new Uint8Array(arrayBuffer);
    for (let offset = 0; offset < bytes.byteLength; offset += size) {
        yield bytes.subarray(offset, Math.min(offset + size, bytes.byteLength));
    }
}

/** Multiset key: everything that identifies an issue, minus prose. */
function issueMultiset(result) {
    return result.issues
        .map(issue =>
            [
                issue.rule,
                issue.severity,
                issue.tag || "",
                issue.path || "",
                issue.keyword || ""
            ].join("|")
        )
        .sort();
}

describe("validation parity — streamed ValidationListener vs eager validate()", () => {
    test.each(FIXTURES)("identical issue multisets for %s", async name => {
        const arrayBuffer = readArrayBuffer(name);

        const dicomDict = DicomMessage.readFile(arrayBuffer, {
            ignoreErrors: true
        });
        const eager = await validate(dicomDict);

        const listener = new ValidationListener();
        await fromPart10Stream(chunked(arrayBuffer, 4096), listener, {
            ignoreErrors: true
        });
        const streamed = listener.finish();

        expect(issueMultiset(streamed)).toEqual(issueMultiset(eager));
        expect(streamed.summary.sopClassUid).toEqual(eager.summary.sopClassUid);
        expect(streamed.summary.iod).toEqual(eager.summary.iod);
        expect(streamed.ok).toBe(eager.ok);
    });

    test("streamed listener resolves the CIOD seam for sample-dicom.dcm", async () => {
        const listener = new ValidationListener();
        await fromPart10Stream(
            chunked(readArrayBuffer("sample-dicom.dcm"), 4096),
            listener,
            { ignoreErrors: true }
        );
        const result = listener.finish();
        expect(result.summary.sopClassUid).toBe("1.2.840.10008.5.1.4.1.1.4");
        expect(result.summary.iod).toBe("mr-image");
        expect(result.summary.layersRun).toEqual([1, 2]);
    });

    test("finish() is idempotent and collector retains no values", async () => {
        const listener = new ValidationListener();
        await fromPart10Stream(
            chunked(readArrayBuffer("sample-dicom.dcm"), 4096),
            listener,
            { ignoreErrors: true }
        );
        const first = listener.finish();
        expect(listener.finish()).toBe(first);
        // Collector holds presence booleans only (no element values).
        for (const entry of listener.collector.paths.values()) {
            expect(Object.keys(entry).sort()).toEqual(["nonEmpty", "present"]);
        }
        expect(listener.collector.paths.size).toBeGreaterThan(10);
    });
});
