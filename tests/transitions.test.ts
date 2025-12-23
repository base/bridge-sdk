import { test, expect } from "bun:test";
import { isAllowedTransition } from "../src/core/capabilities";

test("execution status transitions: happy path is allowed", () => {
  expect(isAllowedTransition("Unknown", "Initiated")).toBe(true);
  expect(isAllowedTransition("Initiated", "FinalizedOnSource")).toBe(true);
  expect(isAllowedTransition("FinalizedOnSource", "Proven")).toBe(true);
  expect(isAllowedTransition("Proven", "Executable")).toBe(true);
  expect(isAllowedTransition("Executable", "Executing")).toBe(true);
  expect(isAllowedTransition("Executing", "Executed")).toBe(true);
});

test("execution status transitions: illegal transitions are rejected", () => {
  expect(isAllowedTransition("Unknown", "Executed")).toBe(false);
  expect(isAllowedTransition("Executed", "Executing")).toBe(false);
  expect(isAllowedTransition("Failed", "Executable")).toBe(false);
  expect(isAllowedTransition("Expired", "Initiated")).toBe(false);
});
