// packages/cli/src/commands/dump.mjs
//
// dcmjs dump <file.dcm> [--raw]
// Default: naturalized dataset as pretty JSON with binary summarized.
// --raw:   "(GGGG,EEEE) VR Keyword: value" lines, meta group first.

import { readFileArrayBuffer, binaryReplacer } from "../io.mjs";

export const dumpUsage = `usage: dcmjs dump <file.dcm> [--raw]

Print a DICOM file's dataset to stdout.

    --raw    tag/VR lines instead of naturalized JSON
`;

function formatValue(element) {
    const value = element.Value;
    if (value === undefined || value === null) {
        return "";
    }
    if (Array.isArray(value)) {
        const parts = value.map(item => {
            if (item instanceof ArrayBuffer || ArrayBuffer.isView(item)) {
                return `[${element.vr} ${item.byteLength} bytes]`;
            }
            if (item && typeof item === "object" && "Alphabetic" in item) {
                return item.Alphabetic;
            }
            if (item && typeof item === "object") {
                return "<item>";
            }
            return String(item);
        });
        return parts.join("\\");
    }
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
        return `[${element.vr} ${value.byteLength} bytes]`;
    }
    return String(value);
}

function dumpGroup(group, { dictionary, stdout, indent = "" }) {
    for (const tag of Object.keys(group).sort()) {
        const element = group[tag];
        const punctuated = `(${tag.substring(0, 4)},${tag.substring(4, 8)})`;
        const entry = dictionary[punctuated];
        const keyword = entry ? entry.name : "Unknown";
        if (element.vr === "SQ" && Array.isArray(element.Value)) {
            stdout(
                `${indent}${punctuated} SQ ${keyword}: ${element.Value.length} item(s)`
            );
            element.Value.forEach(item => {
                dumpGroup(item, {
                    dictionary,
                    stdout,
                    indent: indent + "    "
                });
            });
        } else {
            stdout(
                `${indent}${punctuated} ${element.vr} ${keyword}: ${formatValue(
                    element
                )}`
            );
        }
    }
}

export async function runDump({ dcmjs, positionals, values, stdout, stderr }) {
    const [input] = positionals;
    if (!input) {
        stderr(dumpUsage);
        return 1;
    }

    try {
        const { DicomMessage, DicomMetaDictionary } = dcmjs.data;
        const dicomDict = DicomMessage.readFile(readFileArrayBuffer(input));

        if (values.raw) {
            const dictionary = DicomMetaDictionary.dictionary;
            dumpGroup(dicomDict.meta, { dictionary, stdout });
            dumpGroup(dicomDict.dict, { dictionary, stdout });
        } else {
            const dataset = DicomMetaDictionary.naturalizeDataset(
                dicomDict.dict
            );
            stdout(JSON.stringify(dataset, binaryReplacer("summary"), 4));
        }
        return 0;
    } catch (err) {
        stderr(`dump: ${err.message}`);
        return 1;
    }
}
