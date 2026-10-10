export function validateEnvironment(input: Record<string, unknown>) {
  const env = { ...input };
  const defaults: Record<string, string> = {
    NODE_ENV: 'development',
    PORT: '3000',
    DB_HOST: '127.0.0.1',
    DB_PORT: '3306',
    DB_USERNAME: 'image_view',
    DB_DATABASE: 'image_view',
    OSS_REGION: 'oss-cn-hangzhou',
    OSS_ENDPOINT: 'https://oss-cn-hangzhou.aliyuncs.com',
    OSS_STS_DURATION_SECONDS: '900',
    UPLOAD_URL_TTL_SECONDS: '900',
    PREVIEW_URL_TTL_SECONDS: '3600',
    MAX_FILE_SIZE_BYTES: '5368709120',
    UPLOAD_SESSION_TTL_SECONDS: '86400',
    CORS_ORIGINS: 'http://localhost:5173',
    ENABLE_SWAGGER: input.NODE_ENV === 'production' ? 'false' : 'true',
    CLEANUP_ENABLED: 'true',
  };
  for (const [key, value] of Object.entries(defaults)) env[key] ??= value;
  for (const key of ['ADMIN_API_TOKEN', 'DB_PASSWORD']) {
    if (typeof env[key] !== 'string' || !env[key])
      throw new Error(`${key} is required`);
  }
  if (String(env.ADMIN_API_TOKEN).length < 32)
    throw new Error('ADMIN_API_TOKEN must contain at least 32 characters');
  const numbers: Record<string, [number, number]> = {
    PORT: [1, 65535],
    DB_PORT: [1, 65535],
    OSS_STS_DURATION_SECONDS: [900, 3600],
    UPLOAD_URL_TTL_SECONDS: [60, 3600],
    PREVIEW_URL_TTL_SECONDS: [60, 86400],
    MAX_FILE_SIZE_BYTES: [1, 5368709120],
    UPLOAD_SESSION_TTL_SECONDS: [3600, 604800],
  };
  for (const [key, [min, max]] of Object.entries(numbers)) {
    const value = Number(env[key]);
    if (!Number.isSafeInteger(value) || value < min || value > max)
      throw new Error(`${key} must be an integer between ${min} and ${max}`);
    env[key] = value;
  }
  for (const key of ['ENABLE_SWAGGER', 'CLEANUP_ENABLED']) {
    if (!['true', 'false', true, false].includes(env[key] as string | boolean))
      throw new Error(`${key} must be true or false`);
    env[key] = env[key] === 'true' || env[key] === true;
  }
  for (const origin of String(env.CORS_ORIGINS)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin)
      throw new Error('CORS_ORIGINS must contain exact HTTP(S) origins');
  }
  const endpoint = new URL(String(env.OSS_ENDPOINT));
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.pathname !== '/'
  )
    throw new Error('OSS_ENDPOINT must be an HTTPS endpoint');
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(String(env.DB_DATABASE)))
    throw new Error('Invalid DB_DATABASE');
  if (
    env.OSS_BUCKET &&
    !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(String(env.OSS_BUCKET))
  )
    throw new Error('Invalid OSS_BUCKET');
  return env;
}
