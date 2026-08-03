// packages/cli/src/io.mjs
//
// Shared file/byte helpers for the dcmjs CLI. Pure functions plus thin fs
// wrappers; commands stay testable by injecting stdout/stderr and asserting
// on return values.

import fs from "node:fs";
import path from "node:path";

/**
 * Node Buffer (possibly a view into the shared read pool) → exact
 * ArrayBuffer. Never use a bare `.buffer` — pooled reads would hand the
 * parser unrelated bytes before/after the file content.
 */
export function toArrayBuffer(buffer) {
    return buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength
    );
}

/** Read a file as an exact ArrayBuffer. */
export function readFileArrayBuffer(filePath) {
    return toArrayBuffer(fs.readFileSync(filePath));
}

/**
 * Sniff what a file is: "dicom" (DICM magic at offset 128), "pdf"
 * (%PDF- at offset 0), or "unknown". Extension is the tiebreaker when the
 * magic checks cannot be read (short files).
 */
export function sniffKind(filePath) {
    let fd;
    try {
        fd = fs.openSync(filePath, "r");
        const dicm = Buffer.alloc(4);
        if (fs.readSync(fd, dicm, 0, 4, 128) === 4 && dicm.toString("ascii") === "DICM") {
            return "dicom";
        }
        const pdf = Buffer.alloc(5);
        if (fs.readSync(fd, pdf, 0, 5, 0) === 5 && pdf.toString("ascii") === "%PDF-") {
            return "pdf";
        }
    } catch (err) {
        // fall through to extension check
    } finally {
        if (fd !== undefined) {
            fs.closeSync(fd);
        }
    }
    if (/\.(dcm|dicom|lei)$/i.test(filePath)) {
        return "dicom";
    }
    if (/\.pdf$/i.test(filePath)) {
        return "pdf";
    }
    return "unknown";
}

/**
 * JSON.stringify replacer that makes binary values visible.
 * JSON.stringify(ArrayBuffer) silently yields {} — never acceptable output.
 * mode "base64": inline base64 strings (machine-readable output).
 * mode "summary": "[binary N bytes]" placeholders (human-readable dump).
 */
export function binaryReplacer(mode) {
    return function (key, value) {
        let bytes = null;
        if (value instanceof ArrayBuffer) {
            bytes = new Uint8Array(value);
        } else if (ArrayBuffer.isView(value)) {
            bytes = new Uint8Array(
                value.buffer,
                value.byteOffset,
                value.byteLength
            );
        }
        if (bytes === null) {
            return value;
        }
        if (mode === "base64") {
            return Buffer.from(bytes).toString("base64");
        }
        return `[binary ${bytes.byteLength} bytes]`;
    };
}

/**
 * Deliver command output. Strings go to the output file or stdout; binary
 * (Buffer/Uint8Array) REQUIRES an output path — never binary to stdout.
 * @returns {string|null} the path written, or null when printed
 */
export function writeOutput({ output, data, stdout }) {
    const isBinary = Buffer.isBuffer(data) || ArrayBuffer.isView(data);
    if (isBinary) {
        if (!output) {
            throw new Error(
                "refusing to write binary output to stdout; use -o <file>"
            );
        }
        fs.writeFileSync(output, data);
        return output;
    }
    if (output) {
        fs.writeFileSync(output, data);
        return output;
    }
    stdout(data);
    return null;
}

/**
 * Recursively collect DICOM files from files/directories.
 * Slim sibling of the discovery in scripts/corpus-runner.mjs (kept
 * self-contained there on purpose — see its header).
 */
export function discoverDicomFiles(target, found = []) {
    const stat = fs.statSync(target);
    if (stat.isDirectory()) {
        for (const entry of fs.readdirSync(target).sort()) {
            if (entry === "node_modules" || entry.startsWith(".")) {
                continue;
            }
            discoverDicomFiles(path.join(target, entry), found);
        }
    } else if (stat.isFile() && sniffKind(target) === "dicom") {
        found.push(target);
    }
    return found;
}
