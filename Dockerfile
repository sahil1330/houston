# Backend-only image: the HOUSTON API (mission state, physics, Claude loop, SSE).
# The UI is hosted separately (Vercel) and calls this server cross-origin.
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY shared ./shared
COPY server ./server
COPY tsconfig.json ./
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787
EXPOSE 8787
CMD ["npx", "tsx", "server/index.ts"]
