import { describe, expect, it, vi } from "vitest";

import { makeApiHarness } from "../../test-utils/builders";
import { ProcessCanceled } from "../../util/CustomErrors";
import InstallManager from "./InstallManager";

vi.mock("../../logging", () => ({ log: vi.fn() }));

interface InstructionErrorBoundary {
  processInstructions(...args: unknown[]): Promise<unknown>;
}

describe("installer error instructions", () => {
  it("reports a serialized C# compiler failure instead of treating unused fields as paths", async () => {
    const harness = makeApiHarness();
    const manager = Object.create(InstallManager.prototype) as InstructionErrorBoundary;
    const message = "C# script compilation failed: CS0023";
    const instructions = JSON.parse(
      JSON.stringify([{ type: "error", source: message, destination: null, value: "fatal" }]),
    );

    const result = Promise.resolve().then(() =>
      manager.processInstructions(
        harness.api,
        undefined,
        "fixture.zip",
        "extracted",
        "staged",
        "fallout3",
        "broken-csharp",
        { instructions },
        undefined,
        false,
        {},
      ),
    );

    await expect(result).rejects.toBeInstanceOf(ProcessCanceled);
    await expect(result).rejects.toMatchObject({
      message: `Installer script failed: ${message}`,
      extraInfo: {
        modId: "broken-csharp",
        errors: [{ severity: "fatal", message }],
      },
    });
    expect(harness.errorNotifications).toEqual([
      expect.objectContaining({ title: "Installer reported errors", allowReport: false }),
    ]);
  });
});
