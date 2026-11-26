FROM node:22.23.4-alpine AS deps
WORKDIR /app
ARG NPM_TOKEN
COPY package*.json ./
RUN echo "@smit9313:registry=https://npm.pkg.github.com" > .npmrc && echo "//npm.pkg.github.com/:_authToken=$NPM_TOKEN" >> .npmrc && npm pkg delete scripts.prepare && npm install --omit=dev && rm -f .npmrc

FROM node:22.23.4-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package*.json ./
COPY . .
RUN chown -R appuser:appgroup /app
USER appuser
EXPOSE 8080
CMD ["node", "server.js"]
