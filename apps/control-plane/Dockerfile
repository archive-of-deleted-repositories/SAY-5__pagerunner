FROM node:20-bookworm-slim AS base
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml* package.json ./
COPY apps/control-plane/package.json apps/control-plane/
COPY packages/shared/package.json packages/shared/
COPY packages/agent-tools/package.json packages/agent-tools/
COPY packages/db/package.json packages/db/
COPY packages/sdk/package.json packages/sdk/
RUN pnpm install --frozen-lockfile=false

FROM deps AS build
COPY . .
RUN pnpm --filter @pagerunner/shared --filter @pagerunner/agent-tools \
        --filter @pagerunner/db --filter @pagerunner/control-plane build

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
EXPOSE 3000
CMD ["node", "apps/control-plane/dist/main.js"]
