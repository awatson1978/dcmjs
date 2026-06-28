import { EventStreamListener } from "./EventStreamListener.js";
import { lookupTagHex } from "../dicom.lookup.js";
import addAccessors from "../utilities/addAccessors.js";
import dicomJson from "../utilities/dicomJson.js";
import log from "../log.js";

/**
 * NaturalizedListener — slice D1: the core naturalized value model.
 *
 * An event-stream consumer that builds the application-facing naturalized
 * object per the Naturalized DICOM Metadata Behavior Specification: canonical
 * keyword keys (§5) and VM-driven cardinality (§7-§14). Because it consumes the
 * source-agnostic contract, the SAME naturalized object is produced from Part 10
 * bytes, a dcmjs dict, or DICOMweb JSON.
 *
 * Scope (D1): keyword naming, VM cardinality, single-item sequences with hidden
 * length (§12, via the shared addAccessors proxy), empty→null/[], binary
 * assembly (InlineBinary/BulkDataURI), and the cardinality-violation policy
 * (§15.2, default warnAndPreserve). Deferred to D2: the PN proxy/toString sugar
 * (§17), private-tag grouping (§18), and precision/raw retention (§16/§27, which
 * needs the contract to carry raw values).
 *
 * Sequence note: a DICOM sequence's declared VM ("1") constrains how many times
 * the attribute appears, NOT its item count — multi-item sequences (e.g.
 * PerFrameFunctionalGroupsSequence) are normal, not violations. Violations apply
 * to non-sequence scalar VRs whose value count exceeds the declared VM.
 */
export class NaturalizedListener extends EventStreamListener {
    /**
     * @param {Object} [options]
     * @param {string} [options.cardinalityViolationPolicy="warnAndPreserve"]
     *   One of preserve | discardExtra | warnAndPreserve | warnAndDiscardExtra |
     *   recordAndPreserve | recordAndDiscardExtra | throw.
     */
    constructor(options = {}, ...filters) {
        super(...filters);
        this.policy = options.cardinalityViolationPolicy || "warnAndPreserve";
        this.result = {};
        this.meta = {};
        this.violations = [];
        // Frame stack. Each frame is one of:
        //   { kind: "object", obj }              dataset or sequence item
        //   { kind: "element", tag, vr, values, binary }
        //   { kind: "sequence", tag, vr, items }
        this._stack = [];
    }

    _objectFrame() {
        for (let i = this._stack.length - 1; i >= 0; i--) {
            if (this._stack[i].kind === "object") {
                return this._stack[i];
            }
        }
        return null;
    }

    _baseStartDataSet() {
        this.result = {};
        this.meta = {};
        this.violations = [];
        this._stack = [{ kind: "object", obj: this.result }];
    }

    _baseEndDataSet() {}

    _baseStartFileMetaInformation() {
        this._stack.push({ kind: "object", obj: this.meta });
    }

    _baseEndFileMetaInformation() {
        this._stack.pop();
    }

    _baseStartElement(tag, info = {}) {
        this._stack.push({
            kind: "element",
            tag,
            vr: info.vr,
            values: [],
            binary: undefined
        });
    }

    _baseValue(v) {
        this._stack[this._stack.length - 1].values.push(v);
    }

    _baseBulkDataReference(ref = {}) {
        this._stack[this._stack.length - 1].binary = { BulkDataURI: ref.uri };
    }

    _baseStartBinary() {
        this._stack[this._stack.length - 1]._fragments = [];
    }

    _baseBinaryFragment(chunk) {
        this._stack[this._stack.length - 1]._fragments.push(chunk);
    }

    _baseEndBinary() {
        const frame = this._stack[this._stack.length - 1];
        const fragments = frame._fragments || [];
        frame.binary = {
            InlineBinary: fragments.length === 1 ? fragments[0] : fragments
        };
        frame._fragments = undefined;
    }

    _baseEndElement() {
        const frame = this._stack.pop();
        const target = this._objectFrame().obj;
        const entry = lookupTagHex(frame.tag);
        const key = (entry && entry.name) || frame.tag;

        if (frame.binary !== undefined) {
            target[key] = frame.binary;
            return;
        }
        let shaped = this._shapeValues(frame, entry, key);
        if (frame.vr === "PN" && shaped !== null) {
            shaped = addPersonNameAccessors(shaped);
        }
        target[key] = shaped;
    }

    _baseStartSequence(tag, info = {}) {
        this._stack.push({ kind: "sequence", tag, vr: info.vr, items: [] });
    }

    _baseStartItem() {
        this._stack.push({ kind: "object", obj: {} });
    }

    _baseEndItem() {
        const itemFrame = this._stack.pop();
        // The enclosing frame is the sequence.
        this._stack[this._stack.length - 1].items.push(itemFrame.obj);
    }

    _baseEndSequence() {
        const frame = this._stack.pop();
        const target = this._objectFrame().obj;
        const entry = lookupTagHex(frame.tag);
        const key = (entry && entry.name) || frame.tag;
        target[key] = this._shapeSequence(frame, entry);
    }

    // --- cardinality shaping ------------------------------------------------

    _shapeValues(frame, entry, key) {
        const values = frame.values;
        const multi = isMultiVM(entry && entry.vm);

        if (multi) {
            // §10/§11: always list-like; present-empty -> [].
            return values;
        }
        // Scalar VM (1 or 0-1).
        if (values.length === 0) {
            return null; // §7/§9 present-empty
        }
        if (values.length === 1) {
            return values[0];
        }
        // §8: scalar VM with 2+ actual values -> cardinality violation.
        return this._applyViolation(key, values, 1);
    }

    _shapeSequence(frame, entry) {
        const items = frame.items;
        const declaredMulti = isMultiVM(entry && entry.vm);

        if (items.length === 0) {
            return []; // §12 present-empty
        }
        if (items.length === 1 && !declaredMulti) {
            // §12: single item exposed as the item object with hidden length 1
            // (the shared addAccessors proxy delegates property access to it).
            return addAccessors(items);
        }
        // §13: multiple items -> list-like. Not a violation (declared SQ VM
        // constrains attribute occurrence, not item count).
        return items;
    }

    _applyViolation(keyword, values, declaredMax) {
        const violation = {
            keyword,
            declaredMax,
            actual: values.length
        };
        const discard = /DiscardExtra$/.test(this.policy);
        const kept = discard ? values.slice(0, declaredMax) : values.slice();

        if (this.policy === "throw") {
            throw new Error(
                `Cardinality violation: ${keyword} has ${values.length} values, declared VM ${declaredMax}`
            );
        }
        if (/^warn/.test(this.policy)) {
            log.warn(
                `Cardinality violation: ${keyword} has ${values.length} values (declared VM ${declaredMax})`
            );
        }
        this.violations.push(violation);

        // discardExtra of a now-scalar VM collapses to the single kept value.
        if (discard && declaredMax === 1) {
            return kept[0];
        }
        return kept;
    }
}

/**
 * Add Person Name accessors (§17): a non-enumerable toString() returning the raw
 * PN string and toJSON() keeping the DICOM JSON model. Component access
 * (`.Alphabetic`) works directly because the value IS the {Alphabetic,...}
 * object (VM 1) or an array of them (VM n). Reuses dcmjs's shared helper.
 */
function addPersonNameAccessors(shaped) {
    if (typeof shaped === "string") {
        shaped = new String(shaped);
    }
    if (shaped && typeof shaped === "object") {
        return dicomJson.pnAddValueAccessors(shaped);
    }
    return shaped;
}

/**
 * A declared VM is "scalar" only when it is exactly "1" or "0-1"; anything else
 * (1-n, 2, 2-n, 3, 6, ...) permits multiple values and is list-like.
 */
function isMultiVM(vm) {
    if (!vm) {
        return false; // unknown tag -> treat as scalar-ish (D1; refined in D2)
    }
    return vm !== "1" && vm !== "0-1";
}
