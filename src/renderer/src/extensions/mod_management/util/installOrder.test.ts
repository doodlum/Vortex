import { describe, expect, it } from "vitest";

import { makeDownload, makeReference } from "../../../test-utils/builders";
import type { IState } from "../../../types/IState";
import type { IDependency } from "../types/IDependency";
import { dependencySize, installPriority } from "./installOrder";

const stateWith = (files: Record<string, unknown>) =>
  ({ persistent: { downloads: { files } } }) as unknown as IState;

const dep = (overrides: Partial<IDependency>): IDependency => ({
  download: undefined,
  reference: makeReference(),
  lookupResults: [],
  ...overrides,
});

describe("installPriority", () => {
  it("ranks dependencies by archive size and puts direct installs ahead of them", () => {
    expect(installPriority("collection", 100)).toBe(100);
    expect(installPriority(undefined, 100)).toBeGreaterThan(installPriority("collection", 1e12));
  });
});

describe("dependencySize", () => {
  it("prefers the download's size, then the reference's, then the lookup's", () => {
    const state = stateWith({ dl: makeDownload({ size: 30 }) });
    expect(
      dependencySize(state, dep({ download: "dl", reference: makeReference({ fileSize: 20 }) })),
    ).toBe(30);
    expect(dependencySize(state, dep({ reference: makeReference({ fileSize: 20 }) }))).toBe(20);
    expect(
      dependencySize(
        state,
        dep({ lookupResults: [{ key: "k", value: { fileSizeBytes: 10 } as any }] }),
      ),
    ).toBe(10);
    expect(dependencySize(state, dep({}))).toBe(0);
  });
});
