import {
  fileOpen as _fileOpen,
  fileSave as _fileSave,
  supported as nativeFileSystemSupported,
} from "browser-fs-access";

import { EVENT, MIME_TYPES, debounce } from "@excalidraw/common";

import { AbortError } from "../errors";

import { normalizeFile } from "./blob";

import type { FileSystemHandle } from "browser-fs-access";

type FILE_EXTENSION = Exclude<keyof typeof MIME_TYPES, "binary">;

const INPUT_CHANGE_INTERVAL_MS = 5000;

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
    legacySetup: (resolve, reject, input) => {
      const scheduleRejection = debounce(reject, INPUT_CHANGE_INTERVAL_MS);
      const focusHandler = () => {
        checkForFile();
        document.addEventListener(EVENT.KEYUP, scheduleRejection);
        document.addEventListener(EVENT.POINTER_UP, scheduleRejection);
        scheduleRejection();
      };
      const checkForFile = () => {
        // this hack might not work when expecting multiple files
        if (input.files?.length) {
          const ret = opts.multiple ? [...input.files] : input.files[0];
          resolve(ret as RetType);
        }
      };
      requestAnimationFrame(() => {
        window.addEventListener(EVENT.FOCUS, focusHandler);
      });
      const interval = window.setInterval(() => {
        checkForFile();
      }, INPUT_CHANGE_INTERVAL_MS);
      return (rejectPromise) => {
        clearInterval(interval);
        scheduleRejection.cancel();
        window.removeEventListener(EVENT.FOCUS, focusHandler);
        document.removeEventListener(EVENT.KEYUP, scheduleRejection);
        document.removeEventListener(EVENT.POINTER_UP, scheduleRejection);
        if (rejectPromise) {
          // so that something is shown in console if we need to debug this
          console.warn("Opening the file was canceled (legacy-fs).");
          rejectPromise(new AbortError());
        }
      };
    },
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
  /** existing FileSystemHandle */
  fileHandle?: FileSystemHandle | null;
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
) => Promise<FileSystemHandle | null>;

let _fileSaveOverride: FileSaveOverride | null = null;

/** Register (or clear, with `null`) the host save override — see {@link FileSaveOverride}. */
export const setFileSaveOverride = (fn: FileSaveOverride | null) => {
  _fileSaveOverride = fn;
};

export const fileSave = (blob: Blob | Promise<Blob>, opts: FileSaveOpts) => {
  if (_fileSaveOverride) {
    // Redirect to the host (await the blob first — the override needs the bytes).
    return Promise.resolve(blob).then((resolved) => _fileSaveOverride!(resolved, opts));
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
  );
};

export { nativeFileSystemSupported };
export type { FileSystemHandle };
