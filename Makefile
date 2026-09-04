# 任意のショートカットです。make がない環境では右側のコマンドを直接使えます。
# MySQLはPC上で起動してください。APIは Ctrl+C で終了します。

.PHONY: setup up test lint format routes

setup:
	composer run setup

up:
	composer run dev

test:
	composer test

lint:
	composer lint

format:
	composer format

routes:
	php artisan route:list --path=api
