import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddFileVisibility1791763200000 implements MigrationInterface {
  name = 'AddFileVisibility1791763200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      "ALTER TABLE files ADD COLUMN visibility varchar(7) NOT NULL DEFAULT 'private', ADD INDEX idx_files_public_gallery (visibility, status, mediaType, createdAt, id)",
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE files DROP INDEX idx_files_public_gallery, DROP COLUMN visibility',
    );
  }
}
