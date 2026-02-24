FROM oven/bun:1.2-debian AS base

# Install system dependencies for Playwright browsers
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Common dependencies
    libnss3 libnspr4 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libgbm1 libpango-1.0-0 libcairo2 libasound2 libxshmfence1 \
    libx11-xcb1 libxcb1 libxext6 libx11-6 libxcb-dri3-0 \
    # WebKit dependencies
    libwoff1 libvpx7 libwebpdemux2 libenchant-2-2 \
    libgstreamer-plugins-base1.0-0 libgstreamer1.0-0 \
    libharfbuzz-icu0 libhyphen0 libmanette-0.2-0 libflite1 \
    libgles2 gstreamer1.0-libav gstreamer1.0-plugins-bad \
    # Firefox dependencies
    libdbus-glib-1-2 \
    # Node.js for npx @playwright/mcp
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js (needed for npx @playwright/mcp)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install @playwright/mcp globally
RUN npm install -g @playwright/mcp

WORKDIR /app

# Install dependencies
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

# Install Playwright browsers
RUN bunx playwright install chromium firefox webkit

# Copy source
COPY src/ ./src/
COPY tsconfig.json ./

EXPOSE 3000

CMD ["bun", "run", "src/index.ts"]
