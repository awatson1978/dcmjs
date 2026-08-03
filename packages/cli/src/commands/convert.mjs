// packages/cli/src/commands/convert.mjs
//
// dcmjs convert <input> --to <format> [options]
//
// The PACS PDF workflow both ways plus JSON/FHIR conversions:
//   .dcm → json | dicomweb-json | fhir | dcm | pdf (extract encapsulated)
//   .pdf → dcm (Encapsulated PDF wrap) | fhir (DocumentReference)

import {
    readFileArrayBuffer,
    sniffKind,
    binaryReplacer,
    writeOutput
} from "../io.mjs";

export const convertUsage = `usage: dcmjs convert <input> --to <format> [options]

Formats (auto-detected input kind → supported targets):
    .dcm → fhir | dicomweb-json | json | dcm | pdf
    .pdf → dcm | fhir

Options:
    -t, --to <format>        target format (required)
    -o, --output <file>      output path (required for binary targets)
    --pretty                 pretty-print JSON output
    --bundle                 fhir: emit a collection Bundle
    --fhir-version <v>       R4 | R4B (default R4B)
    --patient-name <name>    pdf input: PatientName
    --patient-id <id>        pdf input: PatientID
    --title <title>          pdf input: DocumentTitle
    --study-uid <uid>        pdf input: attach to an existing StudyInstanceUID
    --series-uid <uid>       pdf input: SeriesInstanceUID
`;

function stringify(value, pretty) {
    return JSON.stringify(value, binaryReplacer("base64"), pretty ? 4 : 0);
}

function pdfOptionsFromValues(values) {
    const options = {};
    if (values["patient-name"]) {
        options.PatientName = values["patient-name"];
    }
    if (values["patient-id"]) {
        options.PatientID = values["patient-id"];
    }
    if (values.title) {
        options.DocumentTitle = values.title;
    }
    if (values["study-uid"]) {
        options.StudyInstanceUID = values["study-uid"];
    }
    if (values["series-uid"]) {
        options.SeriesInstanceUID = values["series-uid"];
    }
    return options;
}

async function convertDicom({ dcmjs, arrayBuffer, to, values }) {
    const { DicomMessage, DicomMetaDictionary } = dcmjs.data;
    const fhirVersion = values["fhir-version"] || "R4B";

    if (to === "json") {
        const dataset = DicomMetaDictionary.naturalizeDataset(
            DicomMessage.readFile(arrayBuffer).dict
        );
        return { text: stringify(dataset, values.pretty) };
    }

    if (to === "dicomweb-json") {
        const json = await dcmjs.eventStream.DicomEventStream.fromPart10(
            arrayBuffer
        ).toDicomWebJson();
        return { text: stringify(json, values.pretty) };
    }

    if (to === "fhir") {
        if (values.bundle) {
            const dataset = DicomMetaDictionary.naturalizeDataset(
                DicomMessage.readFile(arrayBuffer).dict
            );
            const bundle = dcmjs.fhir.toBundle([dataset], { fhirVersion });
            return { text: stringify(bundle, values.pretty) };
        }
        const resources = dcmjs.fhir.fromPart10(arrayBuffer, { fhirVersion });
        return { text: stringify(resources, values.pretty) };
    }

    if (to === "dcm") {
        const dicomDict = DicomMessage.readFile(arrayBuffer);
        return { binary: Buffer.from(dicomDict.write()) };
    }

    if (to === "pdf") {
        const dataset = DicomMetaDictionary.naturalizeDataset(
            DicomMessage.readFile(arrayBuffer).dict
        );
        const { bytes } = dcmjs.encapsulated.extractEncapsulatedPdf(dataset);
        return { binary: Buffer.from(bytes) };
    }

    throw new Error(`unsupported conversion: dicom → ${to}`);
}

async function convertPdf({ dcmjs, arrayBuffer, to, values }) {
    const fhirVersion = values["fhir-version"] || "R4B";
    const dataset = dcmjs.encapsulated.encapsulatePdf(
        arrayBuffer,
        pdfOptionsFromValues(values)
    );

    if (to === "dcm") {
        return { binary: dcmjs.data.datasetToBuffer(dataset) };
    }

    if (to === "fhir") {
        if (values.bundle) {
            const bundle = dcmjs.fhir.toBundle([dataset], { fhirVersion });
            return { text: stringify(bundle, values.pretty) };
        }
        const resources = dcmjs.fhir.toFhir(dataset, { fhirVersion });
        return { text: stringify(resources, values.pretty) };
    }

    throw new Error(`unsupported conversion: pdf → ${to}`);
}

export async function runConvert({
    dcmjs,
    positionals,
    values,
    stdout,
    stderr
}) {
    const [input] = positionals;
    const to = values.to;

    if (!input || !to) {
        stderr(
            !input
                ? "convert: missing input file"
                : "convert: missing --to <format>"
        );
        stderr(convertUsage);
        return 1;
    }

    try {
        const kind = sniffKind(input);
        if (kind === "unknown") {
            throw new Error(
                `cannot determine input kind of ${input} (not DICOM, not PDF)`
            );
        }

        const arrayBuffer = readFileArrayBuffer(input);
        const result =
            kind === "dicom"
                ? await convertDicom({ dcmjs, arrayBuffer, to, values })
                : await convertPdf({ dcmjs, arrayBuffer, to, values });

        const written = writeOutput({
            output: values.output,
            data: result.binary !== undefined ? result.binary : result.text,
            stdout
        });
        if (written && result.binary !== undefined) {
            stderr(`convert: wrote ${written}`);
        }
        return 0;
    } catch (err) {
        stderr(`convert: ${err.message}`);
        return 1;
    }
}
