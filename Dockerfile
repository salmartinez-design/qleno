FROM node:20-slim

WORKDIR /app

RUN npm install -g pnpm

COPY . .

RUN pnpm install --frozen-lockfile

RUN pnpm run build

# Startup script runs drizzle-kit push against the live DB to apply
# any pending additive schema changes, then boots the api-server. See
# scripts/docker-startup.sh for the full rationale + safety story.
CMD ["sh", "/app/scripts/docker-startup.sh"]
