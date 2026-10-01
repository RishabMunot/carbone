const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { PDFDocument } = require('pdf-lib');
const { RenderError } = require('./errors');

const run = promisify(execFile);
const MAX_PAGES = 1000;
const PAGE_TIMEOUT_MS = 60000;

// CRC-16/XMODEM (poly 0x1021, init 0x0000): what ZPL's :Z64: data ends with.
function crc16(text) {
  let crc = 0;
  for (const byte of Buffer.from(text)) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

// Black when a dot's average grey (0-255) is below this. Chosen on a real TSC at 203 dpi.
const THRESHOLD = 150;
const FACTOR = 3;

// A binary PGM (P5, maxval 255) is "P5", width, height, maxval, one whitespace byte, then one byte per pixel.
// Whitespace separates the header fields, and "#" starts a comment that runs to the end of the line.
function parsePgm(pgm) {
  let pos = 0;
  const token = () => {
    for (;;) {
      while (/\s/.test(String.fromCharCode(pgm[pos]))) pos++;
      if (pgm[pos] !== 0x23) break;
      while (pgm[pos] !== 0x0a) pos++;
    }
    const start = pos;
    while (pos < pgm.length && !/\s/.test(String.fromCharCode(pgm[pos]))) pos++;
    return pgm.toString('latin1', start, pos);
  };
  if (token() !== 'P5') throw new Error('not a P5 graymap');
  const width = Number(token());
  const height = Number(token());
  if (token() !== '255') throw new Error('not an 8-bit graymap');
  const gray = pgm.subarray(pos + 1, pos + 1 + width * height);
  if (gray.length !== width * height) throw new Error('truncated P5 graymap');
  return { width, height, gray };
}

// Averages each factor x factor block into one dot (edge blocks average the pixels they have); a dot is black when
// the average is below the threshold. Rows are packed MSB-first, 1 = black, padded to whole bytes.
function downsample(gray, width, height, factor, threshold) {
  const dotsWide = Math.ceil(width / factor);
  const dotsHigh = Math.ceil(height / factor);
  const bytesPerRow = Math.ceil(dotsWide / 8);
  const bytes = Buffer.alloc(bytesPerRow * dotsHigh);
  for (let dy = 0; dy < dotsHigh; dy++) {
    for (let dx = 0; dx < dotsWide; dx++) {
      let sum = 0;
      let count = 0;
      for (let y = dy * factor; y < Math.min(height, (dy + 1) * factor); y++) {
        for (let x = dx * factor; x < Math.min(width, (dx + 1) * factor); x++) {
          sum += gray[y * width + x];
          count++;
        }
      }
      if (sum < threshold * count) bytes[dy * bytesPerRow + (dx >> 3)] |= 0x80 >> (dx & 7);
    }
  }
  return { width: dotsWide, height: dotsHigh, bytesPerRow, bytes };
}

// One complete ^GFA field: "z64" is zlib -> base64 -> CRC of the base64; "hex" is uppercase hex.
function toGfa(bytes, bytesPerRow, encoding) {
  let data = bytes.toString('hex').toUpperCase();
  if (encoding === 'z64') {
    const b64 = zlib.deflateSync(bytes).toString('base64');
    data = `:Z64:${b64}:${crc16(b64).toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return `^GFA,${bytes.length},${bytes.length},${bytesPerRow},${data}`;
}

const toMm = (points) => Math.round((points / 72) * 25.4 * 100) / 100;

// Every page of the PDF as a 1-bit bitmap at the printer's dpi: a ZPL graphic (z64, hex) or raw rows (raw).
// Rendered grey at 3x the dpi, then thresholded down: pdftoppm -mono dithers thin edges into speckle.
async function rasterize({ pdf, dpi, encoding }) {
  let sizes;
  try {
    sizes = (await PDFDocument.load(pdf)).getPages().map((page) => page.getSize());
  } catch (e) {
    throw new RenderError(`not a readable PDF: ${e.message}`);
  }
  if (sizes.length > MAX_PAGES) throw new RenderError(`at most ${MAX_PAGES} pages, this PDF has ${sizes.length}`);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-'));
  try {
    const file = path.join(dir, 'in.pdf');
    await fs.writeFile(file, pdf);
    const pages = [];
    for (const [i, { width, height }] of sizes.entries()) {
      const n = String(i + 1);
      const out = path.join(dir, `page${n}`);
      try {
        await run('pdftoppm', ['-gray', '-singlefile', '-r', String(dpi * FACTOR), '-f', n, '-l', n, file, out], { timeout: PAGE_TIMEOUT_MS });
      } catch (e) {
        if (e.code === 'ENOENT') throw e;
        throw new RenderError(`pdftoppm failed on page ${n}: ${String(e.stderr || e.message).trim()}`);
      }
      const { width: pxWide, height: pxHigh, gray } = parsePgm(await fs.readFile(`${out}.pgm`));
      const image = downsample(gray, pxWide, pxHigh, FACTOR, THRESHOLD);
      pages.push({
        widthMm: toMm(width),
        heightMm: toMm(height),
        widthDots: image.width,
        heightDots: image.height,
        bytesPerRow: image.bytesPerRow,
        ...(encoding === 'raw'
          ? { rows: image.bytes.toString('base64') }
          : { gfa: toGfa(image.bytes, image.bytesPerRow, encoding) }),
      });
    }
    return pages;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

module.exports = { rasterize, parsePgm, downsample, toGfa, crc16 };
