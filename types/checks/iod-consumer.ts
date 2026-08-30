// tsc gate for the generated IOD dataset types (Workstream D). Compiled by
// `npm run check:types`; never bundled. Positive cases must compile; the
// ts-expect-error lines must fail.
import type {
    CtImageDataset,
    SopClassDatasetMap,
    SopClassUid,
    DicomDataset,
    ValidationIssue
} from "../dcmjs-iods";
import { asIod, IodValidationError } from "../dcmjs-iods";

// Positive: a CT dataset literal with the required keys compiles — Type 1
// keys need real values (NonNullable), Type 2 keys must be present but may
// be undefined (present-but-empty is conformant).
const ct: CtImageDataset = {
    SOPClassUID: "1.2.840.10008.5.1.4.1.1.2",
    SOPInstanceUID: "1.2.826.0.1.3680043.8.498.1",
    StudyInstanceUID: "1.2.826.0.1.3680043.8.498.2",
    SeriesInstanceUID: "1.2.826.0.1.3680043.8.498.3",
    FrameOfReferenceUID: "1.2.826.0.1.3680043.8.498.4",
    Modality: "CT",
    ImageType: ["ORIGINAL", "PRIMARY", "AXIAL"],
    SamplesPerPixel: 1,
    PhotometricInterpretation: "MONOCHROME2",
    Rows: 512,
    Columns: 512,
    BitsAllocated: 16,
    BitsStored: 12,
    HighBit: 11,
    PixelRepresentation: 0,
    RescaleIntercept: -1024,
    RescaleSlope: 1,
    ImagePositionPatient: [0, 0, 0],
    ImageOrientationPatient: [1, 0, 0, 0, 1, 0],
    PixelSpacing: [0.5, 0.5],
    // Type 2 — required keys, empty values allowed:
    KVP: undefined,
    AcquisitionNumber: undefined,
    PositionReferenceIndicator: undefined,
    Manufacturer: undefined,
    InstanceNumber: undefined,
    SeriesNumber: undefined,
    StudyDate: undefined,
    StudyTime: undefined,
    AccessionNumber: undefined,
    ReferringPhysicianName: undefined,
    StudyID: undefined,
    SliceThickness: undefined,
    PatientName: undefined,
    PatientID: undefined,
    PatientBirthDate: undefined,
    PatientSex: undefined
};

// Type 1 keys are non-nullable after narrowing (no `| undefined`).
const rows: number = ct.Rows;
const seriesUid: string = ct.SeriesInstanceUID;
// Inherited optional keys stay optional.
const kvp: number | undefined = ct.KVP;
const comments: string | undefined = ct.ImageComments;

// The UID-literal lookup is usable.
type CtViaMap = DicomDataset<"1.2.840.10008.5.1.4.1.1.2">;
const ctViaMap: CtViaMap = ct;
const uidLiteral: "1.2.840.10008.5.1.4.1.1.2" = ctViaMap.SOPClassUID;
const anyUid: SopClassUid = "1.2.840.10008.5.1.4.1.1.4";
const mrViaMap: SopClassDatasetMap["1.2.840.10008.5.1.4.1.1.4"] | null = null;

// asIod is typed to resolve to the mapped dataset type.
const promised: Promise<CtImageDataset> = asIod(
    {},
    "1.2.840.10008.5.1.4.1.1.2"
);
const err: IodValidationError = new IodValidationError();
const issues: ValidationIssue[] = err.issues;

// Negative cases — these MUST be type errors:
const { Rows: _omitted, ...ctWithoutRows } = ct;
// @ts-expect-error Rows is required (Type 1 of image-pixel, usage M)
const missingRows: CtImageDataset = ctWithoutRows;
// @ts-expect-error SOPClassUID is narrowed to the CT Image Storage UID
const wrongUid: CtImageDataset = { ...ct, SOPClassUID: "1.2.840.10008.5.1.4.1.1.4" };
// @ts-expect-error Type 1 keys reject undefined
const emptyType1: CtImageDataset = { ...ct, Rows: undefined };
// @ts-expect-error bogus SOP Class UID is not a map key
type Bogus = SopClassDatasetMap["1.2.3.4"];
// @ts-expect-error DicomDataset only accepts catalog UID literals
type BogusLookup = DicomDataset<"1.2.3.4">;

export {
    ct,
    rows,
    seriesUid,
    kvp,
    comments,
    ctViaMap,
    uidLiteral,
    anyUid,
    mrViaMap,
    promised,
    issues,
    missingRows,
    wrongUid,
    emptyType1
};
