// Picture fields: a placeholder picture whose alt text holds a tag like {d.x:qrcode}.
// The formatters turn the value into a marker in the alt text; fillPictures swaps in the image.
const yauzl = require('yauzl');
const yazl = require('yazl');
const bwipjs = require('bwip-js');
const { PNG } = require('pngjs');
const carbone = require('../../lib/index');
const { RenderError } = require('./errors');

const EMU_PER_INCH = 914400;
const BARCODES = ['code128', 'ean13'];
const IMAGE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
const CONTENT_TYPES = { png: 'image/png', jpeg: 'image/jpeg' };

carbone.addFormatters({
  image: (v) => v ? 'NXIMG:' + v : 'NXIMG:',
  qrcode: (v) => 'NXQR:' + (v ?? ''),
  barcode: (v, type) => 'NXBAR:' + type + ':' + (v ?? ''),
  swatch: (v) => 'NXSW:' + (v ?? ''),
});

function unzip(buffer) {
  return new Promise((resolve, reject) => {
    const entries = [];
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      zip.on('error', reject);
      zip.on('entry', (entry) => {
        zip.openReadStream(entry, (e, stream) => {
          if (e) return reject(e);
          const chunks = [];
          stream.on('data', (c) => chunks.push(c));
          stream.on('end', () => { entries.push({ name: entry.fileName, data: Buffer.concat(chunks) }); zip.readEntry(); });
        });
      });
      zip.on('end', () => resolve(entries));
      zip.readEntry();
    });
  });
}

function zip(entries) {
  return new Promise((resolve, reject) => {
    const out = new yazl.ZipFile();
    for (const { name, data } of entries) out.addBuffer(data, name);
    out.end();
    const chunks = [];
    out.outputStream.on('data', (c) => chunks.push(c));
    out.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    out.outputStream.on('error', reject);
  });
}

const unescapeXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const attr = (xml, tag, name) => Number(xml.match(new RegExp(`<${tag}\\b[^>]*\\b${name}="(\\d+)"`))[1]);
const setAttr = (xml, tag, name, value) => xml.replace(new RegExp(`(<${tag}\\b[^>]*\\b${name}=")[^"]*"`), `$1${value}"`);
const pngSize = (png) => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });

async function drawCode(bcid, text, options) {
  try {
    return await bwipjs.toBuffer({ bcid, text, includetext: false, paddingwidth: 0, paddingheight: 0, ...options });
  } catch (e) {
    throw new RenderError(String(e.message ?? e));
  }
}

// A QR code or barcode whose modules are a whole number of dots at the target DPI.
async function codePng(bcid, text, cx, cy, dpi) {
  const dots = (emu) => Math.floor(emu / EMU_PER_INCH * dpi);
  const modules = pngSize(await drawCode(bcid, text, { scale: 1 })).width;
  const scale = Math.max(1, Math.floor(dots(cx) / modules));
  // bwip-js takes the bar height in mm (at 72 units an inch) and draws it one dot taller than asked
  const options = bcid === 'qrcode' ? { scale } : { scale, height: Math.floor((dots(cy) - 1) / scale) * 25.4 / 72 };
  return drawCode(bcid, text, options);
}

function swatchPng(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new RenderError(`Unsupported colour: ${hex}`);
  const png = new PNG({ width: 4, height: 4 });
  const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  for (let i = 0; i < png.data.length; i += 4) png.data.set([...rgb, 255], i);
  return PNG.sync.write(png);
}

function imageFile(uri) {
  if (!uri.startsWith('data:')) throw new RenderError('Images must be data URIs');
  const match = uri.match(/^data:image\/(png|jpeg);base64,/);
  if (!match) throw new RenderError(`Unsupported image: ${uri.slice(5).split(/[;,]/)[0]}`);
  return { ext: match[1], data: Buffer.from(uri.slice(match[0].length), 'base64') };
}

// The new image for a marked picture, or null to remove it. resize: set the extent from the PNG.
async function pictureFor(marker, cx, cy, dpi) {
  const [, kind, value] = marker.match(/^NX(IMG|QR|BAR|SW):([\s\S]*)$/) ?? [];
  if (kind === 'IMG') return value ? imageFile(value) : null;
  if (kind === 'SW') return value ? { ext: 'png', data: swatchPng(value) } : null;
  if (kind === 'QR') return value ? { ext: 'png', data: await codePng('qrcode', value, cx, cy, dpi), resize: true } : null;
  if (kind === 'BAR') {
    const [type, ...rest] = value.split(':');
    const text = rest.join(':');
    if (!BARCODES.includes(type)) throw new RenderError(`Unsupported barcode: ${type}`);
    return text ? { ext: 'png', data: await codePng(type, text, cx, cy, dpi), resize: true } : null;
  }
  return undefined; // not ours: leave the picture alone
}

async function fillPictures(docx, { dpi }) {
  const entries = await unzip(docx);
  const part = (name) => entries.find((e) => e.name === name);
  const doc = part('word/document.xml');
  const rels = part('word/_rels/document.xml.rels');
  const types = part('[Content_Types].xml');
  let xml = doc.data.toString();
  if (!xml.includes('descr="NX')) return docx;

  const drawings = xml.match(/<w:drawing>[\s\S]*?<\/w:drawing>/g) ?? [];
  const newRels = [];
  const usedExts = new Set();
  let n = 0;
  for (const drawing of drawings) {
    const descr = drawing.match(/<wp:docPr\b[^>]*\bdescr="(NX[^"]*)"/);
    if (!descr) continue;
    const cx = attr(drawing, 'wp:extent', 'cx');
    const cy = attr(drawing, 'wp:extent', 'cy');
    const picture = await pictureFor(unescapeXml(descr[1]), cx, cy, dpi);
    if (picture === undefined) continue;
    if (picture === null) { xml = xml.replace(drawing, () => ''); continue; }

    n++;
    const file = `nx${n}.${picture.ext}`;
    entries.push({ name: 'word/media/' + file, data: picture.data });
    newRels.push(`<Relationship Id="rIdNx${n}" Type="${IMAGE_REL}" Target="media/${file}"/>`);
    usedExts.add(picture.ext);
    let filled = setAttr(drawing, 'a:blip', 'r:embed', `rIdNx${n}`);
    filled = setAttr(filled, 'wp:docPr', 'id', 10000 + n);
    if (picture.resize) {
      const { width, height } = pngSize(picture.data);
      for (const tag of ['wp:extent', 'a:ext']) {
        filled = setAttr(filled, tag, 'cx', Math.round(width * EMU_PER_INCH / dpi));
        filled = setAttr(filled, tag, 'cy', Math.round(height * EMU_PER_INCH / dpi));
      }
    }
    xml = xml.replace(drawing, () => filled);
  }

  doc.data = Buffer.from(xml);
  rels.data = Buffer.from(rels.data.toString().replace('</Relationships>', newRels.join('') + '</Relationships>'));
  let typesXml = types.data.toString();
  for (const ext of usedExts) {
    if (!new RegExp(`Extension="${ext}"`, 'i').test(typesXml)) {
      typesXml = typesXml.replace('</Types>', `<Default Extension="${ext}" ContentType="${CONTENT_TYPES[ext]}"/></Types>`);
    }
  }
  types.data = Buffer.from(typesXml);
  return zip(entries);
}

module.exports = { fillPictures };
