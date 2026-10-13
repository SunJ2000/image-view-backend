import type { MigrationInterface, QueryRunner } from 'typeorm';

export class NormalizeFileCategory1791936000000 implements MigrationInterface {
  name = 'NormalizeFileCategory1791936000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      "UPDATE files SET category = '随手' WHERE category = '' OR category IS NULL",
    );
    await queryRunner.query(
      "ALTER TABLE files MODIFY COLUMN category varchar(64) NOT NULL DEFAULT '随手'",
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      "ALTER TABLE files MODIFY COLUMN category varchar(64) NOT NULL DEFAULT ''",
    );
  }
}
