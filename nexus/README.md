# Nexus document service

This fork of [Carbone](https://github.com/carboneio/carbone) 3.8.2 adds one thing: a small HTTP service, in this `nexus/` folder, that the Nexus ERP calls to turn a Word `.docx` template plus JSON data into a PDF. Everything the fork adds lives under `nexus/`; upstream files are not edited, so upstream Carbone updates merge cleanly.

Carbone is required by path (`require('../../lib/index')`). Its own dependencies come from `npm ci` at the fork root; the service's dependencies (Fastify, pdf-lib, yauzl, yazl) come from `npm install` in this folder.

## HTTP contract

- `GET /health` (no token) -> `200 { "status": "ok", "version": "<package.json version>" }`.
- `GET /fonts` (token) -> `200 { "fonts": string[] | null }`. The list holds the font family names `fc-list : family` reports, deduplicated and sorted. It is `null` where `fc-list` doesn't exist (macOS without fontconfig).
- `POST /render` (token), JSON `{ "template": "<base64 .docx>", "data": {...}, "dpi": 203 | 300 | 600 }` (`dpi` defaults to 300):
  - success -> `200 application/pdf`, header `X-Page-Count: <n>`;
  - Carbone or picture-field error -> `422 { "message": "<error text>" }`;
  - bad token -> `401 { "message": "Unauthorized" }`;
  - bad body -> `400 { "message": ... }`.
- Token: header `Authorization: Bearer <RENDER_TOKEN>`. It is checked only when `RENDER_TOKEN` is set, which it always is in Docker. The service listens on `HOST` (default `127.0.0.1`) and `PORT` (default `4000`), with a 30 MB body limit.

## Run locally

```
cd nexus
npm install
RENDER_TOKEN=dev npm run serve
```

Converting to PDF needs LibreOffice, which is not installed on the Mac on purpose; the Docker image has it. Without LibreOffice `POST /render` fails and the server cannot start its converter.

## Tests

```
cd nexus && npm test
```

The HTTP tests use stubs. The one real render test skips itself when LibreOffice (`soffice`) is missing; it runs inside the Docker image.

## Licence

The Carbone Community License stays as is (`../LICENSE.md`). This fork is used only inside Nexus.
