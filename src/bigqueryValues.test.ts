import assert from "node:assert/strict";
import test from "node:test";
import { BigQuery, Geography } from "@google-cloud/bigquery";
import Big from "big.js";
import {
  castBigQueryInteger,
  normalizeBigQueryValue,
} from "./bigquery";

test("preserves BigQuery precision wrappers recursively", () => {
  const integer = "9007199254740993";
  assert.equal(castBigQueryInteger(integer), integer);
  assert.deepEqual(
    normalizeBigQueryValue({
      timestamp: BigQuery.timestamp("2026-01-02T03:04:05Z"),
      nested: [new Geography("POINT(1 2)"), new Big("1234567890.123456789")],
    }),
    {
      timestamp: "2026-01-02T03:04:05.000Z",
      nested: ["POINT(1 2)", "1234567890.123456789"],
    },
  );
});
