# Multi-stage Dockerfile for Runway MCP Server
# Optimized for production deployment

# Stage 1: Builder
FROM node:20-alpine AS builder

# Install build dependencies
RUN apk add --no-cache python3 make g++ git

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies
RUN npm ci --only=production && \
    npm cache clean --force

# Copy source code
COPY src ./src

# Build TypeScript
RUN npm run build

# Remove dev dependencies and source
RUN npm prune --production && \
    rm -rf src tsconfig.json

# Stage 2: Runtime
FROM node:20-alpine AS runtime

# Install runtime dependencies
RUN apk add --no-cache \
    curl \
    tini \
    postgresql-client \
    && rm -rf /var/cache/apk/*

# Create non-root user
RUN addgroup -g 1001 -S stackmemory && \
    adduser -u 1001 -S stackmemory -G stackmemory

WORKDIR /app

# Copy built application from builder
COPY --from=builder --chown=stackmemory:stackmemory /app/package*.json ./
COPY --from=builder --chown=stackmemory:stackmemory /app/node_modules ./node_modules
COPY --from=builder --chown=stackmemory:stackmemory /app/dist ./dist

# Copy migration files
COPY --chown=stackmemory:stackmemory src/runway/database/migrations ./migrations

# Health check script
COPY --chown=stackmemory:stackmemory scripts/health-check.sh ./scripts/

# Set environment defaults
ENV NODE_ENV=production \
    PORT=8080 \
    LOG_LEVEL=info \
    MAX_OLD_SPACE_SIZE=2048

# Create necessary directories
RUN mkdir -p /app/logs /app/tmp && \
    chown -R stackmemory:stackmemory /app/logs /app/tmp

# Switch to non-root user
USER stackmemory

# Expose ports
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

# Use tini to handle signals properly
ENTRYPOINT ["/sbin/tini", "--"]

# Start the application
CMD ["node", "--max-old-space-size=2048", "dist/src/runway/index.js"]