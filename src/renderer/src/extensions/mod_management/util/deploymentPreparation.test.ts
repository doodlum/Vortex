import PromiseBB from "bluebird";
import { expect, it, vi } from "vitest";

import { registerDeploymentPreparation, withDeploymentPreparation } from "./deploymentPreparation";

it("propagates remount failure with the production Bluebird global and still releases other preparations", async () => {
  const previousPromise = globalThis.Promise;
  const release = vi.fn(async () => undefined);
  const removeFirst = registerDeploymentPreparation(async () => release);
  const removeSecond = registerDeploymentPreparation(async () => async () => {
    throw new Error("mount failed");
  });
  vi.stubGlobal("Promise", PromiseBB);
  try {
    await expect(
      withDeploymentPreparation("game", "deploy", async () => undefined),
    ).rejects.toThrow("mount failed");
    expect(release).toHaveBeenCalledExactlyOnceWith(true);
  } finally {
    vi.stubGlobal("Promise", previousPromise);
    removeFirst();
    removeSecond();
  }
});

it("releases completed preparation when a later prerequisite rejects without running deployment", async () => {
  const release = vi.fn(async () => undefined);
  const removeFirst = registerDeploymentPreparation(async () => release);
  const removeSecond = registerDeploymentPreparation(async () => {
    throw new Error("unmount failed");
  });
  const deploy = vi.fn(async () => undefined);
  try {
    await expect(withDeploymentPreparation("game", "deploy", deploy)).rejects.toThrow(
      "unmount failed",
    );
    expect(deploy).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledExactlyOnceWith(false);
  } finally {
    removeFirst();
    removeSecond();
  }
});

it("releases changing state after failed deployment so a later activation can mount", async () => {
  const release = vi.fn(async () => undefined);
  const remove = registerDeploymentPreparation(async () => release);
  try {
    await expect(
      withDeploymentPreparation("game", "deploy", async () => {
        throw new Error("merge failed");
      }),
    ).rejects.toThrow("merge failed");
    expect(release).toHaveBeenCalledExactlyOnceWith(false);
    release.mockClear();
    await expect(withDeploymentPreparation("game", "deploy", async () => "done")).resolves.toBe(
      "done",
    );
    expect(release).toHaveBeenCalledExactlyOnceWith(true);
  } finally {
    remove();
  }
});
