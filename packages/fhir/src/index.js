// packages/fhir/src/index.js
//
// @dcmjs/fhir — the FHIR sink. Turns naturalized DICOM Part 10 datasets
// (DicomMetaDictionary.naturalizeDataset output) into FHIR R4B resources.
//
// Deliberately simple: standard FHIR out, nothing deployment-specific.
// Consumers assign resource ids, storage references, and meta.tags.
//
//   const { patient, imagingStudy } = toFhir(dataset);
//   const bundle = toBundle([dataset1, dataset2]);

import { patientFromDataset } from "./patient.js";
import {
    imagingStudyFromDataset,
    imagingStudyFromDatasets
} from "./imagingStudy.js";
import { assertSupportedFhirVersion } from "./helpers.js";

export * from "./helpers.js";
export { patientFromDataset } from "./patient.js";
export { imagingStudyFromDataset, imagingStudyFromDatasets } from "./imagingStudy.js";

/**
 * Map one naturalized dataset to its FHIR resources.
 * @param {Object} dataset - DicomMetaDictionary.naturalizeDataset output
 * @param {Object} [options]
 * @param {string} [options.fhirVersion='R4B'] - R4/R4B only; throws otherwise
 * @param {Object} [options.subject] - FHIR Reference for ImagingStudy.subject
 * @returns {{ patient: Object|null, imagingStudy: Object|null }}
 */
export function toFhir(dataset, options = {}) {
    assertSupportedFhirVersion(options);
    return {
        patient: patientFromDataset(dataset),
        imagingStudy: imagingStudyFromDataset(dataset, options)
    };
}

/**
 * Map one or more datasets (one study's worth of instances) to a FHIR
 * collection Bundle: at most one Patient (from the first dataset carrying
 * a patient module) and one aggregated ImagingStudy.
 * @param {Object[]} datasets - naturalized datasets
 * @param {Object} [options] - as toFhir
 * @returns {Object} FHIR Bundle (type: collection)
 */
export function toBundle(datasets, options = {}) {
    assertSupportedFhirVersion(options);

    const list = (datasets || []).filter(Boolean);
    const entries = [];

    let patient = null;
    for (const dataset of list) {
        patient = patientFromDataset(dataset);
        if (patient) {
            break;
        }
    }
    if (patient) {
        entries.push({ resource: patient });
    }

    const imagingStudy = imagingStudyFromDatasets(list, options);
    if (imagingStudy) {
        entries.push({ resource: imagingStudy });
    }

    return {
        resourceType: "Bundle",
        type: "collection",
        total: entries.length,
        entry: entries
    };
}
