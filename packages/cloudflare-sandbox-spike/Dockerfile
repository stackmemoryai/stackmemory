FROM docker.io/cloudflare/sandbox:0.7.0-python

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    jq \
    ripgrep \
    sqlite3 \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@10

WORKDIR /workspace
