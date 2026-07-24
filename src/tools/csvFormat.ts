import type { ReadQueryResult } from "./readQuery.js";

function formatCsvValue(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function rowsToCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const columns = Object.keys(rows[0]);
  const lines = [columns.map(csvEscape).join(",")];
  for (const row of rows) {
    lines.push(columns.map((col) => csvEscape(formatCsvValue(row[col]))).join(","));
  }
  return lines.join("\n");
}

export function formatReadQueryResult(result: ReadQueryResult, maxRowsForJson: number): string {
  if (result.rowCount <= maxRowsForJson) {
    return JSON.stringify({ format: "json", ...result });
  }
  return `format: csv\nrowCount: ${result.rowCount}\ntruncated: ${result.truncated}\n\n${rowsToCsv(result.rows)}`;
}
