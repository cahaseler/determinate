import { describe, it, expect } from "bun:test";
import {
  ValidationError,
  BudgetExceededError,
  NoValidToolsError,
  ProviderError,
  OutputError,
  AbortError,
} from "../src/errors";

describe("errors", () => {
  it("ValidationError includes message and is instanceof Error", () => {
    const err = new ValidationError("state does not match schema");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toBe("state does not match schema");
    expect(err.name).toBe("ValidationError");
  });

  it("BudgetExceededError includes section details", () => {
    const err = new BudgetExceededError("history", 5000, 2000);
    expect(err).toBeInstanceOf(Error);
    expect(err.section).toBe("history");
    expect(err.actual).toBe(5000);
    expect(err.budget).toBe(2000);
    expect(err.message).toContain("history");
    expect(err.message).toContain("5000");
    expect(err.message).toContain("2000");
  });

  it("NoValidToolsError is an Error", () => {
    const err = new NoValidToolsError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("NoValidToolsError");
  });

  it("ProviderError includes provider type", () => {
    const err = new ProviderError("anthropic", "rate limit exceeded");
    expect(err.provider).toBe("anthropic");
    expect(err.message).toContain("rate limit exceeded");
  });

  it("OutputError includes raw output", () => {
    const raw = '{"invalid": true}';
    const err = new OutputError("tool not in valid set", raw);
    expect(err.rawOutput).toBe(raw);
  });

  it("AbortError is an Error", () => {
    const err = new AbortError("timeout after 5000ms");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("AbortError");
  });
});
