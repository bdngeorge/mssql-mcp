# mssql-mcp

A minimal, read-only [MCP](https://modelcontextprotocol.io) server for Microsoft SQL Server, served over Streamable HTTP from a persistent Docker container.

Five tools exist — there is no insert/update/drop/create tool in the code at all. All four data tools take optional `server`/`database` parameters that default to whichever server/database is marked default in the config file:

- **list_servers** — no parameters. Lists every configured server (`nickname`, whether it's the default, its `databases`, and its `defaultDatabase`), so an agent (or you, through one) can discover what's available instead of guessing from tool descriptions. `master` is always additionally available on `read_query`/`get_object_definition` but is omitted from the lists here.
- **list_tables** (`server?`, `database?`) — lists base tables (schema + name). `database` must be one of that server's configured databases — `master` is not accepted here.
- **describe_table** (`server?`, `database?`, `schema`, `table`) — lists columns for a given table (name, type, nullable, default, max length). Same `database` restriction as `list_tables`.
- **read_query** (`server?`, `database?`, `sql`, `maxRows?`, `maxRowsForJson?`) — runs a single `SELECT` (or `WITH ... SELECT`) statement. Anything else (DDL, DML, multiple statements, comments) is rejected before it reaches the database. Results are capped at `maxRows` (default 200, hard cap 1000). `database` accepts that server's configured databases *and* `master`.

  Output format is chosen automatically based on result size: if the returned row count is `<= maxRowsForJson` (default **50**), the response is compact JSON (`{"format":"json","rows":[...],"rowCount":n,"truncated":bool}`), preserving exact types (numbers, booleans, `null`, ISO date strings). Above that threshold, the response switches to CSV (a few `key: value` metadata lines, a blank line, then the CSV body) to save tokens on large results — all values become text, and SQL `NULL` is written as the literal unquoted token `NULL` (distinguishable from an empty string). If a call needs JSON type fidelity for a bigger result, pass a larger `maxRowsForJson` to keep it in JSON. Caveat: a real value that is literally the string `"NULL"` is indistinguishable from a SQL NULL in CSV mode.
- **get_object_definition** (`server?`, `database?`, `schema`, `object`) — returns the SQL source (`CREATE PROCEDURE`/`VIEW`/`FUNCTION`/`TRIGGER` text) for an object, via `OBJECT_DEFINITION()`/`OBJECT_ID()`, using the login's VIEW DEFINITION permission. Returns `null` if the object doesn't exist or isn't visible. `database` accepts that server's configured databases *and* `master`.

If `server` is omitted, the server marked `"isDefault": true` in the config file is used (or the only server, if there's just one). If `database` is omitted, that server's `defaultDatabase` is used (or the first entry in its `databases` list, if unset). An unknown `server` nickname or `database` name returns a clear error listing the valid options for that server — it never silently falls back.

`master` is intentionally excluded from `list_tables`/`describe_table` (meant for browsing app schema) but usable in `read_query`/`get_object_definition` for querying system/catalog metadata and object definitions.

This is defense-in-depth on top of the SQL login itself, which should already be a read-only user with reader access to the relevant data databases plus reader + VIEW DEFINITION access to `master`.

## Setup

1. Copy `config.example.json` to `config.json` and fill in one or more SQL Server instances:
   ```
   cp config.example.json config.json
   ```
   Each entry in `servers` is:
   - `nickname` — required, unique short name agents use to pick this server (e.g. `"prod"`).
   - `isDefault` — optional `true`/`false`. Exactly one server must be marked default when there's more than one; with a single server it's implicitly the default. The server refuses to start if this is ambiguous (zero or multiple servers marked default among 2+).
   - `server` / `port` — where the SQL Server instance lives (`port` defaults to `1433`).
   - `user` / `password` — the read-only SQL login for that server.
   - `encrypt` — defaults to `true`; leave it unless your SQL Server doesn't support TLS.
   - `trustServerCertificate` — defaults to `false`; set `true` only if the instance uses a self-signed certificate you trust.
   - `databases` — array of the databases that login can read (e.g. `["Db1", "Db2"]`). `master` is always available in addition to these and does not need to be listed.
   - `defaultDatabase` — optional; must be one of `databases`. If unset, the first entry in `databases` is the default.

   `config.json` is gitignored — it holds credentials, same as `.env`.

2. Copy `.env.example` to `.env` (or to `.env.local` if you're running without a reverse proxy — see [Running locally without a reverse proxy](#running-locally-without-a-reverse-proxy)):
   ```
   cp .env.example .env
   ```
   - `MCP_CONFIG_PATH` — path to the config file. Defaults to `/app/config.json`, which matches the volume mount below — you shouldn't need to change this for Docker. Only override it for non-Docker local runs (e.g. `./config.json`).
   - `MCP_PORT` — port the server listens on inside the container (defaults to `8090` if unset). Leave at `8199` to match the host port mapping in both `docker-compose.yml` and `docker-compose.local.yml`.
   - `MCP_USE_AUTH` — `1` to require the bearer token below, `0` to disable auth entirely. **Leaving it unset behaves like `0` (auth disabled)** — always set it explicitly. Keep this `1` whenever the server is reachable by anything other than yourself (i.e. the proxied setup below). Only set it to `0` for the local/trusted-network setup.
   - `MCP_AUTH_TOKEN` — a random shared secret clients must send as `Authorization: Bearer <token>`. Generate one with `openssl rand -hex 32`. Required if `MCP_USE_AUTH=1` (the server refuses to start without it); can be left empty if `MCP_USE_AUTH=0`.

3. Build and start the container. Both compose files mount `./config.json` into the container read-only, so it must exist at the repo root before starting — the server fails fast (and the container exits) if it's missing or invalid. There are two ways to run it — pick one:

   - **Behind a reverse proxy (recommended)** — uses `docker-compose.yml` + `.env`, binds only to `127.0.0.1:8199` on the host, and needs a reverse proxy in front of it (see below) for any external access:
     ```
     docker compose up --build -d
     ```
   - **Without a reverse proxy** — uses `docker-compose.local.yml` + `.env.local`; see [Running locally without a reverse proxy](#running-locally-without-a-reverse-proxy) below before using this.
     ```
     docker compose -f docker-compose.local.yml up --build -d
     ```

   Either way it runs continuously (`restart: unless-stopped`). Only one can run at a time — both use `container_name: mssql-mcp`.

4. Check logs:
   ```
   docker compose logs -f mssql-mcp
   ```

## Reverse proxy

This container binds only to `127.0.0.1:8199` on the host (`docker-compose.yml`) — it expects a reverse proxy, run separately from this project, to front it for any access beyond the host itself. `docker-compose.yml` declares the `proxy` network as `external: true`, so a reverse proxy just needs to join that same Docker network and forward to `mssql-mcp:8199`:
```
docker network create proxy   # once, before starting either this or the proxy
```

`examples/mssql-mcp.example.conf` in this repo is a minimal nginx `location` block proxying `/mcp`, in case that's what's fronting it — adapt it (or the equivalent) for whatever reverse proxy is actually in use. Access control here is entirely the bearer token's job (below), regardless of what's in front of it — the proxy doesn't need auth of its own, though nothing stops you from layering it on.

## Running locally without a reverse proxy

For a trusted host/network where TLS termination and a reverse proxy aren't needed, use `docker-compose.local.yml` instead of `docker-compose.yml`. It mounts the same `./config.json` at the repo root, so that still needs to exist first:

```
cp config.example.json config.json   # if you haven't already
cp .env.example .env.local
docker compose -f docker-compose.local.yml up --build -d
```

This differs from the proxied setup in a few ways:

- It reads `.env.local` instead of `.env`.
- It publishes port `8199` on **all interfaces** (`0.0.0.0`), not just `127.0.0.1` — anything that can reach the host on the network can reach `/mcp` directly, over plain HTTP (no TLS).
- It uses its own bridge network (`mssql-loc`) instead of the shared external `proxy` network, so `docker network create proxy` isn't needed for this path.

Because there's no reverse proxy in front to terminate TLS or require a token, set `MCP_USE_AUTH=0` only if the host/network is trusted; otherwise leave `MCP_USE_AUTH=1` and set `MCP_AUTH_TOKEN` even in this mode.

## Connecting a client

Point Claude Desktop / Claude Code at the running server (Streamable HTTP transport, not a launched command).

Behind a reverse proxy, passing the bearer token as a header:

```json
{
  "mcpServers": {
    "mssql": {
      "type": "http",
      "url": "http://<host>/mcp",
      "headers": {
        "Authorization": "Bearer <value of MCP_AUTH_TOKEN>"
      }
    }
  }
}
```

Use the host's LAN IP (or hostname, once you have DNS pointing at it) for `<host>`. Omit the port if the reverse proxy listens on the standard HTTP (80) or HTTPS (443) port; include it otherwise.

Running locally without a reverse proxy (`docker-compose.local.yml`), plain HTTP on port `8199` — drop the `headers` block entirely if `MCP_USE_AUTH=0`, keep it (with `http://` in the URL) if you left auth on:

```json
{
  "mcpServers": {
    "mssql": {
      "type": "http",
      "url": "http://<host>:8199/mcp"
    }
  }
}
```

## Local development (without Docker)

Needs a `config.json` (see [Setup](#setup)) reachable at `MCP_CONFIG_PATH` (default `/app/config.json`, which won't exist outside the container — point it at a local file instead):

```
npm install
npm run build
cp config.example.json config.json   # if you haven't already
MCP_CONFIG_PATH=./config.json npm start
```

## Notes

- The server is stateless (no MCP session persistence) — each HTTP request gets a fresh transport/server pair. GET and DELETE on `/mcp` return 405 since there's no session stream or session to delete.
- When `MCP_USE_AUTH=1`, every request to `/mcp` requires `Authorization: Bearer <MCP_AUTH_TOKEN>`; a missing or wrong token gets a 401. This is a single shared secret, not per-user identity — anyone with the token has full read access. Rotate it (update `.env`/`.env.local`, `docker compose up -d`) if it ever leaks, and update every connected client's config.
- `MCP_USE_AUTH=0` — or leaving it unset — disables that check entirely; every request is treated as authorized regardless of headers. Only use this with `docker-compose.local.yml` on a trusted host/network; never set it to `0` (or leave it unset) on the proxied setup, since the reverse proxy may have no auth of its own, and `/mcp` would become unauthenticated for anyone who can reach it.
