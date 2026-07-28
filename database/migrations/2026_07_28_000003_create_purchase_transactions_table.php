<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Run the migrations.
     */
    public function up(): void
    {
        Schema::create('purchase_transactions', function (Blueprint $table) {
            $table->string('id')->primary();
            $table->string('request_id')->unique();
            $table->string('product_id')->index();
            $table->string('buyer_id');
            $table->string('seller_id');
            $table->string('source', 32)->index();
            $table->unsignedInteger('amount');
            $table->string('status', 32)->index();
            $table->timestamps();

            $table->index(['buyer_id', 'created_at']);
            $table->index(['seller_id', 'created_at']);

            $table->foreign('product_id')
                ->references('id')
                ->on('products')
                ->restrictOnDelete();
            $table->foreign('buyer_id')
                ->references('id')
                ->on('users')
                ->restrictOnDelete();
            $table->foreign('seller_id')
                ->references('id')
                ->on('users')
                ->restrictOnDelete();
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::dropIfExists('purchase_transactions');
    }
};
