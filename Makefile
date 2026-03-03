.PHONY: build up down logs backend-check frontend-build backend-dev frontend-dev

build:
	docker compose build

up:
	docker compose up -d

down:
	docker compose down

logs:
	docker compose logs -f

backend-check:
	cd backend && cargo check

frontend-build:
	cd frontend && npm run build

backend-dev:
	cd backend && cargo run

frontend-dev:
	cd frontend && npm run dev -- --host

