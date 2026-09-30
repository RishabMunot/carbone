const { execFile } = require('child_process');
const { promisify } = require('util');
const carbone = require('../../lib/index');
const { buildApp } = require('./app');
const { render } = require('./render');
const { rasterize } = require('./rasterize');

const run = promisify(execFile);

// Font family names known to fontconfig, or null where fc-list doesn't exist.
async function fonts() {
  try {
    const { stdout } = await run('fc-list', [':', 'family']);
    const families = stdout.split('\n').flatMap((line) => line.split(',')).map((name) => name.trim()).filter(Boolean);
    return [...new Set(families)].sort();
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

carbone.set({ factories: 2, startFactory: true });

buildApp({ token: process.env.RENDER_TOKEN, render, fonts, rasterize })
  .listen({ host: process.env.HOST ?? '127.0.0.1', port: Number(process.env.PORT ?? 4000) })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
