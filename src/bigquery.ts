import {
  BigQuery,
  BigQueryDate,
  BigQueryDatetime,
  BigQueryTime,
  BigQueryTimestamp,
  Geography,
} from "@google-cloud/bigquery";
import type { BigQueryConnectionConfig } from "./config";
import { normalizeCell, type DriverResult } from "./database";

export function castBigQueryInteger(value: string): string {
  return value;
}

export function normalizeBigQueryValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(normalizeBigQueryValue);
  }
  if (value instanceof Date || Buffer.isBuffer(value)) {
    return value;
  }

  // Use instanceof / duck typing: bundling renames classes (e.g. Big -> Big2),
  // so constructor names are not reliable.
  if (
    value instanceof BigQueryDate ||
    value instanceof BigQueryDatetime ||
    value instanceof BigQueryTime ||
    value instanceof BigQueryTimestamp ||
    value instanceof Geography
  ) {
    return value.value;
  }
  // big.js values (NUMERIC / BIGNUMERIC).
  if ("toFixed" in value && typeof value.toFixed === "function") {
    return value.toFixed();
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, nestedValue]) => [
      key,
      normalizeBigQueryValue(nestedValue),
    ]),
  );
}

export class BigQueryExecutor {
  private readonly client: BigQuery;

  public constructor(private readonly config: BigQueryConnectionConfig) {
    this.client = new BigQuery(
      config.auth.type === "keyfile"
        ? { projectId: config.project, keyFilename: config.auth.path }
        : { projectId: config.project },
    );
  }

  public async execute(sql: string): Promise<DriverResult> {
    const [job] = await this.client.createQueryJob({
      query: sql,
      useLegacySql: false,
      defaultDataset: {
        projectId: this.config.project,
        datasetId: this.config.dataset,
      },
      ...(this.config.location === undefined
        ? {}
        : { location: this.config.location }),
    });

    const baseRequest = {
      autoPaginate: false as const,
      wrapIntegers: { integerTypeCastFunction: castBigQueryInteger },
    };
    let request: Record<string, unknown> = baseRequest;
    const allRows: Record<string, unknown>[] = [];
    let schemaFields: Array<{ name?: string | null }> | undefined;
    let totalRows: string | undefined;
    let affectedRows: string | undefined;

    while (true) {
      const [rows, nextQuery, apiResponse] = await job.getQueryResults(request);
      for (const row of rows as Record<string, unknown>[]) {
        allRows.push(row);
      }

      const response = apiResponse as {
        jobComplete?: boolean | null;
        schema?: { fields?: Array<{ name?: string | null }> | null } | null;
        totalRows?: string | number | null;
        numDmlAffectedRows?: string | number | null;
      };
      if (schemaFields === undefined && response.schema?.fields) {
        schemaFields = response.schema.fields;
      }
      if (response.totalRows !== undefined && response.totalRows !== null) {
        totalRows = String(response.totalRows);
      }
      if (
        response.numDmlAffectedRows !== undefined &&
        response.numDmlAffectedRows !== null
      ) {
        affectedRows = String(response.numDmlAffectedRows);
      }

      const complete = response.jobComplete !== false;
      if (nextQuery) {
        request = { ...baseRequest, ...nextQuery };
        continue;
      }
      if (!complete) {
        request = baseRequest;
        continue;
      }
      break;
    }

    const columns = schemaFields
      ?.map((field) => field.name)
      .filter((name): name is string => typeof name === "string") ??
      (allRows[0] === undefined ? [] : Object.keys(allRows[0]));
    const normalizedRows = allRows.map((row) =>
      columns.map((column) =>
        normalizeCell(normalizeBigQueryValue(row[column])),
      ),
    );

    return {
      columns,
      rows: normalizedRows,
      rowCount: affectedRows ?? totalRows ?? String(normalizedRows.length),
    };
  }
}
