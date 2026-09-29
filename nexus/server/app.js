const Fastify = require('fastify');
const { RenderError } = require('./render');
const { version } = require('../package.json');

const DPIS = [203, 300, 600];

function buildApp({ token, render, fonts }) {
  const app = Fastify({ bodyLimit: 30 * 1024 * 1024 });

  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/health' || token === undefined || token === '') return;
    if (req.headers.authorization !== `Bearer ${token}`) {
      return reply.code(401).send({ message: 'Unauthorized' });
    }
  });

  app.get('/health', async () => ({ status: 'ok', version }));

  app.get('/fonts', async () => ({ fonts: await fonts() }));

  app.post('/render', async (req, reply) => {
    const { template, data, dpi = 300 } = req.body ?? {};
    if (typeof template !== 'string') return reply.code(400).send({ message: 'template must be a base64 string' });
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      return reply.code(400).send({ message: 'data must be an object' });
    }
    if (!DPIS.includes(dpi)) return reply.code(400).send({ message: `dpi must be one of ${DPIS.join(', ')}` });

    try {
      const { pdf, pageCount } = await render({ template: Buffer.from(template, 'base64'), data, dpi });
      return reply.header('X-Page-Count', String(pageCount)).type('application/pdf').send(pdf);
    } catch (e) {
      if (e instanceof RenderError) return reply.code(422).send({ message: e.message });
      throw e;
    }
  });

  return app;
}

module.exports = { buildApp };
