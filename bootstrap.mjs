#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOME = resolve(homedir());
const REPO_DIR = dirname(fileURLToPath(import.meta.url));
const PI_DIR = join(HOME, ".pi", "agent");
const EXTENSIONS_DIR = join(REPO_DIR, "extensions");
const PI_EXTENSIONS_DIR = join(PI_DIR, "extensions");
const APPEND_SYSTEM_SOURCE = join(REPO_DIR, "APPEND_SYSTEM.md");
const PI_APPEND_SYSTEM = join(PI_DIR, "APPEND_SYSTEM.md");
const links = [
  { link: join(PI_DIR, "prompts"), target: join(REPO_DIR, "prompts") },
  { link: join(PI_DIR, "skills"), target: join(REPO_DIR, "skills") },
  { link: join(PI_DIR, "reminders"), target: join(REPO_DIR, "reminders") },
  { link: join(PI_DIR, "keybindings.json"), target: join(REPO_DIR, "keybindings.json") },
];

// JSON config files installed wholesale over their target. `preserve` names
// runtime keys the installation owns, kept when the repo file omits them.
const OVERLAYS = [
  {
    source: join(REPO_DIR, "pi-better-openai.json"),
    target: join(PI_EXTENSIONS_DIR, "pi-better-openai.json"),
    label: "pi-better-openai settings",
  },
  {
    source: join(REPO_DIR, "coralbricks.json"),
    target: join(PI_EXTENSIONS_DIR, "coralbricks.json"),
    label: "coralbricks settings",
  },
  {
    source: join(REPO_DIR, "opencode-go-provider.json"),
    target: join(PI_DIR, "opencode-go-provider.json"),
    label: "opencode-go provider settings",
  },
  {
    source: join(REPO_DIR, "pi-vcc-config.json"),
    target: join(PI_DIR, "pi-vcc-config.json"),
    label: "pi-vcc settings",
  },
  {
    source: join(REPO_DIR, "settings.json"),
    target: join(PI_DIR, "settings.json"),
    label: "pi settings",
    preserve: ["deviceId"],
  },
  {
    source: join(REPO_DIR, "mcp.json"),
    target: join(PI_DIR, "mcp.json"),
    label: "MCP config",
  },
];

// A malformed preserved value is skipped, so reconciliation replaces it.
const PRESERVED_KEY_GUARDS = {
  deviceId: (value) => typeof value === "string" && value.trim() !== "",
};

// Every managed path lives inside ~/.pi/agent; anything else is a bug.
function assertSafePath(path) {
  const rel = relative(PI_DIR, resolve(path));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Refusing unsafe path write: ${path}`);
  }
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonFile(path) {
  return JSON.parse(await readFile(path, "utf-8"));
}

async function relink(linkPath, targetPath) {
  assertSafePath(linkPath);

  await mkdir(dirname(linkPath), { recursive: true });
  await rm(linkPath, { recursive: true, force: true });

  if (!existsSync(targetPath)) {
    console.log(`skip ${linkPath}: target does not exist`);
    return;
  }

  await symlink(targetPath, linkPath);

  console.log(`linked ${linkPath} -> ${targetPath}`);
}

// Write through a sibling temp file so the target is never absent.
async function writeAtomic(path, content) {
  assertSafePath(path);
  await mkdir(dirname(path), { recursive: true });

  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o644 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function writeManagedJsonFile(path, value) {
  await writeAtomic(path, JSON.stringify(value, null, 2) + "\n");
}

// Back up before removing: an accidental source removal stays recoverable.
async function removeWithBackup(target, label, reason) {
  assertSafePath(target);

  if (existsSync(target)) {
    const backup = `${target}.bak`;
    await copyFile(target, backup);
    console.log(`backed up ${backup}`);
  }

  await rm(target, { recursive: true, force: true });
  console.log(`removed ${label}: ${reason}`);
}

async function installJsonConfig({ source, target, label, preserve = [] }) {
  assertSafePath(target);

  if (!existsSync(source)) {
    await removeWithBackup(target, label, `source not found at ${source}`);
    return;
  }

  const value = await readJsonFile(source);
  if (!isObject(value)) {
    throw new Error(`${label} must be a JSON object: ${source}`);
  }

  if (preserve.length > 0) {
    let current;
    try {
      current = await readJsonFile(target);
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }

    for (const key of preserve) {
      if (Object.hasOwn(value, key)) continue;
      const candidate = current?.[key];
      if (PRESERVED_KEY_GUARDS[key]?.(candidate)) value[key] = candidate;
    }
  }

  await writeManagedJsonFile(target, value);
  console.log(`wrote ${label} to ${target}`);
}

async function syncDirectoryLinks(sourceDir, targetDir) {
  assertSafePath(targetDir);
  await mkdir(targetDir, { recursive: true });

  const repoEntries = existsSync(sourceDir)
    ? (await readdir(sourceDir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
    : [];
  const declared = new Set(repoEntries.map((entry) => entry.name));

  // Prune only repo-owned symlinks. A regular file here is runtime state this
  // repository does not declare, so reconciliation leaves it alone.
  for (const entry of await readdir(targetDir, { withFileTypes: true })) {
    if (declared.has(entry.name) || !entry.isSymbolicLink()) continue;

    const stalePath = join(targetDir, entry.name);
    assertSafePath(stalePath);
    await rm(stalePath, { recursive: true, force: true });
    console.log(`removed stale link ${stalePath}`);
  }

  for (const entry of repoEntries) {
    await relink(join(targetDir, entry.name), join(sourceDir, entry.name));
  }
}

async function main() {
  const appendSystem = await readFile(APPEND_SYSTEM_SOURCE, "utf-8");

  for (const { link, target } of links) {
    await relink(link, target);
  }

  await writeAtomic(PI_APPEND_SYSTEM, appendSystem);
  console.log(`wrote APPEND_SYSTEM.md to ${PI_APPEND_SYSTEM}`);

  await syncDirectoryLinks(EXTENSIONS_DIR, PI_EXTENSIONS_DIR);

  for (const overlay of OVERLAYS) {
    await installJsonConfig(overlay);
  }

  console.log("bootstrap complete");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
