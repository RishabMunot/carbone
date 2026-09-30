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
- `POST /rasterize` (token), JSON `{ "pdf": "<base64>", "dpi": 203 | 300 | 600, "encoding": "z64" | "hex" }` (all three required) -> `200 { "pages": [ { "widthMm", "heightMm", "widthDots", "heightDots", "gfa" } ] }`:
  - `gfa` is one complete ZPL `^GFA,<bytes>,<bytes>,<bytes per row>,<data>` field: a 1-bit bitmap (no anti-aliasing, 1 = black dot) of the page at that dpi, rows padded to whole bytes. `z64` data is `:Z64:<base64 of zlib>:<CRC-16/XMODEM (poly 0x1021, init 0) of the base64, 4 uppercase hex digits>`; `hex` is uppercase hex;
  - page size comes from the PDF's MediaBox; pages are rasterized by `pdftoppm -mono` (poppler-utils, in the Docker image only), at most 1,000 pages, each `pdftoppm` run limited to 60 s;
  - not a readable PDF, too many pages, or a `pdftoppm` failure -> `422 { "message" }`; bad token -> 401; bad body -> 400.
- Token: header `Authorization: Bearer <RENDER_TOKEN>`. It is checked only when `RENDER_TOKEN` is set, which it always is in Docker. The service listens on `HOST` (default `127.0.0.1`) and `PORT` (default `4000`), with a 30 MB body limit.

## Run locally

```
cd nexus
npm install
RENDER_TOKEN=dev npm run serve
```

Converting to PDF needs LibreOffice, and `POST /rasterize` needs `pdftoppm`; neither is installed on the Mac on purpose, the Docker image has both. Without LibreOffice `POST /render` fails and the server cannot start its converter.

## Docker image

`nexus/Dockerfile` (build context = the fork root, ignore rules in `nexus/Dockerfile.dockerignore`) installs LibreOffice Writer, poppler-utils (for `/rasterize`), Noto and Inter fonts on `node:22-bookworm-slim`. Stages: `test` runs every test; `runtime` (the default) serves on port 4000 as user `node`.

To run the image beside Nexus (locally `pnpm services:up`, and on the VM), see `infra/README.md` in the Nexus repo.

## Tests

```
cd nexus && npm test          # on the Mac: the real render and rasterize tests skip themselves
cd nexus && npm run test:docker   # inside the image: every test, the LibreOffice renders included
```

The HTTP tests use stubs. The real render and rasterize tests skip themselves when LibreOffice (`soffice`) or `pdftoppm` is missing; they run inside the Docker image.

## Releasing

Tag the commit `nexus-vX.Y.Z` and push the tag (`git tag -a nexus-v1.1.0 -m … && git push origin nexus-v1.1.0`). There is no registry: each machine builds the image itself. On the VM, check out the tag in `../nexus-carbone` and rerun `pnpm services:up` in Nexus (see Nexus `infra/README.md`). Before tagging, run `npm run test:docker` here: it runs every test inside the image.

## Known limits

- `/rasterize` has no memory bound: it holds every page's bitmap in memory, so keep 600 dpi runs small. A PDF's `/Rotate` is not reflected in `widthMm` / `heightMm`.
- Picture fields are filled only in the document body (`word/document.xml`); pictures in headers and footers are left as placeholders.
- Coming from Carbone Enterprise: `{d.x:barcode(qrcode)}` works and draws the same QR code as `{d.x:qrcode}`. A bare `{d.x}` as a picture's alt text (Enterprise's image syntax) is not supported: write `{d.x:image}`.

## Licence

The Carbone Community License stays as is (`../LICENSE.md`). This fork is used only inside Nexus.
