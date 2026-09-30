const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { buildApp } = require('../server/app');
const { render } = require('../server/render');
const { rasterize, packPbm, toGfa, crc16 } = require('../server/rasterize');

const TOKEN = 'secret';
const auth = { authorization: `Bearer ${TOKEN}` };

// 10 x 2 bitmap: row 1 = 1010101010, row 2 = 1111111111 (1 = black), rows padded to whole bytes.
const pbm = Buffer.concat([Buffer.from('P4\n10 2\n'), Buffer.from([0xaa, 0x80, 0xff, 0xc0])]);

describe('rasterize packing', () => {
  it('packPbm reads the size and the padded rows of a P4 image', () => {
    const { width, height, bytesPerRow, bytes } = packPbm(pbm);
    assert.deepStrictEqual({ width, height, bytesPerRow }, { width: 10, height: 2, bytesPerRow: 2 });
    assert.deepStrictEqual([...bytes], [0xaa, 0x80, 0xff, 0xc0]);
  });

  it('toGfa hex is exact and uppercase', () => {
    const bytes = Buffer.from([0xaa, 0x80, 0xff, 0xc0]);
    assert.strictEqual(toGfa(bytes, 2, 'hex'), '^GFA,4,4,2,AA80FFC0');
  });

  it('crc16 is CRC-16/CCITT-FALSE', () => {
    assert.strictEqual(crc16('123456789'), 0x29b1);
  });

  it('toGfa z64 decodes back to the same bytes and carries the CRC of the base64', () => {
    const bytes = Buffer.from(Array.from({ length: 64 }, (_, i) => (i % 5 === 0 ? 0xff : 0)));
    const gfa = toGfa(bytes, 8, 'z64');
    const [, total, total2, perRow, data] = gfa.match(/^\^GFA,(\d+),(\d+),(\d+),(.*)$/);
    assert.deepStrictEqual([total, total2, perRow], ['64', '64', '8']);
    const [, b64, crc] = data.match(/^:Z64:([A-Za-z0-9+/=]+):([0-9a-f]{4})$/);
    assert.strictEqual(crc, crc16(b64).toString(16).padStart(4, '0'));
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

  it('an unknown encoding is 400', async () => {
    const res = await post(app(), { pdf, dpi: 203, encoding: 'base64' });
    assert.strictEqual(res.statusCode, 400);
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
});
