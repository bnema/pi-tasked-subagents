import { describe, expect, test, vi } from "vitest";

// @ts-expect-error The runtime loader is intentionally plain JavaScript.
const loader = await import("../scripts/typescript-resolver.mjs");

type NextResolve = (specifier: string, context: object) => Promise<unknown>;

function moduleNotFound(): Error & { code: string } {
  return Object.assign(new Error("original resolution failure"), { code: "ERR_MODULE_NOT_FOUND" });
}

describe("TypeScript resolver", () => {
  test.each(["./local.js", "../parent.js", "/absolute.js", "file:///absolute.js"])("falls back from local %s only after module-not-found", async (specifier) => {
    const nextResolve = vi.fn<NextResolve>()
      .mockRejectedValueOnce(moduleNotFound())
      .mockResolvedValueOnce({ url: "file:///resolved.ts" });

    await expect(loader.resolve(specifier, {}, nextResolve)).resolves.toEqual({ url: "file:///resolved.ts" });
    expect(nextResolve).toHaveBeenNthCalledWith(1, specifier, {});
    expect(nextResolve).toHaveBeenNthCalledWith(2, `${specifier.slice(0, -3)}.ts`, {});
  });

  test("does not retry package specifiers or non-module-not-found errors", async () => {
    const packageFailure = moduleNotFound();
    const packageResolve = vi.fn<NextResolve>().mockRejectedValue(packageFailure);
    await expect(loader.resolve("package.js", {}, packageResolve)).rejects.toBe(packageFailure);
    expect(packageResolve).toHaveBeenCalledTimes(1);

    const otherFailure = Object.assign(new Error("invalid package"), { code: "ERR_INVALID_MODULE_SPECIFIER" });
    const localResolve = vi.fn<NextResolve>().mockRejectedValue(otherFailure);
    await expect(loader.resolve("./local.js", {}, localResolve)).rejects.toBe(otherFailure);
    expect(localResolve).toHaveBeenCalledTimes(1);
  });

  test("rethrows the original module-not-found error when the TypeScript fallback fails", async () => {
    const original = moduleNotFound();
    const fallbackFailure = new Error("TypeScript target missing");
    const nextResolve = vi.fn<NextResolve>()
      .mockRejectedValueOnce(original)
      .mockRejectedValueOnce(fallbackFailure);

    await expect(loader.resolve("./local.js", {}, nextResolve)).rejects.toBe(original);
    expect(nextResolve).toHaveBeenNthCalledWith(2, "./local.ts", {});
  });
});
