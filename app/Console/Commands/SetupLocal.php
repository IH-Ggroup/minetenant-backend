<?php

namespace App\Console\Commands;

use App\Models\Product;
use App\Models\PurchaseTransaction;
use App\Models\Store;
use App\Models\User;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use RuntimeException;
use Throwable;

class SetupLocal extends Command
{
    protected $signature = 'app:setup-local';

    protected $description = '既存データを保持してローカル開発用のDBを準備する';

    public function handle(): int
    {
        if (! app()->environment('local')) {
            $this->error('このコマンドは APP_ENV=local の開発環境専用です。');

            return self::FAILURE;
        }

        if (config('database.default') !== 'mysql') {
            $this->error('.env の DB_CONNECTION を mysql にしてください。');

            return self::FAILURE;
        }

        try {
            DB::connection()->getPdo();
        } catch (Throwable) {
            $this->error('MySQLに接続できません。MySQLの起動、DBの作成、.env の DB_* を確認してください。');

            return self::FAILURE;
        }

        // 設定済みの暗号化キーは変更しません。
        if (blank(config('app.key'))) {
            $result = $this->call('key:generate');

            if ($result !== self::SUCCESS || blank(config('app.key'))) {
                $this->error('.env に APP_KEY= の行があるか、書き込みできるかを確認してください。');

                return self::FAILURE;
            }
        }

        // migrate:fresh は使わず、未実行のマイグレーションだけを適用します。
        if ($this->call('migrate', ['--no-interaction' => true]) !== self::SUCCESS) {
            return self::FAILURE;
        }

        // サンプル在庫・アカウントを毎回上書きしないよう、空のDBだけに初期データを入れます。
        $hasData = User::query()->exists() || Store::query()->exists()
            || Product::query()->exists() || PurchaseTransaction::query()->exists();

        if (! $hasData) {
            try {
                DB::transaction(function (): void {
                    if ($this->call('db:seed', ['--no-interaction' => true]) !== self::SUCCESS) {
                        throw new RuntimeException('初期データの作成に失敗しました。');
                    }
                });
            } catch (Throwable) {
                $this->error('初期データの作成に失敗したため取り消しました。設定を確認して再実行してください。');

                return self::FAILURE;
            }
        }

        $this->info($hasData ? '既存データを保持しました。' : '初期データを作成しました。');
        $this->info('準備完了。composer run dev でAPIを起動してください。');

        return self::SUCCESS;
    }
}
