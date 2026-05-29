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

RUN sed -i 's/Components: main/Components: main contrib non-free non-free-firmware/g' /etc/apt/sources.list.d/debian.sources \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      curl \
      ffmpeg \
      libva2 \
      libva-drm2 \
 && if [ "$(dpkg --print-architecture)" = "amd64" ]; then \
      apt-get install -y --no-install-recommends intel-media-va-driver-non-free; \
    fi \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

ENV CONFIG_ROOT=/config \
    SOURCE_MEDIA_ROOT=/media \
    OUTPUT_ROOT=/rv-ready \
    CACHE_ROOT=/cache \
    HW_DEVICE=/dev/dri/renderD128 \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    PORT=3000

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
