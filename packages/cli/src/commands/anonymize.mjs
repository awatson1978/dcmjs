// packages/cli/src/commands/anonymize.mjs
//
// dcmjs anonymize <file.dcm> [-o out.dcm]
// anonymizer.cleanTags() over the parsed dict, written back to Part 10.
// Default output is <basename>-anon.dcm beside the input; overwriting the
// input in place is refused.

import path from "node:path";
import { readFileArrayBuffer, writeOutput } from "../io.mjs";

export const anonymizeUsage = `usage: dcmjs anonymize <file.dcm> [options]

Strip PHI tags (dcmjs anonymizer defaults) and write a scrubbed copy.

    -o, --output <file>    output path (default: <input>-anon.dcm)
`;

export async function runAnonymize({
    dcmjs,
    positionals,
    values,
    stdout,
    stderr
}) {
    const [input] = positionals;
    if (!input) {
        stderr(anonymizeUsage);
        return 1;
    }

    const parsed = path.parse(input);
    const output =
        values.output ||
        path.join(parsed.dir, `${parsed.name}-anon${parsed.ext || ".dcm"}`);

    if (path.resolve(output) === path.resolve(input)) {
        stderr("anonymize: refusing to overwrite the input file in place");
        return 1;
    }

    try {
        const { DicomMessage } = dcmjs.data;
        const dicomDict = DicomMessage.readFile(readFileArrayBuffer(input));
        dcmjs.anonymizer.cleanTags(dicomDict.dict);
        const written = writeOutput({
            output,
            data: Buffer.from(dicomDict.write()),
            stdout
        });
        stdout(`anonymize: wrote ${written}`);
        return 0;
    } catch (err) {
        stderr(`anonymize: ${err.message}`);
        return 1;
    }
}
