// One-off script: node test/fixtures/make-fixtures.js
// Builds the .docx fixtures from minimal OOXML parts.
const fs = require('fs');
const path = require('path');
const yazl = require('yazl');

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

function docx(file, bodyXml) {
  const zip = new yazl.ZipFile();
  const add = (name, xml) => zip.addBuffer(Buffer.from(xml), name);
  add('[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>');
  add('_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>');
  add('word/document.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<w:document xmlns:w="${W}"><w:body>${bodyXml}</w:body></w:document>`);
  add('word/_rels/document.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>');
  zip.end();
  zip.outputStream.pipe(fs.createWriteStream(path.join(__dirname, file)));
}

docx('hello.docx', '<w:p><w:r><w:t>Hello {d.name}</w:t></w:r></w:p>');
