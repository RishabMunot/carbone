const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const { buildApp } = require('../server/app');
const { render, RenderError } = require('../server/render');
const { version } = require('../package.json');

const TOKEN = 'secret';
const auth = { authorization: `Bearer ${TOKEN}` };
const template = fs.readFileSync(path.join(__dirname, 'fixtures/hello.docx'));

const stubRender = async () => ({ pdf: Buffer.from('%PDF-stub'), pageCount: 3 });
const stubFonts = async () => ['Arial', 'Code128'];

function app(overrides = {}) {
  return buildApp({ token: TOKEN, render: stubRender, fonts: stubFonts, ...overrides });
}

function post(a, payload, headers = auth) {
  return a.inject({ method: 'POST', url: '/render', headers, payload });
}

describe('document service HTTP layer', () => {
  it('GET /health answers without a token', async () => {
    const res = await app().inject({ method: 'GET', url: '/health' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.json(), { status: 'ok', version });
  });

  it('GET /health?x=1 still answers without a token', async () => {
    const res = await app().inject({ method: 'GET', url: '/health?x=1' });
    assert.strictEqual(res.statusCode, 200);
  });

  it('POST /render with a wrong token is 401', async () => {
    const res = await post(app(), { template: 'AAAA', data: {} }, { authorization: 'Bearer nope' });
    assert.strictEqual(res.statusCode, 401);
    assert.deepStrictEqual(res.json(), { message: 'Unauthorized' });
  });

  it('POST /render without the token is 401', async () => {
    const res = await post(app(), { template: 'AAAA', data: {} }, {});
    assert.strictEqual(res.statusCode, 401);
    assert.deepStrictEqual(res.json(), { message: 'Unauthorized' });
  });

  it('GET /fonts without the token is 401', async () => {
    const res = await app().inject({ method: 'GET', url: '/fonts' });
    assert.strictEqual(res.statusCode, 401);
  });

  it('POST /render without template is 400', async () => {
    const res = await post(app(), { data: {} });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.json().message);
  });

  it('POST /render with data that is not an object is 400', async () => {
    const res = await post(app(), { template: 'AAAA', data: 'x' });
    assert.strictEqual(res.statusCode, 400);
  });

  it('POST /render with an unsupported dpi is 400', async () => {
    const res = await post(app(), { template: 'AAAA', data: {}, dpi: 72 });
    assert.strictEqual(res.statusCode, 400);
  });

  it('POST /render returns the PDF with X-Page-Count', async () => {
    let received;
    const res = await post(
      app({ render: async (args) => { received = args; return stubRender(); } }),
      { template: template.toString('base64'), data: { name: 'Nexus' } }
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers['content-type'], 'application/pdf');
    assert.strictEqual(res.headers['x-page-count'], '3');
    assert.strictEqual(res.rawPayload.toString(), '%PDF-stub');
    assert.ok(Buffer.isBuffer(received.template) && received.template.equals(template));
    assert.deepStrictEqual(received.data, { name: 'Nexus' });
    assert.strictEqual(received.dpi, 300);
  });

  it('POST /render passes an allowed dpi through', async () => {
    let received;
    await post(
      app({ render: async (args) => { received = args; return stubRender(); } }),
      { template: 'AAAA', data: {}, dpi: 203 }
    );
    assert.strictEqual(received.dpi, 203);
  });

  it('a RenderError becomes 422 with its message', async () => {
    const res = await post(
      app({ render: async () => { throw new RenderError('bad tag'); } }),
      { template: 'AAAA', data: {} }
    );
    assert.strictEqual(res.statusCode, 422);
    assert.deepStrictEqual(res.json(), { message: 'bad tag' });
  });

  it('GET /fonts returns the font list', async () => {
    const res = await app().inject({ method: 'GET', url: '/fonts', headers: auth });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.json(), { fonts: ['Arial', 'Code128'] });
  });

  it('GET /fonts returns null where fc-list is missing', async () => {
    const res = await app({ fonts: async () => null }).inject({ method: 'GET', url: '/fonts', headers: auth });
    assert.deepStrictEqual(res.json(), { fonts: null });
  });

  it('skips the token check when no token is configured', async () => {
    const res = await post(app({ token: undefined }), { template: 'AAAA', data: {} }, {});
    assert.strictEqual(res.statusCode, 200);
  });
});

function hasLibreOffice() {
  const candidates = [
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    '/usr/bin/soffice',
    '/usr/local/bin/soffice',
    ...(process.env.PATH || '').split(path.delimiter).map((dir) => path.join(dir, 'soffice')),
  ];
  return candidates.some((file) => fs.existsSync(file));
}

describe('real render (needs LibreOffice)', function () {
  before(function () {
    if (!hasLibreOffice()) {
      console.log('      SKIPPED: LibreOffice (soffice) not found; this test runs inside the Docker image');
      this.skip(); // LibreOffice is not installed on the Mac on purpose
    }
  });

  after(() => new Promise((resolve) => require('../../lib/converter').exit(resolve)));

  it('renders hello.docx to a one-page PDF', async function () {
    this.timeout(60000);
    const { pdf, pageCount } = await render({ template, data: { name: 'Nexus' }, dpi: 300 });
    assert.strictEqual(pdf.subarray(0, 4).toString(), '%PDF');
    assert.strictEqual(pageCount, 1);
  });

  it('renders pictures.docx with every picture field to a one-page PDF', async function () {
    this.timeout(60000);
    const photo = new PNG({ width: 2, height: 2 });
    photo.data.fill(0xff);
    const { pdf, pageCount } = await render({
      template: fs.readFileSync(path.join(__dirname, 'fixtures/pictures.docx')),
      data: {
        photo: 'data:image/png;base64,' + PNG.sync.write(photo).toString('base64'),
        link: 'https://nexus.test/p/42',
        code: 'ABC-123',
        hex: '#1F3A5F',
        colours: [{ hex: '#111111' }, { hex: '#222222' }],
      },
      dpi: 203,
    });
    assert.strictEqual(pdf.subarray(0, 4).toString(), '%PDF');
    assert.strictEqual(pageCount, 1);
  });
});
