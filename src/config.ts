import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";

export interface DblyConfig {
  connections: Record<string, ConnectionConfig>;
}

export type ConnectionConfig =
  | PostgresConnectionConfig
  | BigQueryConnectionConfig;

export interface PostgresConnectionConfig {
  type: "postgres";
  host: string;
  port: number;
  user: string;
  database: string;
  schema: string;
}

export type BigQueryAuth =
  | { type: "adc" }
  | { type: "keyfile"; path: string };

export interface BigQueryConnectionConfig {
  type: "bigquery";
  project: string;
  dataset: string;
  location?: string;
  auth: BigQueryAuth;
}

export const CONFIG_PATH = path.join(os.homedir(), "config", "dbly.yaml");

export async function loadConfig(): Promise<DblyConfig> {
  try {
    const source = await fs.readFile(CONFIG_PATH, "utf8");
    const root = asRecord(YAML.parse(source), "top level");
    const rawConnections = asRecord(root.connections, "connections");
    const connections: Record<string, ConnectionConfig> = {};

    for (const [name, rawConnection] of Object.entries(rawConnections)) {
      validateConnectionName(name);
      const connection = asRecord(rawConnection, `connection "${name}"`);
      const type = requiredString(connection, "type", `connection "${name}"`);

      if (type === "postgres") {
        connections[name] = normalizePostgres(name, connection);
      } else if (type === "bigquery") {
        connections[name] = normalizeBigQuery(name, connection);
      } else {
        throw new Error(
          `connection "${name}" has unsupported type "${type}"`,
        );
      }
    }

    return { connections };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to load dbly config at ${CONFIG_PATH}: ${message}`);
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a mapping`);
  }
  return value as Record<string, unknown>;
}

function requiredString(
  record: Record<string, unknown>,
  field: string,
  label: string,
): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label}.${field} must be a non-empty string`);
  }
  return value;
}

function validateConnectionName(name: string): void {
  if (name.trim().length === 0 || /[\r\n]/.test(name)) {
    throw new Error("connection names must be non-empty and contain no newlines");
  }
  if (name !== name.trim()) {
    throw new Error(
      `connection name "${name}" must not start or end with whitespace`,
    );
  }
}

function normalizePostgres(
  name: string,
  connection: Record<string, unknown>,
): PostgresConnectionConfig {
  const label = `connection "${name}"`;
  const rawPort = connection.port;
  let port = 5432;
  if (rawPort !== undefined) {
    if (
      typeof rawPort !== "number" ||
      !Number.isInteger(rawPort) ||
      rawPort < 1 ||
      rawPort > 65_535
    ) {
      throw new Error(`${label}.port must be an integer from 1 to 65535`);
    }
    port = rawPort;
  }

  return {
    type: "postgres",
    host: requiredString(connection, "host", label),
    port,
    user: requiredString(connection, "user", label),
    database: requiredString(connection, "database", label),
    schema: requiredString(connection, "schema", label),
  };
}

function normalizeBigQuery(
  name: string,
  connection: Record<string, unknown>,
): BigQueryConnectionConfig {
  const label = `connection "${name}"`;
  const locationValue = connection.location;
  let location: string | undefined;
  if (locationValue !== undefined) {
    if (typeof locationValue !== "string" || locationValue.trim().length === 0) {
      throw new Error(`${label}.location must be a non-empty string`);
    }
    location = locationValue;
  }

  return {
    type: "bigquery",
    project: requiredString(connection, "project", label),
    dataset: requiredString(connection, "dataset", label),
    ...(location === undefined ? {} : { location }),
    auth: normalizeBigQueryAuth(connection.auth, label),
  };
}

function normalizeBigQueryAuth(
  value: unknown,
  label: string,
): BigQueryAuth {
  if (value === undefined) {
    return { type: "adc" };
  }

  const auth = asRecord(value, `${label}.auth`);
  const type = requiredString(auth, "type", `${label}.auth`);
  if (type === "adc") {
    return { type: "adc" };
  }
  if (type === "keyfile") {
    const keyfilePath = requiredString(auth, "path", `${label}.auth`);
    if (!path.isAbsolute(keyfilePath)) {
      throw new Error(`${label}.auth.path must be an absolute path`);
    }
    return { type: "keyfile", path: keyfilePath };
  }
  throw new Error(`${label}.auth has unsupported type "${type}"`);
}
