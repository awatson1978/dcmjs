import fs from "fs";
import path from "path";
import dcmjs from "../../src/index.js";
import { fromPart10 } from "../../src/eventStream/fromPart10";
import { CollectorListener } from "../../src/eventStream/CollectorListener";
import { deepCompare } from "../helper/equivalence.js";

const { DicomDict, DicomMessage } = dcmjs.data;

/** Build an in-memory Part 10 buffer from a meta + dict pair. */
function buildPart10(meta, dict) {
    const dd = new DicomDict(meta);
    dd.dict = dict;
    return dd.write();
}

/** SQ-aware vr+Value comparison (ignores _rawValue; raw retention is slice D). */
function compareTrees(source, rebuilt, exempt = new Set()) {
    const problems = [];
    // Group-length elements (gggg,0000) are loss-preservingly emitted by the
    // event stream but stripped by readFile (§33), so exempt them from the gate.
    const isGroupLength = tag => tag.slice(4) === "0000";
    const section = (src, dst, where) => {
        const sTags = Object.keys(src).filter(t => !isGroupLength(t)).sort();
        const dTags = Object.keys(dst).filter(t => !isGroupLength(t)).sort();
        if (sTags.join(",") !== dTags.join(",")) {
            problems.push(`${where}: tags [${sTags}] vs [${dTags}]`);
            return;
        }
        for (const tag of sTags) {
            if (exempt.has(tag)) continue;
            deepCompare(src[tag].vr, dst[tag].vr, `${where}.${tag}.vr`, problems);
            deepCompare(
                src[tag].Value,
                dst[tag].Value,
                `${where}.${tag}.Value`,
                problems
            );
        }
    };
    section(source.meta || {}, rebuilt.meta || {}, "meta");
    section(source.dict || {}, rebuilt.dict || {}, "dict");
    return problems;
}

describe("fromPart10 — explicit little endian scalars", () => {
    const meta = {
        "00020010": { vr: "UI", Value: ["1.2.840.10008.1.2.1"] },
        "00020002": { vr: "UI", Value: ["1.2.840.10008.5.1.4.1.1.7"] },
        "00020003": { vr: "UI", Value: ["1.2.3.4.5.6.7.8.9"] }
    };
    const dict = {
        "00080060": { vr: "CS", Value: ["CT"] },
        "00100010": { vr: "PN", Value: ["Wallace^Bill"] },
        "00100020": { vr: "LO", Value: ["12345"] },
        "00200013": { vr: "IS", Value: [12] },
        "00080008": { vr: "CS", Value: ["ORIGINAL", "PRIMARY"] }
    };

    test("round-trips from raw bytes equivalently to readFile", async () => {
        const buffer = buildPart10(meta, dict);
        const source = DicomMessage.readFile(buffer.slice(0));

        const listener = new CollectorListener();
        await fromPart10(buffer.slice(0), listener);

        const problems = compareTrees(source, listener.result);
        expect(problems).toEqual([]);
    });
});

// --- corpus gate: raw bytes -> events, equivalent to readFile ---------------

const REPO_ROOT = path.join(__dirname, "..", "..");
const PARSER_IMAGES_DIR = path.join(REPO_ROOT, "packages", "parser", "testImages");
const TEST_DIR = path.join(REPO_ROOT, "test");

function discoverFixtures(dir, accept) {
    const found = [];
    for (const name of fs.readdirSync(dir).sort()) {
        const full = path.join(dir, name);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) found.push(...discoverFixtures(full, accept));
        else if (stat.isFile() && accept(name)) found.push(full);
    }
    return found;
}

const FIXTURES = [
    ...discoverFixtures(PARSER_IMAGES_DIR, n => !n.toLowerCase().endsWith(".md")),
    ...discoverFixtures(TEST_DIR, n => /\.(dcm|dicom|lei)$/i.test(n))
].map(full => [path.relative(REPO_ROOT, full), full]);

function readBuffer(full) {
    const data = fs.readFileSync(full);
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
}

const EXEMPT = new Set(["00080005"]); // readFile rewrites SpecificCharacterSet
const isGroupLength = tag => tag.slice(4) === "0000";

function isBinaryValue(values) {
    return (
        Array.isArray(values) &&
        values.some(v => v instanceof ArrayBuffer || ArrayBuffer.isView(v))
    );
}

function concatBytes(values) {
    const parts = values.map(v =>
        v instanceof ArrayBuffer
            ? new Uint8Array(v)
            : new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
    );
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
        out.set(p, off);
        off += p.length;
    }
    return out;
}

function isItemDict(v) {
    return (
        v &&
        typeof v === "object" &&
        !Array.isArray(v) &&
        !(v instanceof ArrayBuffer) &&
        !ArrayBuffer.isView(v) &&
        v.vr === undefined &&
        v.BulkDataURI === undefined
    );
}

function compareSection(src, dst, where, problems) {
    const sTags = Object.keys(src).filter(t => !isGroupLength(t)).sort();
    const dTags = Object.keys(dst).filter(t => !isGroupLength(t)).sort();
    if (sTags.join(",") !== dTags.join(",")) {
        problems.push(`${where}: tags [${sTags}] vs [${dTags}]`);
        return;
    }
    for (const tag of sTags) {
        if (EXEMPT.has(tag)) continue;
        compareEntry(src[tag], dst[tag], `${where}.${tag}`, problems);
    }
}

function compareEntry(a, b, where, problems) {
    deepCompare(a.vr, b.vr, `${where}.vr`, problems);
    const av = a.Value || [];
    const bv = b.Value || [];
    if (isBinaryValue(av) || isBinaryValue(bv)) {
        const ab = concatBytes(av);
        const bb = concatBytes(bv);
        if (ab.length !== bb.length) {
            problems.push(`${where}.Value: binary length ${ab.length} !== ${bb.length}`);
            return;
        }
        for (let i = 0; i < ab.length; i++) {
            if (ab[i] !== bb[i]) {
                problems.push(`${where}.Value: binary bytes differ at ${i}`);
                return;
            }
        }
        return;
    }
    if (av.some(isItemDict)) {
        if (av.length !== bv.length) {
            problems.push(`${where}.Value: items ${av.length} !== ${bv.length}`);
            return;
        }
        for (let i = 0; i < av.length; i++) {
            compareSection(av[i], bv[i], `${where}.Value[${i}]`, problems);
        }
        return;
    }
    deepCompare(av, bv, `${where}.Value`, problems);
}

describe("fromPart10 — corpus round-trip equivalence (raw bytes -> events)", () => {
    test.each(FIXTURES)("%s", async (_rel, full) => {
        let source;
        try {
            source = DicomMessage.readFile(readBuffer(full));
        } catch {
            return; // fixtures both cores reject
        }
        const listener = new CollectorListener();
        await fromPart10(readBuffer(full), listener);

        const problems = [];
        compareSection(source.meta || {}, listener.result.meta || {}, "meta", problems);
        compareSection(source.dict || {}, listener.result.dict || {}, "dict", problems);
        expect(problems).toEqual([]);
    });
});
