import sql from "mssql";
import { getPool } from "../db.js";

export interface ObjectDefinitionResult {
  definition: string | null;
}

export async function getObjectDefinition(
  database: string,
  schemaName: string,
  objectName: string
): Promise<ObjectDefinitionResult> {
  const pool = await getPool(database);
  const result = await pool
    .request()
    .input("schema", sql.NVarChar, schemaName)
    .input("object", sql.NVarChar, objectName)
    .query<{ definition: string | null }>(
      `DECLARE @fullName NVARCHAR(776) = QUOTENAME(@schema) + N'.' + QUOTENAME(@object);
       SELECT OBJECT_DEFINITION(OBJECT_ID(@fullName)) AS [definition];`
    );
  return { definition: result.recordset[0]?.definition ?? null };
}
