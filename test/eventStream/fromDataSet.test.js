import { fromDataSet } from "../../src/eventStream/fromDataSet";
import { CollectorListener } from "../../src/eventStream/CollectorListener";
import { EventStreamListener } from "../../src/eventStream/EventStreamListener";
import { deepCompare } from "../helper/equivalence";

/** A listener that records the vocabulary calls it receives, in order. */
function recordingListener() {
    const calls = [];
    // Each filter is an object exposing one vocabulary method as
    // `method(next, ...args)` — the established filter shape.
    const record = name => ({
        [name](next, ...args) {
            calls.push([name, ...args]);
            return next(...args);
        }
    });
    const listener = new EventStreamListener(
        record("startDataSet"),
        record("endDataSet"),
        record("startFileMetaInformation"),
        record("endFileMetaInformation"),
        record("startElement"),
        record("endElement"),
        record("startSequence"),
        record("endSequence"),
        record("startItem"),
        record("endItem"),
        record("value"),
        record("startBinary"),
        record("binaryFragment"),
        record("endBinary"),
        record("bulkDataReference")
    );
    listener.calls = calls;
    return listener;
}

const binBuf = new Uint8Array([9, 8, 7]).buffer;

const sampleDataset = {
    meta: { "00020010": { vr: "UI", Value: ["1.2.840.10008.1.2.1"] } },
    dict: {
        "00100010": { vr: "PN", Value: ["Wallace^Bill"] },
        "00080008": { vr: "CS", Value: ["ORIGINAL", "PRIMARY"] },
        "00081110": {
            vr: "SQ",
            Value: [{ "00081150": { vr: "UI", Value: ["1.2.3"] } }]
        },
        "7FE00010": { vr: "OB", Value: [binBuf] }
    }
};

describe("fromDataSet generator", () => {
    test("emits the contract vocabulary in source order", async () => {
        const listener = recordingListener();
        await fromDataSet(sampleDataset, listener);

        // Compare just the call names to keep the assertion readable.
        const names = listener.calls.map(c => c[0]);
        expect(names).toEqual([
            "startDataSet",
            "startFileMetaInformation",
            "startElement", // 00020010
            "value",
            "endElement",
            "endFileMetaInformation",
            "startElement", // 00100010
            "value",
            "endElement",
            "startElement", // 00080008 (two values)
            "value",
            "value",
            "endElement",
            "startSequence", // 00081110
            "startItem",
            "startElement", // 00081150
            "value",
            "endElement",
            "endItem",
            "endSequence",
            "startElement", // 7FE00010 binary
            "startBinary",
            "binaryFragment",
            "endBinary",
            "endElement",
            "endDataSet"
        ]);
    });

    test("passes tag, vr and value payloads through", async () => {
        const listener = recordingListener();
        await fromDataSet(sampleDataset, listener);
        const byName = name => listener.calls.filter(c => c[0] === name);

        expect(byName("startElement")[0]).toEqual([
            "startElement",
            "00020010",
            expect.objectContaining({ vr: "UI" })
        ]);
        expect(byName("startSequence")[0]).toEqual([
            "startSequence",
            "00081110",
            expect.objectContaining({ vr: "SQ" })
        ]);
        expect(byName("value").map(c => c[1])).toEqual([
            "1.2.840.10008.1.2.1",
            "Wallace^Bill",
            "ORIGINAL",
            "PRIMARY",
            "1.2.3"
        ]);
        expect(byName("binaryFragment")[0][1]).toBe(binBuf);
    });

    test("round-trips through CollectorListener (vr + Value preserved)", async () => {
        const listener = new CollectorListener();
        await fromDataSet(sampleDataset, listener);

        const problems = [];
        for (const section of ["meta", "dict"]) {
            for (const tag of Object.keys(sampleDataset[section])) {
                deepCompare(
                    sampleDataset[section][tag].vr,
                    listener.result[section][tag].vr,
                    `${section}.${tag}.vr`,
                    problems
                );
                deepCompare(
                    sampleDataset[section][tag].Value,
                    listener.result[section][tag].Value,
                    `${section}.${tag}.Value`,
                    problems
                );
            }
        }
        expect(problems).toEqual([]);
    });

    test("emits bulkDataReference for {BulkDataURI} values", async () => {
        const listener = recordingListener();
        await fromDataSet(
            { dict: { "7FE00010": { vr: "OB", Value: [{ BulkDataURI: "../b/1" }] } } },
            listener
        );
        const ref = listener.calls.find(c => c[0] === "bulkDataReference");
        expect(ref[1]).toEqual({ uri: "../b/1" });
    });

    test("awaits backpressure at top-level element boundaries", async () => {
        const listener = new CollectorListener();
        const order = [];
        let release;
        listener.setDrain(
            () =>
                new Promise(resolve => {
                    order.push("drain-requested");
                    release = () => {
                        order.push("drain-released");
                        resolve();
                    };
                    // release on next microtask so suspension is observable
                    Promise.resolve().then(() => release());
                })
        );
        await fromDataSet(sampleDataset, listener);
        expect(order).toContain("drain-requested");
        expect(order).toContain("drain-released");
    });
});
