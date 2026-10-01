import {
  fileOpen as _fileOpen,
  fileSave as _fileSave,
  supported as nativeFileSystemSupported,
} from "browser-fs-access";

import { MIME_TYPES } from "@excalidraw/common";

import { normalizeFile } from "./blob";

type FILE_EXTENSION = Exclude<keyof typeof MIME_TYPES, "binary">;

export const fileOpen = async <M extends boolean | undefined = false>(opts: {
  extensions?: FILE_EXTENSION[];
  description: string;
  multiple?: M;
}): Promise<M extends false | undefined ? File : File[]> => {
  // an unsafe TS hack, alas not much we can do AFAIK
  type RetType = M extends false | undefined ? File : File[];

  const mimeTypes = opts.extensions?.reduce((mimeTypes, type) => {
    mimeTypes.push(MIME_TYPES[type]);

    return mimeTypes;
  }, [] as string[]);

  const extensions = opts.extensions?.reduce((acc, ext) => {
    if (ext === "jpg") {
      return acc.concat(".jpg", ".jpeg");
    }
    return acc.concat(`.${ext}`);
  }, [] as string[]);

  const files = await _fileOpen({
    description: opts.description,
    extensions,
    mimeTypes,
    multiple: opts.multiple ?? false,
  });

  if (Array.isArray(files)) {
    return (await Promise.all(
      files.map((file) => normalizeFile(file)),
    )) as RetType;
  }
  return (await normalizeFile(files)) as RetType;
};

export type FileSaveOpts = {
  /** supply without the extension */
  name: string;
  /** file extension */
  extension: FILE_EXTENSION;
  mimeTypes?: string[];
  description: string;
  /** existing FileSystemFileHandle */
  fileHandle?: FileSystemFileHandle | null;
};

/**
 * Host-app override for every native save. Image export (PNG/SVG) and scene
 * "Save to disk" all funnel through {@link fileSave}, so a host (e.g. the
 * Sonacove Electron app) can register one of these to redirect the blob to its
 * own storage instead of the OS file picker. Return `null` to signal "no active
 * file handle" (each save is independent).
 */
export type FileSaveOverride = (
  blob: Blob,
  opts: FileSaveOpts,
) => Promise<FileSystemFileHandle | null>;

let _fileSaveOverride: FileSaveOverride | null = null;

/** Register (or clear, with `null`) the host save override — see {@link FileSaveOverride}. */
export const setFileSaveOverride = (fn: FileSaveOverride | null) => {
  _fileSaveOverride = fn;
};

export const fileSave = (blob: Blob | Promise<Blob>, opts: FileSaveOpts) => {
  // Capture the override into a local BEFORE branching: `blob` may be a pending
  // Promise (PNG/SVG export encoding), and the host can clear the override —
  // setFileSaveOverride(null) on unmount — between this check and the resolve.
  // Reading the module var again inside .then() could then call null; the local
  // pins the function we actually validated.
  const override = _fileSaveOverride;

  if (override) {
    return Promise.resolve(blob).then((resolved) => override(resolved, opts));
  }

  return _fileSave(
    blob,
    {
      fileName: `${opts.name}.${opts.extension}`,
      description: opts.description,
      extensions: [`.${opts.extension}`],
      mimeTypes: opts.mimeTypes,
    },
    opts.fileHandle,
    false,
  );
};

export { nativeFileSystemSupported };
