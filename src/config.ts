export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function parsePort(value: string, name: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer port`);
  const port = Number(value);
  if (port < 1 || port > 65535) throw new Error(`${name} must be between 1 and 65535`);
  return port;
}

export function databaseCredentials() {
  return {
    host: requiredEnv('DATABASE_HOST'),
    port: parsePort(requiredEnv('DATABASE_PORT'), 'DATABASE_PORT'),
    user: requiredEnv('DATABASE_USER'),
    password: requiredEnv('DATABASE_PASSWORD'),
    database: requiredEnv('DATABASE_NAME'),
  };
}
