import { getPool } from "../db.js";
import { ServerConfig } from "../config.js";
import { assertReadOnlySelect } from "./sqlGuard.js";

const DEFAULT_MAX_ROWS = 200;
const HARD_MAX_ROWS = 1000;

export interface ReadQueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
}

export async function readQuery(
  serverCfg: ServerConfig,
  database: string,
  rawSql: string,
  requestedMaxRows?: number
): Promise<ReadQueryResult> {
  const query = assertReadOnlySelect(rawSql);
  const maxRows = Math.min(requestedMaxRows ?? DEFAULT_MAX_ROWS, HARD_MAX_ROWS);

  const pool = await getPool(serverCfg, database);
  const result = await pool.request().query(query);
  const rows: Record<string, unknown>[] = result.recordset ?? [];
  const truncated = rows.length > maxRows;

  return {
    rows: truncated ? rows.slice(0, maxRows) : rows,
    rowCount: Math.min(rows.length, maxRows),
    truncated,
  };
}
