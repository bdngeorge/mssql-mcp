import { getPool } from "../db.js";

export interface TableRef {
  schema: string;
  table: string;
}

export async function listTables(database: string): Promise<TableRef[]> {
  const pool = await getPool(database);
  const result = await pool.request().query<{ schema: string; table: string }>(
    `SELECT TABLE_SCHEMA AS [schema], TABLE_NAME AS [table]
     FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_TYPE = 'BASE TABLE'
     ORDER BY TABLE_SCHEMA, TABLE_NAME`
  );
  return result.recordset;
}
