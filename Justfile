default:
    @just --list

dev:
    pnpm dev

migrate:
    pnpm migrate

seed:
    pnpm seed

test:
    pnpm test

eval suite="golden_v1":
    pnpm eval run --suite {{suite}}

bench-eval:
    pnpm bench-eval

lint:
    pnpm lint

typecheck:
    pnpm typecheck

up:
    docker compose up -d

down:
    docker compose down -v
