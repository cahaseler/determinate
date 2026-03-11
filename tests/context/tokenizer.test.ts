import { describe, it, expect } from "bun:test";
import { createTokenizer } from "../../src/context/tokenizer";

describe("tokenizer", () => {
  it("counts tokens for a simple string using tiktoken", () => {
    const tokenizer = createTokenizer("openai", "gpt-4o");
    const count = tokenizer.count("Hello, world!");
    expect(count).toBeGreaterThan(0);
    expect(typeof count).toBe("number");
  });

  it("returns consistent counts for the same input", () => {
    const tokenizer = createTokenizer("openai", "gpt-4o");
    const a = tokenizer.count("test string");
    const b = tokenizer.count("test string");
    expect(a).toBe(b);
  });

  it("longer strings produce higher counts", () => {
    const tokenizer = createTokenizer("openai", "gpt-4o");
    const short = tokenizer.count("hi");
    const long = tokenizer.count("This is a much longer string with many more tokens");
    expect(long).toBeGreaterThan(short);
  });

  it("counts tokens for objects by serializing to JSON", () => {
    const tokenizer = createTokenizer("openai", "gpt-4o");
    const count = tokenizer.count({ key: "value", nested: { a: 1 } });
    expect(count).toBeGreaterThan(0);
  });

  it("uses character approximation for unknown providers", () => {
    const tokenizer = createTokenizer("vllm" as any, "unknown-model");
    const count = tokenizer.count("Hello, world!");
    expect(count).toBeGreaterThan(0);
  });
});
