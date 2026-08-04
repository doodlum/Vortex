import fs from "node:fs";
import path from "node:path";

const source = path.resolve("node_modules/@nexusmods/fomod-installer-native/prebuilds");
const outputRoot = path.resolve("../../../dist");

for (const entry of fs.readdirSync(outputRoot, { withFileTypes: true })) {
  if (!entry.isDirectory() || !entry.name.endsWith("-unpacked")) continue;
  const destination = path.join(
    outputRoot,
    entry.name,
    "resources/app.asar.unpacked/node_modules/@nexusmods/fomod-installer-native/prebuilds",
  );
  fs.cpSync(source, destination, { recursive: true });
}
