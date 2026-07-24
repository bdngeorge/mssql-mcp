const FORBIDDEN_KEYWORDS = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "DROP",
  "ALTER",
  "CREATE",
  "TRUNCATE",
  "MERGE",
  "EXEC",
  "EXECUTE",
  "GRANT",
  "REVOKE",
  "INTO",
  "OPENROWSET",
  "OPENQUERY",
  "OPENDATASOURCE",
  "BULK",
  "BACKUP",
  "RESTORE",
  "SHUTDOWN",
];

// Blanks out '...'-quoted string literals (preserving length/position) so keyword
// and semicolon checks below don't false-positive on data that merely contains
// those words, and so position offsets stay valid for the trailing-semicolon strip.
function maskLiterals(text: string): string {
  return text.replace(/'(?:[^']|'')*'/g, (m) => " ".repeat(m.length));
}

/**
 * Validates that a query is a single, non-commented SELECT (or WITH ... SELECT)
 * statement. Throws with a descriptive message if not. Returns the query with
 * any single trailing semicolon stripped.
 */
export function assertReadOnlySelect(rawSql: string): string {
  const trimmed = rawSql.trim();
  if (!trimmed) {
    throw new Error("Query must not be empty.");
  }
  if (/--|\/\*/.test(trimmed)) {
    throw new Error("SQL comments are not allowed in read_query.");
  }

  const masked = maskLiterals(trimmed).replace(/;\s*$/, "");
  if (masked.includes(";")) {
    throw new Error("Multiple statements are not allowed in read_query.");
  }
  if (!/^\s*(SELECT|WITH)\b/i.test(masked)) {
    throw new Error("Only SELECT statements (optionally starting with WITH) are allowed.");
  }
  for (const keyword of FORBIDDEN_KEYWORDS) {
    if (new RegExp(`\\b${keyword}\\b`, "i").test(masked)) {
      throw new Error(`Keyword "${keyword}" is not allowed in read_query.`);
    }
  }

  return trimmed.replace(/;\s*$/, "");
}
