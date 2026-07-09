import assert from "node:assert/strict";
import test from "node:test";
import { analyzeAddress, formatUnits } from "../lib/analyze.js";

test("rejects malformed addresses before making RPC calls", async () => {
  await assert.rejects(
    () => analyzeAddress("0xnot-an-address", "pacific_mainnet", { offline: true }),
    /Invalid address/
  );
});

test("rejects unknown networks before making RPC calls", async () => {
  await assert.rejects(
    () => analyzeAddress("0x0000000000000000000000000000000000000001", "unknown_net", { offline: true }),
    /Unknown network/
  );
});

test("formats raw integer token units into decimal strings", () => {
  assert.equal(formatUnits("0xde0b6b3a7640000", 18), "1");
  assert.equal(formatUnits("0x5f5e100", 6), "100");
  assert.equal(formatUnits("0xf4241", 6), "1.000001");
});
