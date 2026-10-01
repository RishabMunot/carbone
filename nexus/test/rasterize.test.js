const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const { PDFDocument } = require('pdf-lib');
const { buildApp } = require('../server/app');
const { render } = require('../server/render');
const { rasterize, parsePgm, downsample, toGfa, crc16 } = require('../server/rasterize');

const TOKEN = 'secret';
const auth = { authorization: `Bearer ${TOKEN}` };

// A binary PGM (P5, maxval 255): a comment line, then width, height, maxval and the pixels.
const pgm = (width, height, pixels) =>
  Buffer.concat([Buffer.from(`P5\n# made by a test\n${width} ${height}\n255\n`), Buffer.from(pixels)]);

describe('rasterize packing', () => {
  it('parsePgm reads the size and the pixels of a P5 image with a comment', () => {
    const { width, height, gray } = parsePgm(pgm(3, 2, [0, 1, 2, 253, 254, 255]));
    assert.deepStrictEqual({ width, height }, { width: 3, height: 2 });
    assert.deepStrictEqual([...gray], [0, 1, 2, 253, 254, 255]);
  });

  it('parsePgm rejects a truncated image', () => {
    assert.throws(() => parsePgm(pgm(3, 2, [0, 1, 2])), /truncated/);
  });

  it('downsample turns each 3 x 3 block into one dot, black first, MSB first', () => {
    const row = [0, 0, 0, 255, 255, 255];
    const { width, height, bytesPerRow, bytes } = downsample(Buffer.from([...row, ...row, ...row]), 6, 3, 3, 150);
    assert.deepStrictEqual({ width, height, bytesPerRow }, { width: 2, height: 1, bytesPerRow: 1 });
    assert.deepStrictEqual([...bytes], [0b10000000]);
  });

  it('downsample rounds the size up and averages only the pixels an edge block has', () => {
    // 7 x 1: dots cover columns 0-2, 3-5 and the single column 6
    const { width, height, bytes } = downsample(Buffer.from([255, 255, 255, 255, 255, 255, 0]), 7, 1, 3, 150);
    assert.deepStrictEqual({ width, height }, { width: 3, height: 1 });
    assert.deepStrictEqual([...bytes], [0b00100000]);
  });

  it('downsample: an average of 149 is black and 150 is white', () => {
    const block = (value) => Buffer.alloc(9, value);
    assert.deepStrictEqual([...downsample(block(149), 3, 3, 3, 150).bytes], [0b10000000]);
    assert.deepStrictEqual([...downsample(block(150), 3, 3, 3, 150).bytes], [0]);
  });

  it('toGfa hex is exact and uppercase', () => {
    const bytes = Buffer.from([0xaa, 0x80, 0xff, 0xc0]);
    assert.strictEqual(toGfa(bytes, 2, 'hex'), '^GFA,4,4,2,AA80FFC0');
  });

  it('crc16 is CRC-16/XMODEM', () => {
    assert.strictEqual(crc16('123456789'), 0x31c3);
  });

  it('toGfa z64 decodes back to the same bytes and carries the CRC of the base64', () => {
    const bytes = Buffer.from(Array.from({ length: 64 }, (_, i) => (i % 5 === 0 ? 0xff : 0)));
    const gfa = toGfa(bytes, 8, 'z64');
    const [, total, total2, perRow, data] = gfa.match(/^\^GFA,(\d+),(\d+),(\d+),(.*)$/);
    assert.deepStrictEqual([total, total2, perRow], ['64', '64', '8']);
    const [, b64, crc] = data.match(/^:Z64:([A-Za-z0-9+/=]+):([0-9A-F]{4})$/);
    assert.strictEqual(crc, crc16(b64).toString(16).toUpperCase().padStart(4, '0'));
    assert.ok(zlib.inflateSync(Buffer.from(b64, 'base64')).equals(bytes));
  });
});

describe('POST /rasterize', () => {
  const stubFonts = async () => [];
  const stubRender = async () => ({ pdf: Buffer.from('%PDF'), pageCount: 1 });
  const stubRasterize = async () => [];
  const app = (overrides = {}) =>
    buildApp({ token: TOKEN, render: stubRender, fonts: stubFonts, rasterize: stubRasterize, ...overrides });
  const post = (a, payload, headers = auth) => a.inject({ method: 'POST', url: '/rasterize', headers, payload });
  const pdf = Buffer.from('%PDF-stub').toString('base64');

  it('without the token is 401', async () => {
    const res = await post(app(), { pdf, dpi: 203, encoding: 'hex' }, {});
    assert.strictEqual(res.statusCode, 401);
  });

  it('a pdf that is not a base64 string is 400', async () => {
    const res = await post(app(), { dpi: 203, encoding: 'hex' });
    assert.strictEqual(res.statusCode, 400);
  });

  it('an unsupported dpi is 400', async () => {
    const res = await post(app(), { pdf, dpi: 72, encoding: 'hex' });
    assert.strictEqual(res.statusCode, 400);
  });

  it('an unknown encoding is 400 and names the three', async () => {
    const res = await post(app(), { pdf, dpi: 203, encoding: 'base64' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.json().message, 'encoding must be one of z64, hex, raw');
  });

  it('raw is accepted and a page with rows passes through', async () => {
    let received;
    const pages = [{ widthMm: 1, heightMm: 2, widthDots: 8, heightDots: 1, bytesPerRow: 1, rows: 'gA==' }];
    const res = await post(
      app({ rasterize: async (args) => { received = args; return pages; } }),
      { pdf, dpi: 203, encoding: 'raw' }
    );
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.json(), { pages });
    assert.strictEqual(received.encoding, 'raw');
  });

  it('passes the decoded pdf, dpi and encoding through and wraps the pages', async () => {
    let received;
    const pages = [{ widthMm: 1, heightMm: 2, widthDots: 3, heightDots: 4, gfa: '^GFA,1,1,1,00' }];
    const res = await post(
      app({ rasterize: async (args) => { received = args; return pages; } }),
      { pdf, dpi: 300, encoding: 'z64' }
    );
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.json(), { pages });
    assert.ok(received.pdf.equals(Buffer.from('%PDF-stub')));
    assert.strictEqual(received.dpi, 300);
    assert.strictEqual(received.encoding, 'z64');
  });

  it('a pdftoppm failure on a readable PDF is 422 with its message', async () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-bin-'));
    fs.writeFileSync(path.join(bin, 'pdftoppm'), '#!/bin/sh\necho boom >&2\nexit 1\n', { mode: 0o755 });
    const doc = await PDFDocument.create();
    doc.addPage([100, 100]);
    const readable = Buffer.from(await doc.save()).toString('base64');
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${savedPath}`;
    try {
      const res = await post(app({ rasterize }), { pdf: readable, dpi: 203, encoding: 'hex' });
      assert.strictEqual(res.statusCode, 422);
      assert.match(res.json().message, /pdftoppm failed on page 1.*boom/);
    } finally {
      process.env.PATH = savedPath;
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });

  it('a non-PDF is 422 (real rasterize, no poppler needed)', async () => {
    const res = await post(app({ rasterize }), { pdf, dpi: 203, encoding: 'hex' });
    assert.strictEqual(res.statusCode, 422);
    assert.ok(res.json().message);
  });
});

function hasPoppler() {
  return (process.env.PATH || '').split(path.delimiter).some((dir) => fs.existsSync(path.join(dir, 'pdftoppm')));
}

function hasLibreOffice() {
  return (process.env.PATH || '').split(path.delimiter).some((dir) => fs.existsSync(path.join(dir, 'soffice')));
}

describe('real rasterize (needs LibreOffice and poppler)', function () {
  before(function () {
    if (!hasLibreOffice() || !hasPoppler()) {
      console.log('      SKIPPED: soffice or pdftoppm not found; this test runs inside the Docker image');
      this.skip();
    }
  });

  it('rasterizes the rendered hello.docx at 203 dpi to one page', async function () {
    this.timeout(60000);
    const template = fs.readFileSync(path.join(__dirname, 'fixtures/hello.docx'));
    const { pdf } = await render({ template, data: { name: 'Nexus' }, dpi: 203 });
    const pages = await rasterize({ pdf, dpi: 203, encoding: 'z64' });
    assert.strictEqual(pages.length, 1);
    // hello.docx is US Letter, not A4
    assert.strictEqual(pages[0].widthMm, 215.9);
    assert.strictEqual(pages[0].widthDots, Math.round((215.9 / 25.4) * 203));
    assert.ok(pages[0].gfa.startsWith('^GFA,') && pages[0].gfa.includes(':Z64:'));
  });

  // 8 neighbours all white = a speckle dot that no printer should burn. The owner's speckle came from grey edges on
  // real label pages; this pure-black fixture never made poppler 22.12's -mono speckle, so it guards against regressions.
  const isolatedDots = ({ rows, widthDots, heightDots, bytesPerRow }) => {
    const bytes = Buffer.from(rows, 'base64');
    const black = (x, y) => x >= 0 && y >= 0 && x < widthDots && y < heightDots && (bytes[y * bytesPerRow + (x >> 3)] >> (7 - (x & 7))) & 1;
    let count = 0;
    for (let y = 0; y < heightDots; y++) {
      for (let x = 0; x < widthDots; x++) {
        if (!black(x, y)) continue;
        let lonely = true;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && black(x + dx, y + dy)) lonely = false;
        if (lonely) count++;
      }
    }
    return count;
  };

  it('a thin diagonal at 203 dpi is 160 x 160 dots with no isolated black dot (pdftoppm -mono also left 0 here)', async function () {
    this.timeout(60000);
    const pdf = fs.readFileSync(path.join(__dirname, 'fixtures/diagonal.pdf'));
    const [page] = await rasterize({ pdf, dpi: 203, encoding: 'raw' });
    assert.deepStrictEqual([page.widthDots, page.heightDots, page.bytesPerRow], [160, 160, 20]);
    assert.strictEqual(Buffer.from(page.rows, 'base64').length, 160 * 20);
    assert.ok(Buffer.from(page.rows, 'base64').some((byte) => byte), 'the page is not blank');
    assert.strictEqual(isolatedDots(page), 0);
  });
});
