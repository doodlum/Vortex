const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const SevenZip = require("node-7z");
const artifacts = require("./artifacts.json");

const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function selectArtifact(platform, arch, pins = artifacts) {
  if (platform !== "win32" && platform !== "linux") {
    throw new Error(`QuickBMS has no bundled runtime for ${platform}/${arch}`);
  }
  if (platform === "linux" && arch !== "x64" && arch !== "ia32") {
    throw new Error(`QuickBMS has no bundled runtime for ${platform}/${arch}`);
  }
  return pins[platform];
}

async function downloadBytes(url, fetcher) {
  const response = await fetcher(url, { signal: AbortSignal.timeout(60_000), redirect: "error" });
  if (!response.ok || !response.body)
    throw new Error(`QuickBMS download failed (${response.status})`);
  const chunks = [];
  let length = 0;
  for await (const bytes of response.body) {
    const chunk = Buffer.from(bytes);
    length += chunk.length;
    if (length > MAX_ARCHIVE_BYTES) throw new Error("QuickBMS archive exceeds its size limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function extractExecutable(archive, destination, executable) {
  const result = await new SevenZip().extract(archive, destination, { raw: [executable] });
  if (result?.code !== 0) throw new Error(`QuickBMS extraction failed (${result?.code})`);
}

async function verifiedFile(file, expected) {
  let stat;
  try {
    stat = await fs.lstat(file);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("QuickBMS executable must be a regular file");
  return hash(await fs.readFile(file)) === expected;
}

// The optional boundaries let offline tests use inert archives and explicit fixture pins.
// The build entry always uses the committed pins and real extractor.
async function prepareQuickBms({
  platform = process.platform,
  arch = process.arch,
  dist = path.join(__dirname, "dist"),
  pins = artifacts,
  fetcher = globalThis.fetch,
  extract = extractExecutable,
} = {}) {
  const asset = selectArtifact(platform, arch, pins);
  await fs.mkdir(dist, { recursive: true });
  const output = path.join(dist, asset.executable);
  if (!(await verifiedFile(output, asset.executableSha256))) {
    const stage = await fs.mkdtemp(path.join(os.tmpdir(), "vortex-quickbms-"));
    try {
      const bytes = await downloadBytes(asset.url, fetcher);
      if (hash(bytes) !== asset.archiveSha256)
        throw new Error("QuickBMS archive checksum mismatch");
      const archive = path.join(stage, "archive.zip");
      const extracted = path.join(stage, "extracted");
      await fs.writeFile(archive, bytes);
      await fs.mkdir(extracted);
      await extract(archive, extracted, asset.executable);
      const executable = path.join(extracted, asset.executable);
      if (!(await verifiedFile(executable, asset.executableSha256)))
        throw new Error("QuickBMS executable checksum mismatch");
      const stagedOutput = path.join(dist, `.quickbms-${process.pid}-${Date.now()}`);
      try {
        await fs.copyFile(executable, stagedOutput, require("node:fs").constants.COPYFILE_EXCL);
        if (platform === "linux") await fs.chmod(stagedOutput, 0o755);
        await fs.rename(stagedOutput, output);
      } finally {
        await fs.rm(stagedOutput, { force: true });
      }
    } finally {
      await fs.rm(stage, { recursive: true, force: true });
    }
  }
  if (platform === "linux") await fs.chmod(output, 0o755);
  const other = artifacts[platform === "win32" ? "linux" : "win32"].executable;
  await fs.rm(path.join(dist, other), { force: true });
  return output;
}

module.exports = { selectArtifact, downloadBytes, extractExecutable, prepareQuickBms };
if (require.main === module) {
  prepareQuickBms().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
