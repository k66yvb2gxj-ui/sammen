FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src ./src
COPY server ./server
RUN mkdir /data && chown node:node /data
USER node
ENV SAMMEN_BIND=0.0.0.0 SAMMEN_DATA_DIR=/data PORT=8787
EXPOSE 8787
CMD ["node", "server/room-server.mjs"]
