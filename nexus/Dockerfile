# Nexus document service. Build context = the fork root: docker build -f nexus/Dockerfile .
# Reads upstream files (package*.json, lib/, formatters/) and never changes them.

FROM node:22-bookworm-slim AS base
# Noto Sans covers ₹; Inter comes from Debian's fonts-inter. python3-uno runs Carbone's lib/converter.py. poppler-utils gives pdftoppm for /rasterize.
RUN apt-get update \
  && apt-get install -y --no-install-recommends libreoffice-writer-nogui python3-uno fontconfig fonts-noto-core fonts-noto-ui-core fonts-inter curl poppler-utils \
  && rm -rf /var/lib/apt/lists/* \
  && fc-cache -f
# On Linux Carbone starts soffice.bin directly and finds it on PATH
ENV PATH=/usr/lib/libreoffice/program:$PATH
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY nexus/package*.json nexus/

# Runs every test, the real LibreOffice renders included: npm run test:docker
FROM base AS test
RUN cd nexus && npm ci
COPY lib lib
COPY formatters formatters
COPY nexus nexus
WORKDIR /app/nexus
CMD ["npm","test"]

FROM base AS runtime
RUN cd nexus && npm ci --omit=dev
COPY lib lib
COPY formatters formatters
COPY nexus/server nexus/server
WORKDIR /app/nexus
ENV HOST=0.0.0.0 PORT=4000
USER node
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=3s --retries=6 CMD curl -fs http://127.0.0.1:4000/health || exit 1
CMD ["node","server/index.js"]
