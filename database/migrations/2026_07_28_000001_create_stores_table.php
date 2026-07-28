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
        Schema::create('stores', function (Blueprint $table) {
            $table->string('id')->primary();
            $table->string('owner_id')->unique();
            $table->string('name');
            $table->text('description');
            $table->unsignedSmallInteger('level')->default(1);
            $table->unsignedInteger('points')->default(0);
            $table->string('sync_status', 32)
                ->default('offline')
                ->index();
            $table->timestamps();

            $table->foreign('owner_id')
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
        Schema::dropIfExists('stores');
    }
};
