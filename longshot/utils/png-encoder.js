/**
 * Streaming PNG encoder.
 *
 * Browser canvases are capped at 32,767 px per side, but a full-page capture
 * at 2× can easily be 2,880 × 60,000 px. This encoder accepts the image a strip
 * of rows at a time, applies PNG row filters in JS, and pipes the filtered
 * bytes through the browser's native zlib (CompressionStream('deflate'), which
 * emits exactly the zlib stream PNG's IDAT data requires). Memory use is
 * bounded by one strip, and the output is assembled as a Blob that Chrome can
 * back with disk storage.
 *
 * The output is lossless 8-bit RGB (screenshots are opaque), tagged sRGB, with
 * a pHYs chunk so apps that honour DPI show the image at its CSS size.
 */

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const IDAT_TARGET_BYTES = 1 << 20; // group compressed output into ~1 MB IDAT chunks

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes, crc = 0xffffffff) {
  let c = crc;
  for (let i = 0; i < bytes.length; i += 1) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return c;
}

function makeChunk(type, data) {
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) chunk[4 + i] = type.charCodeAt(i);
  chunk.set(data, 8);
  const crc = crc32(chunk.subarray(4, 8 + data.length)) ^ 0xffffffff;
  view.setUint32(8 + data.length, crc >>> 0);
  return chunk;
}

function ihdrChunk(width, height) {
  const data = new Uint8Array(13);
  const view = new DataView(data.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  data[8] = 8; // bit depth
  data[9] = 2; // colour type: truecolour RGB
  data[10] = 0; // compression: deflate
  data[11] = 0; // filter method 0
  data[12] = 0; // no interlace
  return makeChunk('IHDR', data);
}

function physChunk(dpi) {
  const pixelsPerMeter = Math.round(dpi / 0.0254);
  const data = new Uint8Array(9);
  const view = new DataView(data.buffer);
  view.setUint32(0, pixelsPerMeter);
  view.setUint32(4, pixelsPerMeter);
  data[8] = 1; // unit: metre
  return makeChunk('pHYs', data);
}

/** Paeth predictor from the PNG specification. */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

const BPP = 3;

/**
 * Write one filtered scanline (filter byte + data) into `out` at `offset`.
 * `cur`/`prev` are RGB rows. Returns the chosen filter type.
 */
function filterRow(effort, cur, prev, hasPrev, out, offset, scratch) {
  const length = cur.length;

  // Identical rows (very common: blank space) compress to all zeros with Up.
  if (hasPrev) {
    let identical = true;
    for (let i = 0; i < length; i += 1) {
      if (cur[i] !== prev[i]) {
        identical = false;
        break;
      }
    }
    if (identical) {
      out[offset] = 2;
      out.fill(0, offset + 1, offset + 1 + length);
      return 2;
    }
  }

  if (effort === 'fast') {
    // Sub filter: cheap and effective on flat UI colours.
    out[offset] = 1;
    for (let i = 0; i < length; i += 1) {
      const left = i >= BPP ? cur[i - BPP] : 0;
      out[offset + 1 + i] = (cur[i] - left) & 0xff;
    }
    return 1;
  }

  // Adaptive filtering: pick the filter with the minimum sum of absolute
  // (signed) residuals, the heuristic recommended by the PNG spec.
  const candidates = effort === 'smallest' ? [0, 1, 2, 3, 4] : [1, 2, 4];
  let bestType = 0;
  let bestScore = Infinity;
  let bestBuffer = null;

  for (const type of candidates) {
    const buffer = scratch[type];
    let score = 0;
    for (let i = 0; i < length; i += 1) {
      const x = cur[i];
      const a = i >= BPP ? cur[i - BPP] : 0;
      const b = hasPrev ? prev[i] : 0;
      let residual;
      switch (type) {
        case 0:
          residual = x;
          break;
        case 1:
          residual = x - a;
          break;
        case 2:
          residual = x - b;
          break;
        case 3:
          residual = x - ((a + b) >> 1);
          break;
        default: {
          const c = hasPrev && i >= BPP ? prev[i - BPP] : 0;
          residual = x - paeth(a, b, c);
        }
      }
      const byte = residual & 0xff;
      buffer[i] = byte;
      score += byte < 128 ? byte : 256 - byte;
      if (score >= bestScore) break;
    }
    if (score < bestScore) {
      bestScore = score;
      bestType = type;
      bestBuffer = buffer;
    }
  }

  out[offset] = bestType;
  out.set(bestBuffer.subarray(0, length), offset + 1);
  return bestType;
}

export class StreamingPngEncoder {
  /**
   * @param {number} width
   * @param {{ effort?: 'fast'|'balanced'|'smallest', dpi?: number }} [options]
   */
  constructor(width, { effort = 'balanced', dpi = 96 } = {}) {
    if (typeof CompressionStream === 'undefined') {
      throw new Error('CompressionStream is not available in this browser');
    }
    this.width = width;
    this.effort = effort;
    this.dpi = dpi;
    this.rowBytes = width * BPP;
    this.rowsWritten = 0;
    this.prevRow = new Uint8Array(this.rowBytes);
    this.curRow = new Uint8Array(this.rowBytes);
    this.scratch = [0, 1, 2, 3, 4].map(() => new Uint8Array(this.rowBytes));

    const stream = new CompressionStream('deflate');
    this.writer = stream.writable.getWriter();
    this.idatParts = [];
    this.pending = [];
    this.pendingBytes = 0;
    this.compressedBytes = 0;

    const reader = stream.readable.getReader();
    this.readDone = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        this.pending.push(value);
        this.pendingBytes += value.length;
        if (this.pendingBytes >= IDAT_TARGET_BYTES) this.flushIdat();
      }
      this.flushIdat();
    })();
  }

  flushIdat() {
    if (this.pendingBytes === 0) return;
    const data = new Uint8Array(this.pendingBytes);
    let offset = 0;
    for (const part of this.pending) {
      data.set(part, offset);
      offset += part.length;
    }
    this.pending = [];
    this.pendingBytes = 0;
    this.compressedBytes += data.length;
    // Wrap in a Blob immediately so Chrome may move it out of JS memory.
    this.idatParts.push(new Blob([makeChunk('IDAT', data)]));
  }

  /**
   * Append rows from RGBA pixel data (as returned by getImageData).
   * @param {Uint8ClampedArray} rgba
   * @param {number} rowCount
   * @param {number} [rowOffset=0]  First row of `rgba` to use.
   */
  async addRgbaRows(rgba, rowCount, rowOffset = 0) {
    const { width, rowBytes } = this;
    const out = new Uint8Array((rowBytes + 1) * rowCount);

    for (let row = 0; row < rowCount; row += 1) {
      const src = (rowOffset + row) * width * 4;
      const cur = this.curRow;
      for (let x = 0, s = src, d = 0; x < width; x += 1, s += 4, d += 3) {
        cur[d] = rgba[s];
        cur[d + 1] = rgba[s + 1];
        cur[d + 2] = rgba[s + 2];
      }
      filterRow(this.effort, cur, this.prevRow, this.rowsWritten > 0, out, row * (rowBytes + 1), this.scratch);
      this.curRow = this.prevRow;
      this.prevRow = cur;
      this.rowsWritten += 1;
    }

    await this.writer.ready;
    await this.writer.write(out);
  }

  /** Finish the stream and return the PNG Blob. */
  async finish() {
    await this.writer.close();
    await this.readDone;
    const header = [
      PNG_SIGNATURE,
      ihdrChunk(this.width, this.rowsWritten),
      makeChunk('sRGB', new Uint8Array([0])),
      physChunk(this.dpi),
    ];
    const end = makeChunk('IEND', new Uint8Array(0));
    return new Blob([...header, ...this.idatParts, end], { type: 'image/png' });
  }

  async abort() {
    try {
      await this.writer.abort();
    } catch {
      // ignore
    }
  }
}

/** Read width/height from a PNG blob's IHDR without decoding it. */
export async function readPngDimensions(blob) {
  const header = new Uint8Array(await blob.slice(0, 24).arrayBuffer());
  const isPng = PNG_SIGNATURE.every((byte, i) => header[i] === byte);
  if (!isPng) throw new Error('Not a PNG image');
  const view = new DataView(header.buffer);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}
