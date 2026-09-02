FROM node:24.14-alpine

WORKDIR /app

# Copy dependency manifests first for layer caching
COPY package.json package-lock.json ./

# Install production dependencies only
RUN npm ci --omit=dev

# Copy application source
COPY . .

# Create data directory for SQLite (persistent volume mounts here)
RUN mkdir -p data

# Expose the port (overridden by hosting platform)
EXPOSE 4000

# Increase heap size for memory-constrained environments
ENV NODE_OPTIONS="--max-old-space-size=256"
ENV STORAGE=memory

# Health check - longer interval for cold starts
HEALTHCHECK --interval=60s --timeout=10s --start-period=60s --retries=3 \
  CMD wget -qO- http://localhost:4000/health || exit 1

# Start the server
CMD ["node", "server.js"]
