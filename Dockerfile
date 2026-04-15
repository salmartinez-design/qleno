FROM node:20-slim

WORKDIR /app

RUN npm install -g pnpm

COPY . .

RUN pnpm install --frozen-lockfile

RUN pnpm run build

CMD ["node", "artifacts/api-server/dist/index.mjs"]
