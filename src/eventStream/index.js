/**
 * The dcmjs event-stream contract (refactor slice A).
 *
 * The canonical, source-agnostic interchange layer: readers produce event
 * streams, listeners/writers consume them. See CLAUDE_REFACTOR_PLAN.md and
 * docs at packages/docs for the full architecture.
 */
export {
    EventStreamListener,
    EVENT_STREAM_VOCABULARY,
    CONTRACT_VERSION
} from "./EventStreamListener.js";
export { CollectorListener } from "./CollectorListener.js";
export { NaturalizedListener } from "./NaturalizedListener.js";
export { fromDataSet } from "./fromDataSet.js";
export { fromPart10 } from "./fromPart10.js";
export { fromDicomWebJson } from "./fromDicomWebJson.js";
export { createEventAsyncIterable } from "./asyncIterator.js";

import {
    EventStreamListener,
    EVENT_STREAM_VOCABULARY,
    CONTRACT_VERSION
} from "./EventStreamListener.js";
import { CollectorListener } from "./CollectorListener.js";
import { NaturalizedListener } from "./NaturalizedListener.js";
import { fromDataSet } from "./fromDataSet.js";
import { fromPart10 } from "./fromPart10.js";
import { fromDicomWebJson } from "./fromDicomWebJson.js";
import { createEventAsyncIterable } from "./asyncIterator.js";

export default {
    EventStreamListener,
    EVENT_STREAM_VOCABULARY,
    CONTRACT_VERSION,
    CollectorListener,
    NaturalizedListener,
    fromDataSet,
    fromPart10,
    fromDicomWebJson,
    createEventAsyncIterable
};
