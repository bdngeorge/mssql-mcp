import sql from "mssql";
import { getPool } from "../db.js";

export interface ColumnInfo {
  column: string;
  dataType: string;
  nullable: string;
  defaultValue: string | null;
  maxLength: number | null;
}

export async function describeTable(
  database: string,
  schemaName: string,
  tableName: string
): Promise<ColumnInfo[]> {
  const pool = await getPool(database);
  const result = await pool
    .request()
    .input("schema", sql.NVarChar, schemaName)
    .input("table", sql.NVarChar, tableName)
    .query<ColumnInfo>(
      `SELECT COLUMN_NAME AS [column], DATA_TYPE AS [dataType],
              IS_NULLABLE AS [nullable], COLUMN_DEFAULT AS [defaultValue],
              CHARACTER_MAXIMUM_LENGTH AS [maxLength]
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = @schema AND TABLE_NAME = @table
       ORDER BY ORDINAL_POSITION`
    );
  return result.recordset;
}
