FROM node:24.14-alpine

WORKDIR /app

# Build timestamp, surfaced by /health and /ready via getBuildInfo().
# Declared with no default so an unset value reports as null rather than as a
# plausible-looking constant. This used to be a hardcoded literal in
# railway.json's buildArgs that no ARG here ever consumed, so every deploy
# reported the same fictional build time. Build identity comes from
# RAILWAY_GIT_COMMIT_SHA, which Railway provides at runtime.
ARG BUILD_TIME=""
ENV BUILD_TIME=${BUILD_TIME}

# Copy dependency manifests first for layer caching
COPY package.json package-lock.json ./

# Install production dependencies only
RUN npm ci --omit=dev

# Copy application source
COPY . .

# Create data directory for SQLite (persistent volume mounts here) and ensure writable by non-root user
RUN mkdir -p data && chown -R node:node /app

# Expose the port (overridden by hosting platform)
EXPOSE 4000

# Production defaults
ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=256"
# STORAGE defaults to sqlite; override with STORAGE=memory for ephemeral environments

# Create non-root user (node image already provides 'node' user)
USER node

# Health check - longer interval for cold starts.
# Probes /ready, not /health: /health cannot fail, so it would report a container
# as healthy while its storage backend is unreachable. /ready returns 503 in that
# case. --start-period covers the cold start before the first probe counts.
HEALTHCHECK --interval=60s --timeout=10s --start-period=60s --retries=3 \
  CMD wget -qO- http://localhost:4000/ready || exit 1

# Start the server
CMD ["node", "server.js"]
