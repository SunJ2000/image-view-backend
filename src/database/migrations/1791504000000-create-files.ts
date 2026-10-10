import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateFiles1791504000000 implements MigrationInterface {
  name = 'CreateFiles1791504000000';
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE files (
      id char(36) NOT NULL PRIMARY KEY,
      originalName varchar(255) NOT NULL, displayName varchar(255) NOT NULL,
      bucket varchar(63) NOT NULL, objectKey varchar(512) NOT NULL, stagingKey varchar(512) NOT NULL,
      mimeType varchar(127) NOT NULL, mediaType varchar(10) NOT NULL,
      sizeBytes bigint NOT NULL, status varchar(10) NOT NULL DEFAULT 'pending', etag varchar(128) NULL,
      pendingExpiresAt datetime(3) NOT NULL, credentialsExpireAt datetime(3) NULL,
      createdAt datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updatedAt datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), deletedAt datetime(3) NULL,
      UNIQUE KEY uq_files_object (objectKey), UNIQUE KEY uq_files_staging (stagingKey),
      KEY idx_files_status_created (status, createdAt), KEY idx_files_status_expires (status, pendingExpiresAt)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE files');
  }
}
