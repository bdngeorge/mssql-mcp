import fs from "node:fs";
import { z } from "zod";

const serverConfigSchema = z
  .object({
    nickname: z.string().min(1),
    isDefault: z.boolean().optional(),
    server: z.string().min(1),
    port: z.number().int().positive().optional().default(1433),
    user: z.string().min(1),
    password: z.string().min(1),
    encrypt: z.boolean().optional().default(true),
    trustServerCertificate: z.boolean().optional().default(false),
    databases: z.array(z.string().min(1)).min(1),
    defaultDatabase: z.string().min(1).optional(),
  })
  .superRefine((cfg, ctx) => {
    if (new Set(cfg.databases).size !== cfg.databases.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Server "${cfg.nickname}": databases must not contain duplicates.`,
      });
    }
    if (cfg.defaultDatabase && !cfg.databases.includes(cfg.defaultDatabase)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Server "${cfg.nickname}": defaultDatabase "${cfg.defaultDatabase}" is not in its databases list [${cfg.databases.join(", ")}].`,
      });
    }
  });

const rootConfigSchema = z.object({
  servers: z.array(serverConfigSchema).min(1),
});

export type ServerConfig = z.infer<typeof serverConfigSchema>;

function validateServerList(servers: ServerConfig[]): void {
  const nicknames = servers.map((s) => s.nickname);
  const dupes = nicknames.filter((n, i) => nicknames.indexOf(n) !== i);
  if (dupes.length > 0) {
    throw new Error(`Duplicate server nickname(s) in config: ${[...new Set(dupes)].join(", ")}`);
  }

  const defaults = servers.filter((s) => s.isDefault);
  if (defaults.length > 1) {
    throw new Error(
      `Multiple servers marked isDefault: ${defaults.map((s) => s.nickname).join(", ")}. Exactly one server may be isDefault.`
    );
  }
  if (defaults.length === 0 && servers.length > 1) {
    throw new Error(
      `No server marked isDefault, and there is more than one server configured (${nicknames.join(", ")}). Mark exactly one server "isDefault": true.`
    );
  }
}

function loadConfig(): ServerConfig[] {
  const path = process.env.MCP_CONFIG_PATH ?? "/app/config.json";
  let raw: string;
  try {
    raw = fs.readFileSync(path, "utf-8");
  } catch (err) {
    throw new Error(
      `Failed to read MCP config file at "${path}" (set MCP_CONFIG_PATH to override): ${err instanceof Error ? err.message : String(err)}`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse MCP config file at "${path}" as JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  const result = rootConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Invalid MCP config file at "${path}":\n${result.error.issues.map((i) => `- ${i.path.join(".")}: ${i.message}`).join("\n")}`
    );
  }

  validateServerList(result.data.servers);
  return result.data.servers;
}

export const SERVERS: ServerConfig[] = loadConfig();

export const DEFAULT_SERVER: ServerConfig =
  SERVERS.find((s) => s.isDefault) ?? SERVERS[0];

export function findServer(nickname: string): ServerConfig | undefined {
  return SERVERS.find((s) => s.nickname === nickname);
}

export function resolveServer(nickname: string | undefined): ServerConfig {
  if (nickname === undefined) {
    return DEFAULT_SERVER;
  }
  const found = findServer(nickname);
  if (!found) {
    throw new Error(
      `Unknown server "${nickname}". Valid server nicknames: ${SERVERS.map((s) => s.nickname).join(", ")}`
    );
  }
  return found;
}

export function resolveDataDatabase(serverCfg: ServerConfig, database: string | undefined): string {
  if (database === undefined) {
    return serverCfg.defaultDatabase ?? serverCfg.databases[0];
  }
  if (!serverCfg.databases.includes(database)) {
    throw new Error(
      `Unknown database "${database}" for server "${serverCfg.nickname}". Allowed databases: ${serverCfg.databases.join(", ")}`
    );
  }
  return database;
}

export function resolveDatabase(serverCfg: ServerConfig, database: string | undefined): string {
  if (database === undefined) {
    return serverCfg.defaultDatabase ?? serverCfg.databases[0];
  }
  const allowed = [...serverCfg.databases, "master"];
  if (!allowed.includes(database)) {
    throw new Error(
      `Unknown database "${database}" for server "${serverCfg.nickname}". Allowed databases: ${allowed.join(", ")}`
    );
  }
  return database;
}
