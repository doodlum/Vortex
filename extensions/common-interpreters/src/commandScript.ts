import type { types } from "@nexusmods/vortex-api";

export function commandScript(input: types.IRunParameters): types.IRunParameters {
  return {
    executable: "cmd.exe",
    args: ["/D", "/S", "/K", `"${[`"${input.executable}"`, ...input.args].join(" ")}"`],
    options: {
      ...input.options,
      shell: input.options.shell ?? true,
    },
  };
}
