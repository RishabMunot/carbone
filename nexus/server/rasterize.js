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

// CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF): what ZPL's :Z64: data ends with.
function crc16(text) {
  let crc = 0xffff;
  for (const byte of Buffer.from(text)) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

// A binary PBM (P4) is "P4", width, height, one whitespace byte, then rows padded to whole bytes, 1 = black.
function packPbm(pbm) {
  const header = /^P4\s+(\d+)\s+(\d+)\s/.exec(pbm.subarray(0, 64).toString('latin1'));
  if (!header) throw new Error('not a P4 bitmap');
  const width = Number(header[1]);
  const height = Number(header[2]);
  const bytesPerRow = Math.ceil(width / 8);
  const bytes = pbm.subarray(header[0].length, header[0].length + bytesPerRow * height);
  if (bytes.length !== bytesPerRow * height) throw new Error('truncated P4 bitmap');
  return { width, height, bytesPerRow, bytes };
}

// One complete ^GFA field: "z64" is zlib -> base64 -> CRC of the base64; "hex" is uppercase hex.
function toGfa(bytes, bytesPerRow, encoding) {
  let data = bytes.toString('hex').toUpperCase();
  if (encoding === 'z64') {
    const b64 = zlib.deflateSync(bytes).toString('base64');
    data = `:Z64:${b64}:${crc16(b64).toString(16).padStart(4, '0')}`;
  }
  return `^GFA,${bytes.length},${bytes.length},${bytesPerRow},${data}`;
}

const toMm = (points) => Math.round((points / 72) * 25.4 * 100) / 100;

// Every page of the PDF as a ZPL graphic at the printer's dpi (pdftoppm -mono: no anti-aliasing).
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
      await run('pdftoppm', ['-mono', '-singlefile', '-r', String(dpi), '-f', n, '-l', n, file, out]);
      const image = packPbm(await fs.readFile(`${out}.pbm`));
      pages.push({
        widthMm: toMm(width),
        heightMm: toMm(height),
        widthDots: image.width,
        heightDots: image.height,
        gfa: toGfa(image.bytes, image.bytesPerRow, encoding),
      });
    }
    return pages;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

module.exports = { rasterize, packPbm, toGfa, crc16 };
