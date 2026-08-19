import { test } from "node:test";
import assert from "node:assert/strict";
import { add } from "./add.mjs";

test("add(2, 3) equals 5", () => {
  assert.equal(add(2, 3), 5);
});
