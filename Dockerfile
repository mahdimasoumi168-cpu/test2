FROM node:20-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY --chown=node:node . .
RUN mkdir -p /app/data && chown -R node:node /app
ENV NODE_ENV=production
EXPOSE 3000
VOLUME ["/app/data"]
USER node
CMD ["node", "server.js"]
