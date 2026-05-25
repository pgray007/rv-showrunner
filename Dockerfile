# Stage 1: build React app
FROM node:24-slim AS client-builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY src/client ./src/client
COPY vite.config.js tailwind.config.js postcss.config.js ./
RUN npm run build

# Stage 2: runtime
FROM node:24-slim AS runtime

RUN echo "deb http://deb.debian.org/debian bookworm main contrib non-free non-free-firmware" > /etc/apt/sources.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      curl \
      ffmpeg \
      libva2 \
      libva-drm2 \
      intel-media-va-driver-non-free \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=client-builder /app/dist ./dist
COPY src/server ./src/server
COPY profiles ./profiles
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

VOLUME ["/config", "/media", "/rv-ready", "/cache"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD curl -sf http://localhost:3000/health || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "src/server/index.js"]
