# 任意のショートカットです。make がない環境では右側のコマンドを直接使えます。
# MySQLはPC上で起動してください。APIは Ctrl+C で終了します。

.PHONY: bootstrap setup doctor up test lint format routes

bootstrap:
	npm run db:bootstrap

setup:
	npm run setup

doctor:
	npm run doctor

up:
	npm run dev

test:
	npm test

lint:
	npm run lint

format:
	npm run format

routes:
	@echo "API routes: docs/api.md"
