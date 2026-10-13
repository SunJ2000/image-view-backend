import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddFileCategory1791849600000 implements MigrationInterface {
  name = 'AddFileCategory1791849600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      "ALTER TABLE files ADD COLUMN category varchar(64) NOT NULL DEFAULT '随手', ADD INDEX idx_files_category (category)",
    );
    await queryRunner.query(
      "UPDATE files SET category = '随手' WHERE category = ''",
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE files DROP INDEX idx_files_category, DROP COLUMN category',
    );
  }
}
