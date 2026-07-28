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
        Schema::create('products', function (Blueprint $table) {
            $table->string('id')->primary();
            $table->string('store_id');
            $table->string('seller_id');
            $table->string('name');
            $table->text('description');
            $table->unsignedInteger('price');
            $table->unsignedInteger('stock');
            $table->string('category', 32)->index();
            $table->string('theme', 32);
            $table->string('emoji', 32);
            $table->timestamps();

            $table->index('created_at');
            $table->index(['store_id', 'created_at']);
            $table->index(['seller_id', 'created_at']);

            $table->foreign('store_id')
                ->references('id')
                ->on('stores')
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
        Schema::dropIfExists('products');
    }
};
