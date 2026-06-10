import SplitDataView from "../src/SplitDataView";

/**
 * Builds a multi-chunk SplitDataView plus a contiguous DataView over the
 * same bytes to compare reads against.
 */
function buildChunked(chunkCount, chunkSize) {
    const total = chunkCount * chunkSize;
    const reference = new Uint8Array(total);
    for (let i = 0; i < total; i++) {
        reference[i] = (i * 7 + 3) & 0xff;
    }
    const view = new SplitDataView();
    for (let c = 0; c < chunkCount; c++) {
        view.addBuffer(
            reference.buffer.slice(c * chunkSize, (c + 1) * chunkSize)
        );
    }
    return { view, referenceView: new DataView(reference.buffer), total };
}

describe("SplitDataView", () => {
    describe("findStart cached-chunk fast path", () => {
        it("returns correct chunks for sequential forward reads", () => {
            const { view, referenceView, total } = buildChunked(64, 32);
            for (let offset = 0; offset + 2 <= total; offset += 2) {
                expect(view.getUint16(offset, true)).toBe(
                    referenceView.getUint16(offset, true)
                );
            }
        });

        it("returns correct chunks for backward and random reads (cache misses)", () => {
            const { view, referenceView, total } = buildChunked(64, 32);
            // Prime the cache at the last chunk.
            view.getUint8(total - 1);
            for (let offset = total - 4; offset >= 0; offset -= 4) {
                expect(view.getUint32(offset, true)).toBe(
                    referenceView.getUint32(offset, true)
                );
            }
            const probes = [0, total - 4, 33, 1024, 5, total / 2, 17];
            for (const offset of probes) {
                expect(view.getUint32(offset, false)).toBe(
                    referenceView.getUint32(offset, false)
                );
            }
        });

        it("reads values straddling chunk boundaries", () => {
            const { view, referenceView } = buildChunked(8, 8);
            // Each read crosses a chunk boundary.
            for (let chunk = 1; chunk < 8; chunk++) {
                const offset = chunk * 8 - 2;
                expect(view.getUint32(offset, true)).toBe(
                    referenceView.getUint32(offset, true)
                );
            }
        });

        it("findStart returns the same indices as a plain linear scan", () => {
            const { view, total } = buildChunked(16, 16);
            const scan = start => {
                for (let index = 0; index < view.buffers.length; index++) {
                    if (
                        start >= view.offsets[index] &&
                        start < view.offsets[index] + view.lengths[index]
                    ) {
                        return index;
                    }
                }
            };
            const offsets = [0, 1, 15, 16, 17, 100, 255, 128, 31, total - 1];
            for (const offset of offsets) {
                expect(view.findStart(offset)).toBe(scan(offset));
            }
            expect(view.findStart(total)).toBeUndefined();
        });

        it("stays correct when chunks are added after reads", () => {
            const view = new SplitDataView();
            view.addBuffer(new Uint8Array([1, 2, 3, 4]).buffer);
            expect(view.getUint8(3)).toBe(4);
            view.addBuffer(new Uint8Array([5, 6, 7, 8]).buffer);
            expect(view.getUint8(4)).toBe(5);
            expect(view.getUint8(7)).toBe(8);
            expect(view.getUint8(0)).toBe(1);
        });

        it("stays correct after consume nulls earlier chunks", () => {
            const { view, referenceView, total } = buildChunked(8, 16);
            // Prime the cache deep into the stream.
            view.getUint8(total - 1);
            // Consume the first half of the chunks.
            view.consume(64);
            expect(view.hasData(0, 16)).toBe(false);
            // Reads in the remaining region must still resolve correctly.
            for (let offset = 64; offset + 2 <= total; offset += 2) {
                expect(view.getUint16(offset, true)).toBe(
                    referenceView.getUint16(offset, true)
                );
            }
        });

        it("stays correct across truncateTo from a zero-copy window append", () => {
            const view = new SplitDataView({ defaultSize: 16 });
            view.checkSize(16);
            view.writeBuffer(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), 0);
            view.size = 8;
            // Prime the cache on the writable chunk.
            expect(view.getUint8(7)).toBe(8);
            // Appending a window truncates the writable chunk to 8 bytes.
            const windowBytes = new Uint8Array(100).fill(9);
            view.addZeroCopyWindow(windowBytes, 8);
            expect(view.getUint8(8)).toBe(9);
            expect(view.getUint8(107)).toBe(9);
            expect(view.getUint8(0)).toBe(1);
            expect(view.getUint16(7, false)).toBe((8 << 8) | 9);
        });
    });
});
