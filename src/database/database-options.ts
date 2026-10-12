import type { DataSourceOptions } from 'typeorm';
import { FileEntity } from '../files/file.entity.js';
import { CreateFiles1791504000000 } from './migrations/1791504000000-create-files.js';
import { AddFileVisibility1791763200000 } from './migrations/1791763200000-add-file-visibility.js';

export function databaseOptions(
  env: Record<string, unknown>,
): Extract<DataSourceOptions, { type: 'mysql' | 'mariadb' }> {
  return {
    type: 'mysql',
    host: String(env.DB_HOST),
    port: Number(env.DB_PORT),
    username: String(env.DB_USERNAME),
    password: String(env.DB_PASSWORD),
    database: String(env.DB_DATABASE),
    charset: 'utf8mb4_unicode_ci',
    timezone: 'Z',
    entities: [FileEntity],
    migrations: [CreateFiles1791504000000, AddFileVisibility1791763200000],
    migrationsRun: true,
    synchronize: false,
    logging: false,
    extra: { connectionLimit: 10 },
  };
}
