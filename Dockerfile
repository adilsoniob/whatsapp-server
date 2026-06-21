FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    libnspr4 \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    libatspi2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN PUPPETEER_SKIP_DOWNLOAD=true npm ci --omit=dev --no-audit --no-fund
COPY . .

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

EXPOSE 8080
CMD ["node", "src/index.js"]
