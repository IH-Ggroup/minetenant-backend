# 任意のショートカットです。make がない環境では右側のコマンドを直接使えます。
# MySQLはPC上で起動してください。APIは Ctrl+C で終了します。

.PHONY: setup up test lint format routes

setup:
	npm run setup

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
