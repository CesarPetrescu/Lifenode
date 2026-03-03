.PHONY: up down logs build rebuild dev

build:
	docker compose build

rebuild:
	docker compose build --no-cache

up:
	docker compose up -d

down:
	docker compose down

logs:
	docker compose logs -f

dev:
	uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload

