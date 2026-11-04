# Multi-stage build for session-manager
# This builds the application in a container without requiring Node.js on the host

# Every stage uses the same Node image, so the runtime always runs node_modules
# with the Node that built them — in dev mode too, where the bind-mounted host
# node_modules is installed through this image (see ./visp.py npm).
ARG NODE_IMAGE=docker.io/library/node:24.22.2-trixie-slim

# ============================================================================
# Stage 1: Dependencies
# ============================================================================
FROM ${NODE_IMAGE} AS dependencies

WORKDIR /app

# Install git (needed for some npm packages that use git dependencies)
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package*.json ./

# Install the production dependencies from package-lock.json. Dev mode does not
# use these: it bind-mounts the source tree, node_modules included (installed
# with devDependencies through './visp.py npm session-manager -- ci'), over
# /session-manager, and runs nodemon from there.
# --ignore-scripts: the only lifecycle script is "prepare: husky" (a dev git-hook
# installer); no production dependency has an install script.
RUN npm ci --omit=dev --ignore-scripts

# ============================================================================
# Stage 2: Runtime
# ============================================================================
FROM ${NODE_IMAGE}

# Runtime requirements, and nothing else:
# - ffmpeg: converts uploads and transcription input (execFileSync "ffmpeg")
# - git: simple-git commits project repositories
# - tzdata: local time in logs
# Containers are managed through the Podman API socket (node-docker-api), so no
# docker/podman CLI is installed. 'upgrade' first: 'install' only fetches the
# packages it names, so the rest of the base would stay as old as the tag.
RUN apt-get update && \
    apt-get upgrade -y --no-install-recommends && \
    apt-get install -y --no-install-recommends ffmpeg git tzdata ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Set timezone
RUN ln -sf /usr/share/zoneinfo/Europe/Stockholm /etc/localtime

ENV GIT_DISCOVERY_ACROSS_FILESYSTEM=true

# Set up application
WORKDIR /session-manager

# Copy application files
COPY --from=dependencies /app/node_modules ./node_modules
COPY package*.json ./
COPY src ./src

# Create logs directory
RUN mkdir -p logs

# Run as node user for security (optional, may need adjustment based on Docker socket permissions)
# USER node

CMD ["node", "src/index.js"]
