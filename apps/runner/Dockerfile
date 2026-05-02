FROM mcr.microsoft.com/playwright:v1.45.1-jammy AS base
WORKDIR /app
RUN npm install -g pnpm@10.33.0

FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml* package.json ./
COPY apps/runner/package.json apps/runner/
COPY packages/shared/package.json packages/shared/
COPY packages/agent-tools/package.json packages/agent-tools/
COPY packages/db/package.json packages/db/
RUN pnpm install --frozen-lockfile=false

FROM deps AS build
COPY . .
RUN pnpm --filter @pagerunner/shared --filter @pagerunner/agent-tools \
        --filter @pagerunner/db --filter @pagerunner/runner build

FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
CMD ["node", "apps/runner/dist/main.js"]
