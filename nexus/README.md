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

## Docker image

`nexus/Dockerfile` (build context = the fork root, ignore rules in `nexus/Dockerfile.dockerignore`) installs LibreOffice Writer, Noto and Inter fonts on `node:22-bookworm-slim`. Stages: `test` runs every test; `runtime` (the default) serves on port 4000 as user `node`.

To run the image beside Nexus (locally `pnpm services:up`, and on the VM), see `infra/README.md` in the Nexus repo.

## Tests

```
cd nexus && npm test          # on the Mac: the real render tests skip themselves
cd nexus && npm run test:docker   # inside the image: every test, the LibreOffice renders included
```

The HTTP tests use stubs. The real render tests skip themselves when LibreOffice (`soffice`) is missing; they run inside the Docker image.

## Releasing

Tag the commit `nexus-vX.Y.Z` and push the tag (`git tag nexus-v1.0.0 && git push origin nexus-v1.0.0`). The workflow `.github/workflows/nexus-image.yml` runs the tests inside the image, then builds `linux/amd64` and `linux/arm64` and pushes `ghcr.io/rishabmunot/nexus-carbone:X.Y.Z`. Nexus picks a version with `NEXUS_CARBONE_TAG=X.Y.Z` in `infra/.env`.

## Known limits

- Picture fields are filled only in the document body (`word/document.xml`); pictures in headers and footers are left as placeholders.
- Coming from Carbone Enterprise: `{d.x:barcode(qrcode)}` works and draws the same QR code as `{d.x:qrcode}`. A bare `{d.x}` as a picture's alt text (Enterprise's image syntax) is not supported: write `{d.x:image}`.

## Licence

The Carbone Community License stays as is (`../LICENSE.md`). This fork is used only inside Nexus.
