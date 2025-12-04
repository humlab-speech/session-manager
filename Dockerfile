# Multi-stage build for session-manager
# This builds the application in a container without requiring Node.js on the host

# ============================================================================
# Stage 1: Dependencies
# ============================================================================
FROM node:20-bookworm-slim AS dependencies

WORKDIR /app

# Install git (needed for some npm packages that use git dependencies)
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package*.json ./

# Install all dependencies (including devDependencies for linting, if needed)
RUN npm ci

# ============================================================================
# Stage 2: Build (if there were a build step, but session-manager doesn't have one)
# ============================================================================
FROM node:20-bookworm-slim AS builder

WORKDIR /app

# Copy dependencies from previous stage
COPY --from=dependencies /app/node_modules ./node_modules

# Copy source code
COPY . .

# If there were a build step, it would go here
# RUN npm run build

# ============================================================================
# Stage 3: Runtime
# ============================================================================
FROM debian:bullseye-slim

# Set timezone
RUN rm -f /etc/localtime && ln -s /usr/share/zoneinfo/Europe/Stockholm /etc/localtime

# Install runtime dependencies
# Node.js, Docker CLI, ffmpeg, Python3, git (for simple-git package)
RUN apt-get update && apt-get install -y \
    curl \
    ca-certificates \
    gnupg \
    && mkdir -p /etc/apt/keyrings

# Install Node.js 20
RUN curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | \
    gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg && \
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" | \
    tee /etc/apt/sources.list.d/nodesource.list

# Install all runtime requirements
RUN apt-get update && apt-get install -y \
    nodejs \
    docker.io \
    ffmpeg \
    python3 \
    python3-pip \
    git \
    zlib1g-dev \
    nano \
    r-cran-git2r \
    libgit2-1.1 \
    libgit2-dev \
    && rm -rf /var/lib/apt/lists/*

# Set git environment variables
ENV GIT_SSL_NO_VERIFY=true
ENV GIT_DISCOVERY_ACROSS_FILESYSTEM=true

# Install whisper-script dependencies
WORKDIR /whisper-script
RUN git clone https://github.com/humlab-speech/whisper-script /whisper-script && \
    pip3 install -r requirements.txt

# Set up application
WORKDIR /session-manager

# Copy application files from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/src ./src

# Create logs directory
RUN mkdir -p logs

# Run as node user for security (optional, may need adjustment based on Docker socket permissions)
# USER node

CMD ["node", "src/index.js"]
