import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const setFailed = vi.fn();

vi.mock("@actions/core", () => ({
  setFailed: (msg: string) => setFailed(msg),
}));

const { runIfNotVitest } = await import("../src/entrypoint.js");

describe("runIfNotVitest", () => {
  const originalVitest = process.env.VITEST;

  beforeEach(() => {
    setFailed.mockReset();
  });

  afterEach(() => {
    if (originalVitest === undefined) {
      delete process.env.VITEST;
    } else {
      process.env.VITEST = originalVitest;
    }
  });

  it("does not invoke fn when VITEST=true", () => {
    process.env.VITEST = "true";
    const fn = vi.fn().mockResolvedValue(undefined);
    runIfNotVitest(fn);
    expect(fn).not.toHaveBeenCalled();
    expect(setFailed).not.toHaveBeenCalled();
  });

  it("invokes fn when VITEST is unset", async () => {
    delete process.env.VITEST;
    const fn = vi.fn().mockResolvedValue(undefined);
    runIfNotVitest(fn);
    expect(fn).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setImmediate(resolve));
    expect(setFailed).not.toHaveBeenCalled();
  });

  it("calls core.setFailed with Error message on rejection", async () => {
    delete process.env.VITEST;
    const fn = vi.fn().mockRejectedValue(new Error("boom"));
    runIfNotVitest(fn);
    await new Promise((resolve) => setImmediate(resolve));
    expect(setFailed).toHaveBeenCalledWith("boom");
  });

  it("stringifies non-Error rejection values", async () => {
    delete process.env.VITEST;
    const fn = vi.fn().mockRejectedValue("plain-string");
    runIfNotVitest(fn);
    await new Promise((resolve) => setImmediate(resolve));
    expect(setFailed).toHaveBeenCalledWith("plain-string");
  });

  it("invokes onError after core.setFailed when provided", async () => {
    delete process.env.VITEST;
    const order: string[] = [];
    setFailed.mockImplementation(() => {
      order.push("setFailed");
    });
    const onError = vi.fn().mockImplementation(async () => {
      order.push("onError");
    });
    const fn = vi.fn().mockRejectedValue(new Error("boom"));
    runIfNotVitest(fn, onError);
    await new Promise((resolve) => setImmediate(resolve));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(order).toEqual(["setFailed", "onError"]);
  });

  it("does not invoke onError when fn resolves", async () => {
    delete process.env.VITEST;
    const onError = vi.fn().mockResolvedValue(undefined);
    const fn = vi.fn().mockResolvedValue(undefined);
    runIfNotVitest(fn, onError);
    await new Promise((resolve) => setImmediate(resolve));
    expect(onError).not.toHaveBeenCalled();
  });
});
