import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const path = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(path)) {
  console.log('.env already exists; existing configuration was preserved.');
} else {
  let template = readFileSync(
    new URL('../.env.example', import.meta.url),
    'utf8',
  );
  for (const key of ['ADMIN_API_TOKEN', 'DB_PASSWORD', 'MYSQL_ROOT_PASSWORD']) {
    template = template.replace(
      new RegExp(`^${key}=$`, 'm'),
      `${key}=${randomBytes(32).toString('hex')}`,
    );
  }
  writeFileSync(path, template, { mode: 0o600 });
  console.log(
    'Created .env with random local secrets. Fill in the OSS settings before uploading.',
  );
}
