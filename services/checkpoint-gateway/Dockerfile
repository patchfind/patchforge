FROM node:22-slim AS build
WORKDIR /srv
COPY package.json ./
RUN npm install
COPY . .
# No NEXT_PUBLIC_* build args: the client calls its own origin and Next proxies
# onward at runtime, so backend URLs are read from the server environment and
# changing one no longer means rebuilding the image.
RUN npm run build

FROM node:22-slim
WORKDIR /srv
ENV NODE_ENV=production
COPY --from=build /srv/.next/standalone ./
COPY --from=build /srv/.next/static ./.next/static
COPY --from=build /srv/public ./public

EXPOSE 3002
ENV PORT=3002 HOSTNAME=0.0.0.0
CMD ["node", "server.js"]
