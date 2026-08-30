FROM node:22-slim AS build
WORKDIR /srv
COPY package.json tsconfig.json ./
RUN npm install
COPY src ./src
RUN npm run build

FROM node:22-slim
WORKDIR /srv
COPY package.json ./
RUN npm install --omit=dev
COPY --from=build /srv/dist ./dist

EXPOSE 3000 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
