import assert from "node:assert/strict";
import test from "node:test";
import {
  castBigQueryInteger,
  normalizeBigQueryValue,
} from "./bigquery";

class BigQueryTimestamp {
  public constructor(public readonly value: string) {}
}

class Geography {
  public constructor(public readonly value: string) {}
}

class Big {
  public toFixed(): string {
    return "1234567890.123456789";
  }
}

test("preserves BigQuery precision wrappers recursively", () => {
  const integer = "9007199254740993";
  assert.equal(castBigQueryInteger(integer), integer);
  assert.deepEqual(
    normalizeBigQueryValue({
      timestamp: new BigQueryTimestamp("2026-01-02T03:04:05Z"),
      nested: [new Geography("POINT(1 2)"), new Big()],
    }),
    {
      timestamp: "2026-01-02T03:04:05Z",
      nested: ["POINT(1 2)", "1234567890.123456789"],
    },
  );
});
