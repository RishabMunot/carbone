// One-off script: node test/fixtures/make-fixtures.js
// Builds the .docx fixtures from minimal OOXML parts.
const fs = require('fs');
const path = require('path');
const yazl = require('yazl');
const { PNG } = require('pngjs');

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const PIC = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function docx(file, bodyXml, { rels = '', media = {} } = {}) {
  const zip = new yazl.ZipFile();
  const add = (name, xml) => zip.addBuffer(Buffer.from(xml), name);
  add('[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    (Object.keys(media).length ? '<Default Extension="png" ContentType="image/png"/>' : '') +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>');
  add('_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>');
  add('word/document.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<w:document xmlns:w="${W}" xmlns:wp="${WP}" xmlns:a="${A}" xmlns:pic="${PIC}" xmlns:r="${R}"><w:body>${bodyXml}</w:body></w:document>`);
  add('word/_rels/document.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`);
  for (const [name, bytes] of Object.entries(media)) zip.addBuffer(bytes, name);
  zip.end();
  zip.outputStream.pipe(fs.createWriteStream(path.join(__dirname, file)));
}

// An inline 25.4 mm (914400 EMU) square picture showing the placeholder; descr is its alt text (Word writes it twice).
function picture(id, descr) {
  return '<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">' +
    '<wp:extent cx="914400" cy="914400"/>' +
    `<wp:docPr id="${id}" name="Picture ${id}" descr="${descr}"/>` +
    `<a:graphic><a:graphicData uri="${PIC}"><pic:pic>` +
    `<pic:nvPicPr><pic:cNvPr id="${id}" name="Picture ${id}" descr="${descr}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    '<pic:blipFill><a:blip r:embed="rIdPh"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
    '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm>' +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>' +
    '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>';
}

// 10 x 10 grey PNG
function placeholderPng() {
  const png = new PNG({ width: 10, height: 10 });
  png.data.fill(0x80);
  for (let i = 3; i < png.data.length; i += 4) png.data[i] = 0xff;
  return PNG.sync.write(png);
}

docx('hello.docx', '<w:p><w:r><w:t>Hello {d.name}</w:t></w:r></w:p>');

docx('pictures.docx',
  `<w:p>${picture(1, '{d.photo:image}')}</w:p>` +
  `<w:p>${picture(2, '{d.link:qrcode}')}</w:p>` +
  `<w:p>${picture(3, '{d.code:barcode(code128)}')}</w:p>` +
  `<w:p>${picture(4, '{d.hex:swatch}')}</w:p>` +
  `<w:p>${picture(6, '{d.ean:barcode(ean13)}')}</w:p>` +
  `<w:p>${picture(5, '{d.colours[i].hex:swatch}')}</w:p>` +
  '<w:p><w:r><w:t>{d.colours[i+1].hex}</w:t></w:r></w:p>',
  {
    rels: `<Relationship Id="rIdPh" Type="${R}/image" Target="media/placeholder.png"/>`,
    media: { 'word/media/placeholder.png': placeholderPng() },
  });

// diagonal.pdf: a 20 x 20 mm page with one 0.3 pt diagonal line and the text "Ag" (for the rasterize edge test).
(async () => {
  const { PDFDocument, StandardFonts } = require('pdf-lib');
  const doc = await PDFDocument.create();
  const mm = (n) => (n / 25.4) * 72;
  const page = doc.addPage([mm(20), mm(20)]);
  page.drawLine({ start: { x: mm(2), y: mm(2) }, end: { x: mm(18), y: mm(18) }, thickness: 0.3 });
  page.drawText('Ag', { x: mm(3), y: mm(12), size: 14, font: await doc.embedFont(StandardFonts.Helvetica) });
  fs.writeFileSync(path.join(__dirname, 'diagonal.pdf'), await doc.save({ useObjectStreams: false }));
})();
