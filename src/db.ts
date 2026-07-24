import sql from "mssql";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseDatabaseNames(): string[] {
  const names = requireEnv("DB_NAMES")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (names.length === 0) {
    throw new Error("DB_NAMES must contain at least one database name.");
  }
  return names;
}

export const DATA_DATABASES: string[] = parseDatabaseNames();
export const ALL_DATABASES: string[] = [...DATA_DATABASES, "master"];

function buildConfig(database: string): sql.config {
  return {
    server: requireEnv("DB_SERVER"),
    port: Number(process.env.DB_PORT ?? 1433),
    database,
    user: requireEnv("DB_USER"),
    password: requireEnv("DB_PASSWORD"),
    options: {
      encrypt: (process.env.DB_ENCRYPT ?? "true").toLowerCase() === "true",
      trustServerCertificate:
        (process.env.DB_TRUST_SERVER_CERTIFICATE ?? "false").toLowerCase() === "true",
    },
    pool: {
      max: 5,
      min: 0,
      idleTimeoutMillis: 30000,
    },
    requestTimeout: 15000,
  };
}

const pools = new Map<string, Promise<sql.ConnectionPool>>();

export function getPool(database: string): Promise<sql.ConnectionPool> {
  if (!ALL_DATABASES.includes(database)) {
    throw new Error(
      `Unknown database "${database}". Allowed databases: ${ALL_DATABASES.join(", ")}`
    );
  }

  let poolPromise = pools.get(database);
  if (!poolPromise) {
    poolPromise = new sql.ConnectionPool(buildConfig(database)).connect().catch((err) => {
      pools.delete(database);
      throw err;
    });
    pools.set(database, poolPromise);
  }
  return poolPromise;
}

export async function closeAllPools(): Promise<void> {
  const entries = [...pools.entries()];
  pools.clear();
  await Promise.all(
    entries.map(async ([, poolPromise]) => {
      const pool = await poolPromise;
      await pool.close();
    })
  );
}
