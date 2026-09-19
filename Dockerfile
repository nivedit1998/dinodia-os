FROM node@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 # node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl python3 python3-venv \
  && mkdir -p --mode=0755 /usr/share/keyrings \
  && curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg \
  && echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" > /etc/apt/sources.list.d/cloudflared.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends cloudflared \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY requirements-hive.lock requirements-hive.in ./
RUN python3 -m venv .venv-hive \
  && .venv-hive/bin/python -m pip install --disable-pip-version-check --no-cache-dir --require-hashes -r requirements-hive.lock \
  && .venv-hive/bin/python -c 'from apyhiveapi import Hive; print("Hive adapter ready")'

COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY docs ./docs
COPY THIRD_PARTY_NOTICES.md ./THIRD_PARTY_NOTICES.md

RUN node scripts/check-generated.mjs && npm prune --omit=dev

RUN mkdir -p /data && chown -R node:node /app /data
USER node

EXPOSE 8123 8099
CMD ["node", "src/server.js"]
