import { getZippedTestDataset } from "./testUtils.js";
import { createSampleDicom } from "./helper/sampleDicomPart10.js";
import dcmjs from "../src/index.js";
import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";

const { DicomMetaDictionary, DicomMessage } = dcmjs.data;

const expectedPatientNames = {
    SCSARAB: "قباني^لنزار",
    SCSFREN: "Buc^Jérôme",
    SCSGERM: "Äneas^Rüdiger",
    SCSGREEK: "Διονυσιος",
    SCSHBRW: "שרון^דבורה",
    SCSRUSS: "Люкceмбypг",
    SCSX1: "Wang^XiaoDong=王^小東", // Trailing "=" gets stripped, as is permitted by the spec
    SCSX2: "Wang^XiaoDong=王^小东" // idem
    // These are not yet supported, because they use multiple encodings, which would require a more complex parser...
    //"SCSH31": "X",
    //"SCSH32": "X",
    //"SCSI2": "X",
};

it("test_encodings", async () => {
    const url =
        "https://github.com/dcmjs-org/data/releases/download/dclunie-charsets/dclunie-charsets.zip";
    const unzipPath = await getZippedTestDataset(
        url,
        "dclunie-charsets.zip",
        "dclunie-charsets"
    );
    const filesPath = unzipPath + "/charsettests";
    const fileNames = await fsPromises.readdir(filesPath);

    fileNames.forEach(fileName => {
        if (fileName in expectedPatientNames) {
            const arrayBuffer = fs.readFileSync(
                path.join(filesPath, fileName)
            ).buffer;
            const dicomDict = DicomMessage.readFile(arrayBuffer);
            const dataset = DicomMetaDictionary.naturalizeDataset(
                dicomDict.dict
            );
            expect(String(dataset.PatientName)).toEqual(
                expectedPatientNames[fileName]
            );

            // write to memory and expect correctly loaded utf-8 DICOM
            const newDicomDict = DicomMessage.readFile(dicomDict.write());
            const newDataset = DicomMetaDictionary.naturalizeDataset(
                newDicomDict.dict
            );
            expect(String(newDataset.PatientName)).toEqual(
                expectedPatientNames[fileName]
            );
            expect(newDataset.SpecificCharacterSet).toEqual("ISO_IR 192");
        }
    });
});

it("test_nul_padded_character_set", () => {
    // Some older modalities illegally pad SpecificCharacterSet to even length
    // with a NUL byte instead of a space, e.g. "ISO 2022 IR 6\0".
    const buffer = createSampleDicom({
        dict: {
            "00080005": { vr: "CS", Value: ["ISO 2022 IR 6"] },
            "00100010": { vr: "PN", Value: ["Test^Padding"] }
        }
    });

    // The writer pads the odd-length value with a space; replace that padding
    // with a NUL byte to reproduce the non-conformant file.
    const bytes = new Uint8Array(buffer);
    const spacePadded = Array.from("ISO 2022 IR 6 ", c => c.charCodeAt(0));
    const offset = bytes.findIndex((_, i) =>
        spacePadded.every((b, j) => bytes[i + j] === b)
    );
    expect(offset).toBeGreaterThan(-1);
    bytes[offset + spacePadded.length - 1] = 0x00;

    const dicomDict = DicomMessage.readFile(buffer);
    const dataset = DicomMetaDictionary.naturalizeDataset(dicomDict.dict);
    expect(String(dataset.PatientName)).toEqual("Test^Padding");
    expect(dataset.SpecificCharacterSet).toEqual("ISO_IR 192");
});
