import { EventStreamListener } from "./EventStreamListener.js";

/**
 * DicomWebJsonWriter — slice E1: an event-stream consumer that writes the
 * DICOM JSON model (DICOMweb metadata representation).
 *
 * The faithful inverse of `fromDicomWebJson`: it makes the contract a SINK as
 * well as a source, so the architecture round-trips
 * (DICOMweb JSON -> events -> DICOMweb JSON is identity) and any source can be
 * serialized to DICOMweb JSON (Part 10 -> events -> JSON).
 *
 * Output shape per tag: `{ vr, Value: [...] }`, or `{ vr, BulkDataURI }`, or
 * `{ vr, InlineBinary: base64 }`. Person Names pass through as the DICOMweb
 * `{ Alphabetic }` objects the contract carries. Binary source form is preserved
 * (§25): a `bulkDataReference` stays a `BulkDataURI`; assembled binary fragments
 * become base64 `InlineBinary`. Meta (group 0002) elements, when present, are
 * written flat alongside the dataset.
 */
export class DicomWebJsonWriter extends EventStreamListener {
    constructor(...filters) {
        super(...filters);
        this.result = {};
        // Stack of containers (the root object or a sequence item object) plus
        // the element/sequence currently being built.
        this._containers = [this.result];
        this._pending = null; // { tag, attr, fragments? }
    }

    _container() {
        return this._containers[this._containers.length - 1];
    }

    _baseStartDataSet() {
        this.result = {};
        this._containers = [this.result];
        this._pending = null;
    }

    _baseStartElement(tag, info = {}) {
        this._pending = { tag, attr: { vr: info.vr }, values: [] };
    }

    _baseValue(v) {
        this._pending.values.push(v);
    }

    _baseBulkDataReference(ref = {}) {
        this._pending.attr.BulkDataURI = ref.uri;
        this._pending.values = null; // bulk reference carries no Value
    }

    _baseStartBinary() {
        this._pending.fragments = [];
        this._pending.values = null;
    }

    _baseBinaryFragment(chunk) {
        this._pending.fragments.push(chunk);
    }

    _baseEndBinary() {
        this._pending.attr.InlineBinary = encodeBase64(
            concatFragments(this._pending.fragments)
        );
    }

    _baseEndElement() {
        const { tag, attr, values } = this._pending;
        if (values && values.length) {
            attr.Value = values;
        }
        this._container()[tag] = attr;
        this._pending = null;
    }

    _baseStartSequence(tag, info = {}) {
        const attr = { vr: info.vr, Value: [] };
        this._container()[tag] = attr;
        this._pending = null;
        // Items are pushed into attr.Value via a sequence marker on the stack.
        this._containers.push({ __seqValue: attr.Value });
    }

    _baseStartItem() {
        const item = {};
        this._container().__seqValue.push(item);
        this._containers.push(item);
    }

    _baseEndItem() {
        this._containers.pop();
    }

    _baseEndSequence() {
        this._containers.pop();
    }
}

function concatFragments(fragments) {
    const parts = fragments.map(f =>
        f instanceof ArrayBuffer
            ? new Uint8Array(f)
            : new Uint8Array(f.buffer, f.byteOffset, f.byteLength)
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

function encodeBase64(uint8) {
    if (typeof Buffer !== "undefined") {
        return Buffer.from(
            uint8.buffer,
            uint8.byteOffset,
            uint8.byteLength
        ).toString("base64");
    }
    let binary = "";
    for (let i = 0; i < uint8.length; i++) {
        binary += String.fromCharCode(uint8[i]);
    }
    return btoa(binary);
}
