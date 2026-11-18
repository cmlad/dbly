import assert from "node:assert/strict";
import test from "node:test";
import { toCsv } from "./csv";

test("formats headers and RFC 4180-sensitive values", () => {
  assert.equal(
    toCsv(
      ["plain", "nullable", "comma", "quote", "cr", "lf"],
      [["value", null, "a,b", 'say "hi"', "a\rb", "a\nb"]],
    ),
    'plain,nullable,comma,quote,cr,lf\r\nvalue,,"a,b","say ""hi""","a\rb","a\nb"\r\n',
  );
});
