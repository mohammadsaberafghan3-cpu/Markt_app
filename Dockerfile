FROM node:20-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends unzip && rm -rf /var/lib/apt/lists/*
COPY NOVAMARKET.zip /tmp/nova-market.zip
RUN unzip -q /tmp/nova-market.zip -d /tmp/nova-src \
 && cp -a /tmp/nova-src/nova_marketplace/. /app/ \
 && rm -rf /tmp/nova-src /tmp/nova-market.zip
ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV DATABASE_PATH=/data/nova.sqlite
ENV UPLOAD_DIR=/data/uploads
RUN mkdir -p /data/uploads && npm install --omit=dev
EXPOSE 3000
CMD ["npm", "start"]
