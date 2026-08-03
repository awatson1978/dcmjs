// packages/cli/src/commands/validate.mjs
//
// dcmjs validate <dir-or-file...> [--quiet] [--json <file>]
// Parse every discovered DICOM file through the classic read path and
// report per-file status. Exit 1 on any failure. The heavier three-path
// divergence harness lives in scripts/corpus-runner.mjs.

import fs from "node:fs";
import path from "node:path";
import { readFileArrayBuffer, discoverDicomFiles } from "../io.mjs";

export const validateUsage = `usage: dcmjs validate <dir-or-file...> [options]

Parse DICOM files and report failures.

    --quiet          only print failures and the summary
    --json <file>    write the full report as JSON
`;

export async function runValidate({
    dcmjs,
    positionals,
    values,
    stdout,
    stderr
}) {
    if (positionals.length === 0) {
        stderr("validate: no input files or directories given");
        stderr(validateUsage);
        return 1;
    }

    const { DicomMessage } = dcmjs.data;
    const files = [];
    try {
        for (const target of positionals) {
            discoverDicomFiles(target, files);
        }
    } catch (err) {
        stderr(`validate: ${err.message}`);
        return 1;
    }

    if (files.length === 0) {
        stderr("validate: no DICOM files found");
        return 1;
    }

    const records = [];
    let failures = 0;
    for (const file of files) {
        const relPath = path.relative(process.cwd(), file) || file;
        let record;
        const startedAt = Date.now();
        try {
            const arrayBuffer = readFileArrayBuffer(file);
            DicomMessage.readFile(arrayBuffer);
            record = {
                file: relPath,
                status: "ok",
                bytes: arrayBuffer.byteLength,
                ms: Date.now() - startedAt
            };
        } catch (err) {
            failures += 1;
            record = {
                file: relPath,
                status: "fail",
                error: err.message || String(err),
                ms: Date.now() - startedAt
            };
        }
        records.push(record);

        if (record.status === "fail") {
            stdout(`FAIL  ${record.ms}ms  ${relPath}  (${record.error})`);
        } else if (!values.quiet) {
            stdout(`ok    ${record.bytes}B  ${record.ms}ms  ${relPath}`);
        }
    }

    stdout(
        `${records.length - failures}/${
            records.length
        } clean, ${failures} failed`
    );

    if (values.json) {
        fs.writeFileSync(values.json, JSON.stringify(records, null, 4));
    }

    return failures > 0 ? 1 : 0;
}
