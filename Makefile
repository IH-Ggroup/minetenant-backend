# Docker Composeを使う場合の任意コマンドです。
# PHP・Composer・MySQLをローカルに用意する場合はREADMEの手順を使用します。
DOCKER_COMPOSE := docker compose

.PHONY: setup up down test lint format fresh routes

setup:
	@test -f .env || cp .env.example .env
	$(DOCKER_COMPOSE) build app
	$(DOCKER_COMPOSE) up -d --wait mysql
	$(DOCKER_COMPOSE) exec -T mysql mysql -uroot -proot -e "\
		CREATE DATABASE IF NOT EXISTS minetenant_test \
			CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; \
		GRANT ALL PRIVILEGES ON minetenant_test.* TO 'minetenant'@'%';"
	$(DOCKER_COMPOSE) run --rm app composer install
	$(DOCKER_COMPOSE) run --rm app php artisan key:generate --force
	$(DOCKER_COMPOSE) run --rm app php artisan migrate:fresh --seed --force

up:
	$(DOCKER_COMPOSE) up app

down:
	$(DOCKER_COMPOSE) down

test:
	$(DOCKER_COMPOSE) run --rm \
		-e APP_ENV=testing \
		-e DB_CONNECTION=mysql \
		-e DB_HOST=mysql \
		-e DB_DATABASE=minetenant_test \
		-e DB_USERNAME=minetenant \
		-e DB_PASSWORD=minetenant \
		app php artisan test

lint:
	$(DOCKER_COMPOSE) run --rm app ./vendor/bin/pint --test

format:
	$(DOCKER_COMPOSE) run --rm app ./vendor/bin/pint

fresh:
	$(DOCKER_COMPOSE) run --rm app php artisan migrate:fresh --seed

routes:
	$(DOCKER_COMPOSE) run --rm app php artisan route:list --path=api
