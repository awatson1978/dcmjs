import findEndOfEncapsulatedElement from './findEndOfEncapsulatedPixelData.js';
import readSequenceItemsImplicit  from './readSequenceElementImplicit.js';
import { readTagPair } from './readTag.js';
import findItemDelimitationItemAndSetElementLength from './findItemDelimitationItem.js';
import readSequenceItemsExplicit from './readSequenceElementExplicit.js';

/**
 * Internal helper functions for for parsing DICOM elements
 */

// prebuilt lookup keyed by (vrByte0 << 8) | vrByte1 yielding the interned
// 2-char VR string and the size in bytes of the length field that follows it;
// built once at module load
const vrLookup = (() => {
  const lookup = new Map();
  const fourByteLengthVRs = ['OB', 'OD', 'OL', 'OW', 'SQ', 'OF', 'UC', 'UR', 'UT', 'UN'];
  const twoByteLengthVRs = ['AE', 'AS', 'AT', 'CS', 'DA', 'DS', 'DT', 'FL', 'FD', 'IS', 'LO', 'LT', 'PN', 'SH', 'SL', 'SS', 'ST', 'TM', 'UI', 'UL', 'US'];

  fourByteLengthVRs.forEach((vr) => {
    lookup.set((vr.charCodeAt(0) << 8) | vr.charCodeAt(1), { vr, lengthSizeBytes: 4 });
  });
  twoByteLengthVRs.forEach((vr) => {
    lookup.set((vr.charCodeAt(0) << 8) | vr.charCodeAt(1), { vr, lengthSizeBytes: 2 });
  });

  return lookup;
})();

// reads the two VR bytes and resolves them through the prebuilt lookup;
// unknown byte pairs keep the readFixedString(2) semantics (a null byte ends
// the string) and are treated as having a 2 byte length field
const readVR = (byteStream) => {
  if (byteStream.position + 2 > byteStream.byteArray.length) {
    throw 'dicomParser.readFixedString: attempt to read past end of buffer';
  }

  const vrByte0 = byteStream.byteArray[byteStream.position];
  const vrByte1 = byteStream.byteArray[byteStream.position + 1];

  byteStream.seek(2);

  const entry = vrLookup.get((vrByte0 << 8) | vrByte1);

  if (entry !== undefined) {
    return entry;
  }

  return {
    vr: (vrByte0 === 0) ? '' : ((vrByte1 === 0) ? String.fromCharCode(vrByte0) : String.fromCharCode(vrByte0, vrByte1)),
    lengthSizeBytes: 2
  };
};

export default function readDicomElementExplicit (byteStream, warnings, untilTag) {
  if (byteStream === undefined) {
    throw 'dicomParser.readDicomElementExplicit: missing required parameter \'byteStream\'';
  }

  const startOffset = byteStream.position;
  const { tag, tagValue } = readTagPair(byteStream);
  const { vr, lengthSizeBytes: dataLengthSizeBytes } = readVR(byteStream);

  // single object literal with all fields present so every element shares one hidden class;
  // later code may only mutate these fields, never add new ones
  const element = {
    tag,
    tagValue,
    vr,
    length: 0, // set below based on VR
    dataOffset: 0, // set below based on VR and size of length
    startOffset,
    endOffset: 0,
    hadUndefinedLength: false,
    parser: undefined,
    items: undefined,
    fragments: undefined,
    basicOffsetTable: undefined,
    encapsulatedPixelData: false,
    Value: undefined
  };

  if (dataLengthSizeBytes === 2) {
    element.length = byteStream.readUint16();
    element.dataOffset = byteStream.position;
  } else {
    byteStream.seek(2);
    element.length = byteStream.readUint32();
    element.dataOffset = byteStream.position;
  }

  if (element.length === 4294967295) {
    element.hadUndefinedLength = true;
  }

  if (element.tag === untilTag) {
    // the data is not consumed; the best known end is the declared span for
    // defined lengths and the current (post header) position otherwise
    element.endOffset = element.hadUndefinedLength ? byteStream.position : element.dataOffset + element.length;

    return element;
  }

  // if VR is SQ, parse the sequence items
  if (element.vr === 'SQ') {
    readSequenceItemsExplicit(byteStream, element, warnings);
    element.endOffset = byteStream.position;

    return element;
  }

  if (element.length === 4294967295) {
    if (element.tag === 'x7fe00010') {
      findEndOfEncapsulatedElement(byteStream, element, warnings);
      element.endOffset = byteStream.position;

      return element;
    } else if (element.vr === 'UN') {
      readSequenceItemsImplicit(byteStream, element);
      element.endOffset = byteStream.position;

      return element;
    }

    findItemDelimitationItemAndSetElementLength(byteStream, element);
    element.endOffset = byteStream.position;

    return element;
  }

  byteStream.seek(element.length);
  element.endOffset = byteStream.position;

  return element;
}
