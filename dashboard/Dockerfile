FROM node:22-alpine
RUN apk add --no-cache util-linux
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY dashboard ./dashboard
COPY projects*.json ./
USER node
EXPOSE 8787
CMD ["node", "dashboard/server.mjs"]
