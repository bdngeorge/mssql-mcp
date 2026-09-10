import sql from "mssql";
import { ServerConfig } from "./config.js";

function buildConfig(serverCfg: ServerConfig, database: string): sql.config {
  return {
    server: serverCfg.server,
    port: serverCfg.port,
    database,
    user: serverCfg.user,
    password: serverCfg.password,
    options: {
      encrypt: serverCfg.encrypt,
      trustServerCertificate: serverCfg.trustServerCertificate,
    },
    pool: {
      max: 5,
      min: 0,
      idleTimeoutMillis: 30000,
    },
    requestTimeout: 15000,
  };
}

const pools = new Map<string, Map<string, Promise<sql.ConnectionPool>>>();

export function getPool(serverCfg: ServerConfig, database: string): Promise<sql.ConnectionPool> {
  const allowed = [...serverCfg.databases, "master"];
  if (!allowed.includes(database)) {
    throw new Error(
      `Unknown database "${database}" for server "${serverCfg.nickname}". Allowed databases: ${allowed.join(", ")}`
    );
  }

  let byDatabase = pools.get(serverCfg.nickname);
  if (!byDatabase) {
    byDatabase = new Map();
    pools.set(serverCfg.nickname, byDatabase);
  }

  let poolPromise = byDatabase.get(database);
  if (!poolPromise) {
    const currentByDatabase = byDatabase;
    poolPromise = new sql.ConnectionPool(buildConfig(serverCfg, database)).connect().catch((err) => {
      currentByDatabase.delete(database);
      throw err;
    });
    byDatabase.set(database, poolPromise);
  }
  return poolPromise;
}

export async function closeAllPools(): Promise<void> {
  const entries = [...pools.values()].flatMap((byDatabase) => [...byDatabase.values()]);
  pools.clear();
  await Promise.all(
    entries.map(async (poolPromise) => {
      const pool = await poolPromise;
      await pool.close();
    })
  );
}
