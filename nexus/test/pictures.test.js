const assert = require('assert');
const path = require('path');
const { promisify } = require('util');
const yauzl = require('yauzl');
const bwipjs = require('bwip-js');
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
  ean: '5901234123457',
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

async function fill(overrides = {}, dpi = DPI) {
  const merged = await renderDocx(fixture, { ...data, ...overrides }, {});
  const files = await unzip(await fillPictures(merged, { dpi }));
  const xml = files['word/document.xml'].toString();
  const rels = files['word/_rels/document.xml.rels'].toString();
  const drawings = xml.match(/<w:drawing>[\s\S]*?<\/w:drawing>/g) ?? [];
  // the drawings made from fixture picture k (a loop repeats picture 5)
  const find = (k) => drawings.filter((d) => d.includes(`name="Picture ${k}"`));
  // the media file a drawing shows
  const target = (drawing) => {
    const id = drawing.match(/r:embed="([^"]+)"/)[1];
    return rels.match(new RegExp(`Id="${id}"[^>]*Target="([^"]+)"`))[1];
  };
  const media = (drawing) => files['word/' + target(drawing)];
  return { files, xml, find, target, media };
}

// A symbol drawn with whole-dot modules the way fillPictures sizes it for a 25.4 mm placeholder.
async function drawnLike(bcid, text, dpi) {
  const options = { bcid, text, includetext: false, paddingwidth: 0, paddingheight: 0 };
  const { width } = PNG.sync.read(await bwipjs.toBuffer({ ...options, scale: 1 }));
  return PNG.sync.read(await bwipjs.toBuffer({ ...options, scale: Math.max(1, Math.floor(dpi / width)) }));
}

// The lengths of the dark (opaque) and light runs along a pixel row.
function runs(png, y) {
  const out = [];
  for (let x = 0; x < png.width; x++) {
    const dark = png.data[(y * png.width + x) * 4 + 3] === 255;
    if (out.length && out[out.length - 1].dark === dark) out[out.length - 1].length++;
    else out.push({ dark, length: 1 });
  }
  return out;
}

const attr = (xml, tag, name) => Number(xml.match(new RegExp(`<${tag} [^>]*${name}="(\\d+)"`))[1]);

describe('picture fields', () => {
  it('replaces an image picture with the decoded data URI', async () => {
    const { find, media } = await fill();
    const [drawing] = find(1);
    const bytes = media(drawing);
    assert.ok(bytes.equals(photo));
    assert.strictEqual(attr(drawing, 'wp:extent', 'cx'), EMU_PER_INCH);
  });

  it('draws a QR code with whole-dot modules that fits the placeholder', async () => {
    const { find, media } = await fill();
    const [drawing] = find(2);
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
    const [drawing] = find(3);
    const png = PNG.sync.read(media(drawing));
    assert.ok(png.height <= DPI && png.height > DPI / 2, `height ${png.height} dots`);
    assert.strictEqual(attr(drawing, 'wp:extent', 'cy'), Math.round(png.height * EMU_PER_INCH / DPI));
  });

  it('fills a swatch picture with a solid colour', async () => {
    const { find, media } = await fill();
    const [drawing] = find(4);
    const png = PNG.sync.read(media(drawing));
    for (let i = 0; i < png.data.length; i += 4) {
      assert.deepStrictEqual([...png.data.subarray(i, i + 4)], [0x1f, 0x3a, 0x5f, 255]);
    }
  });

  it('gives each picture of a loop its own image and id', async () => {
    const { xml, find, media } = await fill();
    const loop = find(5);
    const colours = loop.map((d) => [...PNG.sync.read(media(d)).data.subarray(0, 3)]);
    assert.deepStrictEqual(colours, [[0x11, 0x11, 0x11], [0x22, 0x22, 0x22], [0x33, 0x33, 0x33]]);
    const embeds = loop.map((d) => d.match(/r:embed="([^"]+)"/)[1]);
    const ids = loop.map((d) => d.match(/<wp:docPr id="(\d+)"/)[1]);
    assert.strictEqual(new Set(embeds).size, 3);
    assert.strictEqual(new Set(ids).size, 3);
    const allIds = xml.match(/<wp:docPr id="\d+"/g);
    assert.strictEqual(new Set(allIds).size, allIds.length);
  });

  it('removes an image picture whose value is empty', async () => {
    const { xml, find } = await fill({ photo: '' });
    assert.strictEqual(find(1).length, 0);
    assert.strictEqual((xml.match(/<w:drawing>/g) ?? []).length, 7);
  });

  it('stores a JPEG image as .jpeg', async () => {
    // fillPictures stores the bytes as given and never decodes them: SOI + EOI markers are enough here
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const { files, find, target, media } = await fill({ photo: 'data:image/jpeg;base64,' + jpeg.toString('base64') });
    const [drawing] = find(1);
    assert.match(target(drawing), /^media\/nx\d+\.jpeg$/);
    assert.ok(media(drawing).equals(jpeg));
    assert.match(files['[Content_Types].xml'].toString(), /<Default Extension="jpeg" ContentType="image\/jpeg"\/>/);
  });

  it('draws an EAN-13 barcode with whole-dot bars at 300 dpi', async () => {
    const { find, media } = await fill({}, 300);
    const [drawing] = find(6);
    const bars = runs(PNG.sync.read(media(drawing)), 0).filter((r) => r.dark);
    const module = bars[0].length; // the start guard's first bar is one module
    assert.ok(bars.every((r) => r.length % module === 0), bars.map((r) => r.length).join(','));
    assert.ok(module > 1);
    assert.ok(attr(drawing, 'wp:extent', 'cx') <= EMU_PER_INCH);
    assert.ok(attr(drawing, 'wp:extent', 'cy') <= EMU_PER_INCH);
  });

  it('keeps a " in a QR code or barcode value exact and the XML valid', async () => {
    const text = '12" ruler';
    const { xml, find, media } = await fill({ link: text, code: text });
    for (const tag of xml.match(/<(wp:docPr|pic:cNvPr)\b[^>]*>/g)) {
      assert.match(tag, /^<[\w:]+(\s+[\w:]+="[^"<>]*")*\/>$/);
    }
    const qr = PNG.sync.read(media(find(2)[0]));
    assert.ok(qr.data.equals((await drawnLike('qrcode', text, DPI)).data));
    const bar = PNG.sync.read(media(find(3)[0]));
    assert.deepStrictEqual(runs(bar, 0), runs(await drawnLike('code128', text, DPI), 0));
  });

  it('clears the alt text of every filled picture', async () => {
    const { xml } = await fill();
    const alts = xml.match(/descr="[^"]*"/g);
    assert.strictEqual(alts.length, 16); // docPr + cNvPr of 8 pictures
    assert.ok(alts.every((a) => a === 'descr=""'), alts.find((a) => a !== 'descr=""'));
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
