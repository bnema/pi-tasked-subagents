import type { FileHandle } from "node:fs/promises";

export interface DirectoryIdentity { dev: number; ino: number; realpath?: string; }
export interface PinnedDirectoryOptions { procDirectoryPath?: (fd: number) => string; }
export declare class PinnedDirectory {
  constructor(handle: FileHandle, identity: DirectoryIdentity, procDirectoryPath: string);
  readonly handle: FileHandle;
  readonly identity: DirectoryIdentity;
  readonly procDirectoryPath: string;
  path(name: string): string;
  assert(): Promise<void>;
  openFile(name: string, flags: number, mode?: number): Promise<FileHandle>;
  rename(name: string, destinationName: string): Promise<void>;
  link(name: string, destination: PinnedDirectory, destinationName: string): Promise<void>;
  unlink(name: string): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}
export declare function safeBasename(name: string): string;
export declare function openPinnedDirectory(root: string, directory: string, options?: PinnedDirectoryOptions): Promise<PinnedDirectory>;
export declare function pinDirectory(directory: string, options?: PinnedDirectoryOptions): Promise<PinnedDirectory>;
export declare function pinExistingDirectory(root: string, directory: string, expected: DirectoryIdentity, options?: PinnedDirectoryOptions): Promise<PinnedDirectory>;
