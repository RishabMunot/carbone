const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { promisify } = require('util');
const carbone = require('../../lib/index');
const { PDFDocument } = require('pdf-lib');

class RenderError extends Error {}

const renderDocx = promisify(carbone.render);
const convert = promisify(carbone.convert);

// Merge to .docx first, then convert: picture fields slot in between the two steps.
async function render({ template, data }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-'));
  try {
    const file = path.join(dir, 'template.docx');
    await fs.writeFile(file, template);
    let docx;
    try {
      docx = await renderDocx(file, data, {});
    } catch (e) {
      throw new RenderError(String(e.message ?? e));
    }
    const pdf = await convert(docx, { convertTo: 'pdf', extension: 'docx' });
    const pageCount = (await PDFDocument.load(pdf)).getPageCount();
    return { pdf, pageCount };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

module.exports = { render, RenderError };
