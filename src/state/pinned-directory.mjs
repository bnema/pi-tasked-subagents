import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";

function safeBasename(name) {
  if (typeof name !== "string" || !name || name === "." || name === ".." || basename(name) !== name || name.includes("/") || name.includes("\\")) {
    throw new Error("Storage filename is not a safe basename");
  }
  return name;
}

function containedComponents(root, directory) {
  const difference = relative(root, directory);
  if (difference === "" || difference === ".." || difference.startsWith(`..${sep}`) || difference.startsWith("/")) {
    throw new Error("Storage path escapes configured root");
  }
  return difference.split(sep).filter(Boolean).map(safeBasename);
}

function procPath(fd, procDirectoryPath) {
  return procDirectoryPath ? procDirectoryPath(fd) : `/proc/self/fd/${fd}`;
}

/**
 * A Linux directory capability.  All child operations use the live dirfd via
 * procfs, so replacing the spelling of a validated directory cannot redirect
 * a mutation.  Procfs is mandatory: without it Node has no dirfd-relative I/O.
 */
export class PinnedDirectory {
  constructor(handle, identity, procDirectoryPath) {
    this.handle = handle;
    this.identity = identity;
    this.procDirectoryPath = procDirectoryPath;
  }

  path(name) {
    return `${this.procDirectoryPath}/${safeBasename(name)}`;
  }

  async assert() {
    const stat = await this.handle.stat();
    if (!stat.isDirectory() || stat.dev !== this.identity.dev || stat.ino !== this.identity.ino) {
      throw new Error("Pinned storage directory identity changed during operation");
    }
    try {
      await fs.realpath(this.procDirectoryPath);
    } catch (error) {
      throw new Error("Procfs dirfd paths are unavailable; refusing storage mutation", { cause: error });
    }
  }

  async openFile(name, flags, mode) {
    await this.assert();
    const handle = await fs.open(this.path(name), flags, mode);
    await this.assert();
    return handle;
  }

  async link(name, destination, destinationName) {
    await this.assert();
    await destination.assert();
    await fs.link(this.path(name), destination.path(destinationName));
    await this.assert();
    await destination.assert();
  }

  async unlink(name) {
    await this.assert();
    await fs.unlink(this.path(name));
    await this.assert();
  }

  async sync() {
    await this.assert();
    await this.handle.sync();
    await this.assert();
  }

  async close() {
    await this.handle.close();
  }
}

async function pin(directory, expected, procDirectoryPath) {
  let handle;
  try {
    handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new Error("Unable to open pinned storage directory", { cause: error });
  }
  try {
    const stat = await handle.stat();
    if (!stat.isDirectory() || (expected && (stat.dev !== expected.dev || stat.ino !== expected.ino))) {
      throw new Error("Storage directory identity changed before pinning");
    }
    const proc = procPath(handle.fd, procDirectoryPath);
    try {
      await fs.realpath(proc);
    } catch (error) {
      throw new Error("Procfs dirfd paths are unavailable; refusing storage mutation", { cause: error });
    }
    return new PinnedDirectory(handle, { dev: stat.dev, ino: stat.ino }, proc);
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/**
 * Create and traverse private storage components through already-pinned
 * parents.  `directory` must be a strict descendant of `root`.
 */
export async function openPinnedDirectory(root, directory, options = {}) {
  const resolvedRoot = resolve(root);
  const resolvedDirectory = resolve(directory);
  const components = containedComponents(resolvedRoot, resolvedDirectory);
  try {
    await fs.mkdir(resolvedRoot, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new Error("Unable to create private storage root", { cause: error });
  }
  let current = await pin(resolvedRoot, undefined, options.procDirectoryPath);
  try {
    await fs.chmod(current.procDirectoryPath, 0o700);
    for (const component of components) {
      await current.assert();
      try {
        await fs.mkdir(current.path(component), { mode: 0o700 });
      } catch (error) {
        if (error?.code !== "EEXIST") throw new Error("Unable to create private storage directory", { cause: error });
      }
      const child = await pin(current.path(component), undefined, options.procDirectoryPath);
      try {
        await fs.chmod(child.procDirectoryPath, 0o700);
        await current.assert();
      } catch (error) {
        await child.close();
        throw error;
      }
      await current.close();
      current = child;
    }
    await current.assert();
    return current;
  } catch (error) {
    await current.close();
    throw error;
  }
}

/** Pin an already-created directory after its caller validated its identity. */
export async function pinExistingDirectory(root, directory, expected, options = {}) {
  const resolvedRoot = resolve(root);
  const resolvedDirectory = resolve(directory);
  containedComponents(resolvedRoot, resolvedDirectory);
  const pinned = await pin(resolvedDirectory, expected, options.procDirectoryPath);
  try {
    const rootHandle = await pin(resolvedRoot, undefined, options.procDirectoryPath);
    await rootHandle.close();
    return pinned;
  } catch (error) {
    await pinned.close();
    throw error;
  }
}

export { safeBasename };
