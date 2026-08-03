// packages/cli/src/cli.mjs
//
// Command router for the dcmjs CLI. Parsing is node:util parseArgs
// (built into Node >= 18.3 — zero dependencies, matching the repo's
// no-arg-parsing-deps philosophy; see scripts/corpus-runner.mjs).
// Commands receive an injected `dcmjs` so bin/ can pass the built bundle
// while tests pass src/index.js directly.

import { parseArgs } from "node:util";
import { runConvert, convertUsage } from "./commands/convert.mjs";
import { runDump, dumpUsage } from "./commands/dump.mjs";
import { runAnonymize, anonymizeUsage } from "./commands/anonymize.mjs";
import { runValidate, validateUsage } from "./commands/validate.mjs";

export const usage = `usage: dcmjs <command> [options]

Commands:
    convert     convert between DICOM, PDF, FHIR, and JSON representations
    dump        print a DICOM file's dataset
    anonymize   strip PHI tags and write a scrubbed copy
    validate    parse files/directories and report failures

Run 'dcmjs <command> --help' for command options.
`;

const COMMANDS = {
    convert: {
        run: runConvert,
        usage: convertUsage,
        options: {
            to: { type: "string", short: "t" },
            output: { type: "string", short: "o" },
            pretty: { type: "boolean", default: false },
            bundle: { type: "boolean", default: false },
            "fhir-version": { type: "string" },
            "patient-name": { type: "string" },
            "patient-id": { type: "string" },
            title: { type: "string" },
            "study-uid": { type: "string" },
            "series-uid": { type: "string" },
            help: { type: "boolean", short: "h", default: false }
        }
    },
    dump: {
        run: runDump,
        usage: dumpUsage,
        options: {
            raw: { type: "boolean", default: false },
            help: { type: "boolean", short: "h", default: false }
        }
    },
    anonymize: {
        run: runAnonymize,
        usage: anonymizeUsage,
        options: {
            output: { type: "string", short: "o" },
            help: { type: "boolean", short: "h", default: false }
        }
    },
    validate: {
        run: runValidate,
        usage: validateUsage,
        options: {
            quiet: { type: "boolean", default: false },
            json: { type: "string" },
            help: { type: "boolean", short: "h", default: false }
        }
    }
};

export async function runCli({ dcmjs, argv, stdout, stderr }) {
    const [command, ...rest] = argv;

    if (!command || command === "--help" || command === "-h") {
        if (command) {
            stdout(usage);
            return 0;
        }
        stderr(usage);
        return 1;
    }

    const spec = COMMANDS[command];
    if (!spec) {
        stderr(`dcmjs: unknown command "${command}"`);
        stderr(usage);
        return 1;
    }

    let parsed;
    try {
        parsed = parseArgs({
            args: rest,
            options: spec.options,
            strict: true,
            allowPositionals: true
        });
    } catch (err) {
        stderr(`dcmjs ${command}: ${err.message}`);
        stderr(spec.usage);
        return 1;
    }

    if (parsed.values.help) {
        stdout(spec.usage);
        return 0;
    }

    return spec.run({
        dcmjs,
        positionals: parsed.positionals,
        values: parsed.values,
        stdout,
        stderr
    });
}
