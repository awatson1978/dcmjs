import { NaturalizedListener } from "./NaturalizedListener.js";
import { DicomWebJsonWriter } from "./DicomWebJsonWriter.js";
import { CollectorListener } from "./CollectorListener.js";
import { fromPart10 } from "./fromPart10.js";
import { fromDicomWebJson } from "./fromDicomWebJson.js";
import { fromDataSet } from "./fromDataSet.js";
import { createEventAsyncIterable } from "./asyncIterator.js";

/**
 * The recommended public source/sink API (spec §32) — thin, ergonomic wrappers
 * over the event-stream generators and listeners.
 *
 *   const events = DicomEventStream.fromPart10(bytes);
 *   const metadata = await Naturalized.from(events);   // or events.toNaturalized()
 *   const json = await DicomWebJson.from(events);       // or events.toDicomWebJson()
 *
 * A DicomEventStream wraps a re-runnable `run(listener)` thunk, so the same
 * source can drive multiple sinks. Explicit listener usage remains available via
 * `events.process(listener)`.
 */
export class DicomEventStream {
    /**
     * @param {(listener: import("./EventStreamListener").EventStreamListener) => Promise<void>} run
     */
    constructor(run) {
        this._run = run;
    }

    /** A Part 10 byte buffer source. */
    static fromPart10(buffer, options = {}) {
        return new DicomEventStream(listener =>
            fromPart10(buffer, listener, options)
        );
    }

    /** A DICOMweb JSON (DICOM JSON model) source. */
    static fromDicomWebJson(json) {
        return new DicomEventStream(listener =>
            fromDicomWebJson(json, listener)
        );
    }

    /** A parsed dcmjs dataset ({ meta, dict }) source. */
    static fromDataSet(dataset) {
        return new DicomEventStream(listener => fromDataSet(dataset, listener));
    }

    /** Drive an arbitrary listener; resolves when the stream completes. */
    process(listener) {
        return Promise.resolve(this._run(listener)).then(() => listener);
    }

    /** Materialize the naturalized object (slice D1). */
    async toNaturalized(options = {}) {
        const listener = new NaturalizedListener(options);
        await this._run(listener);
        return listener.result;
    }

    /** Serialize to the DICOM JSON model (slice E1). */
    async toDicomWebJson() {
        const writer = new DicomWebJsonWriter();
        await this._run(writer);
        return writer.result;
    }

    /** Rebuild a tag-keyed { meta, dict } tree (the reference collector). */
    async toDataSet() {
        const collector = new CollectorListener();
        await this._run(collector);
        return collector.result;
    }

    /** Consume the stream as an async-iterable of `{ type, args }` events. */
    asyncIterable(options) {
        return createEventAsyncIterable(
            listener => this._run(listener),
            options
        );
    }
}

/** §32 sink helpers — `Naturalized.from(events)` / `DicomWebJson.from(events)`. */
export const Naturalized = {
    from(source, options) {
        return source.toNaturalized(options);
    }
};

export const DicomWebJson = {
    from(source) {
        return source.toDicomWebJson();
    }
};
