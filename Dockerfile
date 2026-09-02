FROM node:22-bookworm-slim

ARG TARGETARCH
ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_ENV=production
ENV CHROME_UID=1100 CHROME_GID=1100

# google-chrome-stable comes from Google's floating apt repo (newest only).
# Base image and npm dependencies are pinned; Chrome itself is not.
RUN apt-get update && apt-get install -y --no-install-recommends \
      wget gnupg ca-certificates tini xvfb \
      fonts-liberation fonts-noto-color-emoji \
      libasound2 libatk-bridge2.0-0 libatk1.0-0 libcairo2 libcups2 \
      libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 libgtk-3-0 libnspr4 \
      libnss3 libpango-1.0-0 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 \
      libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 \
      libxrender1 libxss1 libxtst6 xdg-utils util-linux \
  && if [ "$TARGETARCH" = "amd64" ] || [ "$(dpkg --print-architecture)" = "amd64" ]; then \
       wget -qO- https://dl.google.com/linux/linux_signing_key.pub \
         | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg && \
       echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
         > /etc/apt/sources.list.d/google-chrome.list && \
       apt-get update && apt-get install -y --no-install-recommends google-chrome-stable; \
     else \
       apt-get install -y --no-install-recommends chromium && \
       ln -sf /usr/bin/chromium /usr/local/bin/google-chrome && \
       ln -sf /usr/bin/chromium /usr/bin/google-chrome; \
     fi \
  && rm -rf /var/lib/apt/lists/*

RUN groupadd -r -g "$CHROME_GID" tallylamp \
 && useradd -r -u "$CHROME_UID" -m -d /home/tallylamp -g tallylamp -G audio,video tallylamp \
 && mkdir -p /data /tmp/.X11-unix \
 && chown -R tallylamp:tallylamp /data /home/tallylamp \
 && chmod 1777 /tmp/.X11-unix

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
COPY dashboard ./dashboard
COPY bin ./bin
RUN npx tsc && npm prune --omit=dev && chown -R tallylamp:tallylamp /app

COPY --chmod=0755 docker/entrypoint.sh /entrypoint.sh

ENV TALLYLAMP_DATA_DIR=/data
ENV HOST=0.0.0.0
ENV PORT=8080
EXPOSE 8080

ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/entrypoint.sh"]
