# ViTransfer - Two-Image Docker Build
# - App image: Next.js standalone server + Prisma migrations (no ffmpeg, no TS sources)
# - Worker image: FFmpeg + TS worker runtime

# ========================================
# Common base (no ffmpeg)
# ========================================
FROM node:24.11.1-alpine3.23 AS base-common

RUN npm install -g npm@latest

# Use a stable Alpine mirror (helps in environments where dl-cdn.alpinelinux.org DNS fails)
RUN sed -i 's|https://dl-cdn.alpinelinux.org/alpine|https://mirrors.edge.kernel.org/alpine|g' /etc/apk/repositories

# Security: Update Alpine to latest packages
RUN set -e; \
    for i in 1 2 3 4 5; do \
        apk update && apk upgrade --no-cache && break; \
        echo "apk update/upgrade failed (attempt $i), retrying..."; \
        sleep 2; \
    done; \
    apk update

# OpenSSL 3.x compatibility for Prisma engines
RUN apk add --no-cache \
    openssl \
    openssl-dev

# Utilities + user switching
RUN apk add --no-cache \
    bash \
    curl \
    ca-certificates

# ========================================
# Worker base (adds FFmpeg)
# ========================================
FROM base-common AS base-worker

RUN apk add --no-cache \
    ffmpeg \
    ffmpeg-libs \
    fontconfig \
    ttf-dejavu \
    && apk add --no-cache --upgrade \
        cjson \
        libsndfile \
        giflib \
        orc \
    && echo "FFmpeg version:" && ffmpeg -version

# ========================================
# Dependencies (full) for build + worker
# ========================================
FROM base-worker AS deps-full
WORKDIR /app

COPY package.json package-lock.json* ./
COPY prisma ./prisma

RUN npm install --legacy-peer-deps

RUN echo "Running npm security audit..." && \
    if audit_output="$(npm audit --audit-level=high 2>&1)"; then \
        echo "$audit_output"; \
    else \
        echo "$audit_output"; \
        if echo "$audit_output" | grep -qiE "ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|network"; then \
            echo "WARN: npm audit failed due to network/registry connectivity; continuing build."; \
        else \
            echo "SECURITY ALERT: High or critical vulnerabilities found (or audit failed unexpectedly)!"; \
            echo "Run 'npm audit' locally to see details and 'npm audit fix' to resolve."; \
            exit 1; \
        fi; \
    fi

# ========================================
# Builder (Next standalone)
# ========================================
FROM base-common AS builder
WORKDIR /app

COPY --from=deps-full /app/node_modules ./node_modules
COPY . .

RUN npx prisma generate

ARG APP_VERSION
ENV NEXT_PUBLIC_APP_VERSION=${APP_VERSION}
ENV SKIP_ENV_VALIDATION=1
ENV NEXT_PHASE=phase-production-build
RUN npm run build

# ========================================
# App runtime deps (prod only)
# Needed for: `prisma migrate deploy` + health checks + entrypoint readiness checks
# ========================================
FROM base-common AS deps-app
WORKDIR /app

COPY package.json package-lock.json* ./
COPY prisma ./prisma

ENV NODE_ENV=production
RUN npm install --omit=dev --legacy-peer-deps

# ========================================
# App image
# ========================================
FROM base-common AS app
WORKDIR /app

ENV NODE_ENV=production

RUN addgroup -g 911 app && \
    adduser -D -u 911 -G app -h /app app

# Runtime deps only (prod)
COPY --chown=app:app --from=deps-app /app/node_modules ./node_modules

# Required for `npm run start:standalone`
COPY --chown=app:app --from=builder /app/package.json ./package.json

# Next build output
COPY --chown=app:app --from=builder /app/public ./public
COPY --chown=app:app --from=builder /app/.next ./.next

# Prisma migrations need schema + migrations directory
COPY --chown=app:app --from=builder /app/prisma ./prisma

# Standalone server expects `public/` and `.next/static` relative to `.next/standalone`
# Next will try to write runtime cache (notably image optimizer) under `.next/cache`.
# Ensure these paths exist and are writable by the runtime user.
RUN mkdir -p /app/.next/standalone/.next/cache && \
    if [ ! -e /app/.next/standalone/.next/static ]; then ln -s /app/.next/static /app/.next/standalone/.next/static; fi && \
    if [ ! -e /app/.next/standalone/public ]; then ln -s /app/public /app/.next/standalone/public; fi

RUN chown -R app:app /app/.next/standalone && \
    chmod -R u+rwX,go+rX /app/.next/standalone/.next/cache

COPY docker-entrypoint.sh /usr/local/bin/
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh && chmod +x /usr/local/bin/docker-entrypoint.sh

RUN chmod -R a+rX /app/.next /app/node_modules /app/public /app/prisma

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:4321/api/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})" || exit 1

EXPOSE 4321

ENV PORT=4321
ENV HOSTNAME="0.0.0.0"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["npm", "run", "start:standalone"]

# ========================================
# Worker image
# ========================================
FROM base-worker AS worker
WORKDIR /app

ENV NODE_ENV=production

RUN addgroup -g 911 app && \
    adduser -D -u 911 -G app -h /app app

COPY --chown=app:app --from=deps-full /app/node_modules ./node_modules
COPY --chown=app:app --from=builder /app/prisma ./prisma
COPY --chown=app:app --from=builder /app/src ./src
COPY --chown=app:app --from=builder /app/tsconfig.json ./tsconfig.json
COPY --chown=app:app --from=builder /app/package.json ./package.json
COPY --chown=app:app --from=builder /app/worker.mjs ./worker.mjs

COPY docker-entrypoint.sh /usr/local/bin/
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh && chmod +x /usr/local/bin/docker-entrypoint.sh

RUN chmod -R a+rX /app/src /app/node_modules /app/prisma

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["npm", "run", "worker"]
