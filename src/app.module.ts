import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { validateEnvironment } from './config/environment.js';
import { databaseOptions } from './database/database-options.js';
import { AdminAuthGuard } from './auth/admin-auth.guard.js';
import { FilesModule } from './files/files.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnvironment }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        ...databaseOptions(
          Object.fromEntries(
            [
              'DB_HOST',
              'DB_PORT',
              'DB_USERNAME',
              'DB_PASSWORD',
              'DB_DATABASE',
            ].map((key) => [key, config.getOrThrow(key)]),
          ),
        ),
        retryAttempts: 3,
        retryDelay: 2000,
      }),
    }),
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 120 }]),
    FilesModule,
  ],
  controllers: [AppController],
  providers: [
    { provide: APP_GUARD, useClass: AdminAuthGuard },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
