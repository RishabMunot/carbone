const assert = require('assert');
const path = require('path');
const { promisify } = require('util');
const yauzl = require('yauzl');
const { PNG } = require('pngjs');
const carbone = require('../../lib/index');
const { fillPictures } = require('../server/pictures');
const { RenderError } = require('../server/render');

const fixture = path.join(__dirname, 'fixtures/pictures.docx');
const renderDocx = promisify(carbone.render);
const EMU_PER_INCH = 914400;
const DPI = 203;

function solidPng(width, height, [r, g, b]) {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) png.data.set([r, g, b, 255], i);
  return PNG.sync.write(png);
}

const photo = solidPng(3, 2, [200, 10, 10]);
const data = {
  photo: 'data:image/png;base64,' + photo.toString('base64'),
  link: 'https://nexus.test/p/42?a=1&b=2',
  code: 'ABC-123',
  hex: '#1F3A5F',
  colours: [{ hex: '#111111' }, { hex: '#222222' }, { hex: '#333333' }],
};

function unzip(buffer) {
  return new Promise((resolve, reject) => {
    const files = {};
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      zip.on('entry', (entry) => {
        zip.openReadStream(entry, (e, stream) => {
          if (e) return reject(e);
          const chunks = [];
          stream.on('data', (c) => chunks.push(c));
          stream.on('end', () => { files[entry.fileName] = Buffer.concat(chunks); zip.readEntry(); });
        });
      });
      zip.on('end', () => resolve(files));
      zip.readEntry();
    });
  });
}

async function fill(overrides = {}) {
  const merged = await renderDocx(fixture, { ...data, ...overrides }, {});
  const files = await unzip(await fillPictures(merged, { dpi: DPI }));
  const xml = files['word/document.xml'].toString();
  const rels = files['word/_rels/document.xml.rels'].toString();
  const drawings = xml.match(/<w:drawing>[\s\S]*?<\/w:drawing>/g) ?? [];
  // the drawings whose alt text starts with the marker prefix
  const find = (prefix) => drawings.filter((d) => d.includes(`descr="${prefix}`));
  // the media file a drawing shows
  const media = (drawing) => {
    const id = drawing.match(/r:embed="([^"]+)"/)[1];
    const target = rels.match(new RegExp(`Id="${id}"[^>]*Target="([^"]+)"`))[1];
    return files['word/' + target];
  };
  return { files, xml, find, media };
}

const attr = (xml, tag, name) => Number(xml.match(new RegExp(`<${tag} [^>]*${name}="(\\d+)"`))[1]);

describe('picture fields', () => {
  it('replaces an image picture with the decoded data URI', async () => {
    const { find, media } = await fill();
    const [drawing] = find('NXIMG:');
    const bytes = media(drawing);
    assert.ok(bytes.equals(photo));
    assert.strictEqual(attr(drawing, 'wp:extent', 'cx'), EMU_PER_INCH);
  });

  it('draws a QR code with whole-dot modules that fits the placeholder', async () => {
    const { find, media } = await fill();
    const [drawing] = find('NXQR:');
    const png = PNG.sync.read(media(drawing));
    // the top-left finder pattern starts with a dark (opaque) run 7 modules wide
    let run = 0;
    while (png.data[run * 4 + 3] === 255) run++;
    const module = run / 7;
    assert.ok(Number.isInteger(module), `module ${module} dots`);
    assert.strictEqual(png.width % module, 0);
    assert.ok(png.width <= DPI, `width ${png.width} dots`);
    assert.strictEqual(attr(drawing, 'wp:extent', 'cx'), Math.round(png.width * EMU_PER_INCH / DPI));
    assert.strictEqual(attr(drawing, 'a:ext', 'cx'), Math.round(png.width * EMU_PER_INCH / DPI));
  });

  it('draws a barcode no taller than the placeholder', async () => {
    const { find, media } = await fill();
    const [drawing] = find('NXBAR:code128:');
    const png = PNG.sync.read(media(drawing));
    assert.ok(png.height <= DPI && png.height > DPI / 2, `height ${png.height} dots`);
    assert.strictEqual(attr(drawing, 'wp:extent', 'cy'), Math.round(png.height * EMU_PER_INCH / DPI));
  });

  it('fills a swatch picture with a solid colour', async () => {
    const { find, media } = await fill();
    const [drawing] = find('NXSW:#1F3A5F');
    const png = PNG.sync.read(media(drawing));
    for (let i = 0; i < png.data.length; i += 4) {
      assert.deepStrictEqual([...png.data.subarray(i, i + 4)], [0x1f, 0x3a, 0x5f, 255]);
    }
  });

  it('gives each picture of a loop its own image and id', async () => {
    const { find } = await fill();
    const loop = ['#111111', '#222222', '#333333'].map((hex) => find('NXSW:' + hex)[0]);
    assert.ok(loop.every(Boolean));
    const embeds = loop.map((d) => d.match(/r:embed="([^"]+)"/)[1]);
    const ids = loop.map((d) => d.match(/<wp:docPr id="(\d+)"/)[1]);
    assert.strictEqual(new Set(embeds).size, 3);
    assert.strictEqual(new Set(ids).size, 3);
  });

  it('removes an image picture whose value is empty', async () => {
    const { xml, find } = await fill({ photo: '' });
    assert.strictEqual(find('NXIMG:').length, 0);
    assert.strictEqual((xml.match(/<w:drawing>/g) ?? []).length, 6);
  });

  it('rejects a data URI that is not PNG or JPEG', async () => {
    await assert.rejects(fill({ photo: 'data:image/gif;base64,R0lGODlh' }),
      (e) => e instanceof RenderError && e.message === 'Unsupported image: image/gif');
  });

  it('never fetches a URL (FR-33)', async () => {
    await assert.rejects(fill({ photo: 'http://example.test/a.png' }),
      (e) => e instanceof RenderError && e.message === 'Images must be data URIs');
  });
});
