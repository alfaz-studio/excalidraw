/**
 * @fileoverview Storage module for Excalidraw data persistence with external Jitsi backend.
 *
 * Handles encrypted scene storage, file management, and real-time collaboration
 * through JWT-authenticated API calls to the external backend service.
 */
import { reconcileElements } from "@excalidraw/excalidraw";

import { getSceneVersion } from "@excalidraw/element";

import { restoreElements } from "@excalidraw/excalidraw/data/restore";

import { decompressData } from "@excalidraw/excalidraw/data/encode";
import {
  encryptData,
  decryptData,
} from "@excalidraw/excalidraw/data/encryption";
import { MIME_TYPES } from "@excalidraw/common";

import type {
  AppState,
  BinaryFileData,
  BinaryFileMetadata,
  DataURL,
  ExcalidrawFileError,
  IMeetingDetails,
} from "@excalidraw/excalidraw/types";
import type {
  ExcalidrawElement,
  FileId,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";

import type { RemoteExcalidrawElement } from "@excalidraw/excalidraw/data/reconcile";

import type { CollabSocket } from "@excalidraw/excalidraw/types";

import { getSyncableElements } from ".";

import type { SyncableExcalidrawElement } from ".";
import type Portal from "../collab/Portal";

// No `http://localhost:3000` fallback: a surface whose host never armed storage
// must stay silent rather than talk to a developer-only origin.
const DEFAULT_BACKEND_BASE_URL = import.meta.env.VITE_APP_STORAGE_BACKEND_URL;
const BACKEND_API_PREFIX =
  import.meta.env.VITE_APP_STORAGE_API_PREFIX || "/api/file-sharing";

export type FileErrorHandler = (error: ExcalidrawFileError) => void;

type BackendConfig = {
  baseUrl: string;
  apiPrefix: string;
  meetingDetails: IMeetingDetails | null;
  onFileError: FileErrorHandler | null;
};

/**
 * Keyed per collab room, not a module-global singleton: several surfaces mount
 * in one tab, and a shared global let a surface that withheld its config inherit
 * another's credentials and then fetch under its own room prefix — a path
 * nothing had uploaded to, i.e. permanent 404s. An unarmed surface resolves to
 * `null` here and every file op no-ops instead.
 */
const backendConfigs = new Map<string, BackendConfig>();

/**
 * Rooms whose host intends to arm storage. Separates "never armed on purpose"
 * (a standalone or baked-in annotation surface, which must stay silent and make
 * no requests) from "should have been armed but wasn't", which is a real failure
 * and the only case reported below.
 */
const expectedBackends = new Map<string, FileErrorHandler | null>();

export const expectBackend = (
  roomId?: string | null,
  onFileError?: FileErrorHandler,
) => {
  if (roomId) {
    expectedBackends.set(roomId, onFileError || null);
  }
};

export const initializeBackend = (
  roomId: string,
  storageBackendUrl?: string,
  meetingDetails?: IMeetingDetails,
  onFileError?: FileErrorHandler,
) => {
  const baseUrl = storageBackendUrl || DEFAULT_BACKEND_BASE_URL;

  if (!roomId || !baseUrl) {
    return;
  }

  backendConfigs.set(roomId, {
    baseUrl,
    apiPrefix: BACKEND_API_PREFIX,
    meetingDetails: meetingDetails || null,
    onFileError: onFileError || null,
  });
};

// Drop a room's config when its Collab instance goes away, so a later surface
// reusing the same roomId can't pick up stale credentials.
export const releaseBackend = (roomId?: string | null) => {
  if (roomId) {
    backendConfigs.delete(roomId);
    expectedBackends.delete(roomId);
  }
};

const _getBackendConfig = (roomId?: string | null): BackendConfig | null => {
  if (!roomId) {
    return null;
  }

  return backendConfigs.get(roomId) ?? null;
};

const _errMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const _reportFileError = (
  onFileError: FileErrorHandler | null | undefined,
  error: ExcalidrawFileError,
) => {
  console.error(`Excalidraw file ${error.op} failed`, error);
  try {
    onFileError?.(error);
  } catch {
    // Reporting must never break the failure path it is reporting on.
  }
};

/**
 * Reports the one failure a missing config would otherwise hide: the surface was
 * meant to be armed but no backend was ever initialised, so every file op no-ops
 * without a single request to observe. Silent for surfaces that never opted in.
 */
const _reportUnarmedBackend = (
  roomId: string | null | undefined,
  op: ExcalidrawFileError["op"],
  fileIds: readonly FileId[],
) => {
  if (!roomId || !expectedBackends.has(roomId)) {
    return;
  }

  const onFileError = expectedBackends.get(roomId) || null;

  for (const fileId of new Set(fileIds)) {
    _reportFileError(onFileError, {
      op,
      fileId,
      message: "backend not initialized",
    });
  }
};

const _getAuthHeaders = (config: BackendConfig): Record<string, string> => {
  const headers: Record<string, string> = {};
  const token = config.meetingDetails?.token;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
};

// Helper function to upload files using Multer
const uploadFilesWithMulter = async (
  config: BackendConfig,
  prefix: string,
  files: { id: FileId; buffer: Uint8Array }[],
): Promise<{ savedFiles: FileId[]; erroredFiles: FileId[] }> => {
  if (!files || files.length === 0) {
    return { savedFiles: [], erroredFiles: [] };
  }

  const meetingDetails = config.meetingDetails;
  const baseUrl = `${config.baseUrl}${config.apiPrefix}`;

  if (!meetingDetails?.sessionId || !meetingDetails?.roomJid) {
    throw new Error("Missing required meeting details (sessionId or roomJid)");
  }

  const savedFiles: FileId[] = [];
  const erroredFiles: FileId[] = [];

  // Uploading sequentially
  for (const { id, buffer } of files) {
    try {
      const url = `${baseUrl}/sessions/${meetingDetails.sessionId}/files`;

      const fileMetaData = {
        conferenceFullName: meetingDetails.roomJid,
        fileId: id,
        fileSize: buffer.byteLength,
        timestamp: Date.now(),
        prefix,
      };

      const formData = new FormData();
      formData.append("metadata", JSON.stringify(fileMetaData));
      const blob = new Blob([new Uint8Array(buffer)], {
        type: "application/octet-stream",
      });
      formData.append("file", blob, id);

      const response = await fetch(url, {
        method: "POST",
        headers: _getAuthHeaders(config),
        body: formData,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        _reportFileError(config.onFileError, {
          op: "upload",
          fileId: id,
          status: response.status,
          message: `${response.statusText} ${text}`.trim(),
        });
        erroredFiles.push(id);
        continue;
      }

      const result = await response.json().catch(() => null);
      if (!result) {
        _reportFileError(config.onFileError, {
          op: "upload",
          fileId: id,
          status: response.status,
          message: "Invalid response",
        });
        erroredFiles.push(id);
        continue;
      }

      savedFiles.push(id);
    } catch (error) {
      _reportFileError(config.onFileError, {
        op: "upload",
        fileId: id,
        message: _errMessage(error),
      });
      erroredFiles.push(id);
    }
  }

  return { savedFiles, erroredFiles };
};

// Helper function to download files
const downloadFilesFromBackend = async (
  config: BackendConfig,
  prefix: string,
  fileIds: readonly FileId[],
) => {
  // Early return if no files to download
  if (!fileIds || fileIds.length === 0) {
    return { loadedFiles: [], erroredFiles: [] };
  }

  const baseUrl = `${config.baseUrl}${config.apiPrefix}`;
  const meetingDetails = config.meetingDetails;

  if (!meetingDetails?.sessionId || !meetingDetails?.roomJid) {
    throw new Error("Missing required meeting details (sessionId or roomJid)");
  }
  const loadedFiles: Array<{ id: FileId; buffer: Uint8Array }> = [];
  const erroredFiles: FileId[] = [];

  const headers = _getAuthHeaders(config);

  await Promise.all(
    [...new Set(fileIds)].map(async (id) => {
      try {
        // Read the bytes from our own API, not a presigned object-store URL.
        // These files are ciphertext, so JS must read the response body — and the
        // bucket's endpoint type cannot hold a CORS policy, so a cross-origin
        // body read can never succeed.
        const encodedFileId = encodeURIComponent(`${prefix}/${id}`);
        const url = `${baseUrl}/sessions/${meetingDetails.sessionId}/files/${encodedFileId}/content`;
        const response = await fetch(url, {
          method: "GET",
          headers,
        });

        if (response.ok) {
          const arrayBuffer = await response.arrayBuffer();
          loadedFiles.push({
            id,
            buffer: new Uint8Array(arrayBuffer),
          });
        } else {
          erroredFiles.push(id);
          _reportFileError(config.onFileError, {
            op: "download",
            fileId: id,
            status: response.status,
            message: response.statusText,
          });
        }
      } catch (error) {
        erroredFiles.push(id);
        _reportFileError(config.onFileError, {
          op: "download",
          fileId: id,
          message: _errMessage(error),
        });
      }
    }),
  );

  return { loadedFiles, erroredFiles };
};

class BackendBytes {
  private data: Uint8Array;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  static fromUint8Array(data: Uint8Array): BackendBytes {
    return new BackendBytes(data);
  }

  toUint8Array(): Uint8Array {
    return this.data;
  }

  toBase64(): string {
    return btoa(String.fromCharCode(...this.data));
  }

  static fromBase64(base64: string): BackendBytes {
    const binaryString = atob(base64);
    const data = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      data[i] = binaryString.charCodeAt(i);
    }
    return new BackendBytes(data);
  }
}

type StoredScene = {
  sceneVersion: number;
  iv: BackendBytes;
  ciphertext: BackendBytes;
};

const encryptElements = async (
  key: string,
  elements: readonly ExcalidrawElement[],
): Promise<{ ciphertext: ArrayBuffer; iv: Uint8Array }> => {
  const json = JSON.stringify(elements);
  const encoded = new TextEncoder().encode(json);
  const { encryptedBuffer, iv } = await encryptData(key, encoded);

  return { ciphertext: encryptedBuffer, iv };
};

const decryptElements = async (
  data: StoredScene,
  roomKey: string,
): Promise<readonly ExcalidrawElement[]> => {
  const ciphertext = data.ciphertext.toUint8Array();
  const iv = data.iv.toUint8Array();

  const decrypted = await decryptData(
    iv as Uint8Array<ArrayBuffer>,
    ciphertext as Uint8Array<ArrayBuffer>,
    roomKey,
  );
  const decodedData = new TextDecoder("utf-8").decode(
    new Uint8Array(decrypted),
  );
  return JSON.parse(decodedData);
};

class StorageSceneVersionCache {
  private static cache = new WeakMap<CollabSocket, number>();
  static get = (socket: CollabSocket) => {
    return StorageSceneVersionCache.cache.get(socket);
  };
  static set = (
    socket: CollabSocket,
    elements: readonly SyncableExcalidrawElement[],
  ) => {
    StorageSceneVersionCache.cache.set(socket, getSceneVersion(elements));
  };
}

export const isSavedToStorage = (
  portal: Portal,
  elements: readonly ExcalidrawElement[],
): boolean => {
  if (portal.socket && portal.roomId && portal.roomKey) {
    const sceneVersion = getSceneVersion(elements);

    return StorageSceneVersionCache.get(portal.socket) === sceneVersion;
  }
  // if no room exists, consider the room saved so that we don't unnecessarily
  // prevent unload (there's nothing we could do at that point anyway)
  return true;
};

export const saveFilesToStorage = async ({
  prefix,
  files,
  roomId,
}: {
  prefix: string;
  files: { id: FileId; buffer: Uint8Array }[];
  /** The collab room whose backend config owns these files. */
  roomId?: string | null;
}) => {
  if (!files || files.length === 0) {
    return { savedFiles: [], erroredFiles: [] };
  }

  const config = _getBackendConfig(roomId);

  // No backend was armed for this surface — stay silent rather than firing
  // requests under a prefix nothing owns.
  if (!config) {
    _reportUnarmedBackend(
      roomId,
      "upload",
      files.map(({ id }) => id),
    );

    return { savedFiles: [], erroredFiles: files.map(({ id }) => id) };
  }

  const erroredFiles: FileId[] = [];
  const savedFiles: FileId[] = [];

  try {
    const result = await uploadFilesWithMulter(config, prefix, files);

    savedFiles.push(...(result.savedFiles || []));
    erroredFiles.push(...(result.erroredFiles || []));
  } catch (error) {
    _reportFileError(config.onFileError, {
      op: "upload",
      message: _errMessage(error),
    });
    // Mark all files as errored if the API call fails
    files.forEach(({ id }) => erroredFiles.push(id));
  }

  return { savedFiles, erroredFiles };
};

const createStorageSceneDocument = async (
  elements: readonly SyncableExcalidrawElement[],
  roomKey: string,
) => {
  const sceneVersion = getSceneVersion(elements);
  const { ciphertext, iv } = await encryptElements(roomKey, elements);
  return {
    sceneVersion,
    ciphertext: BackendBytes.fromUint8Array(new Uint8Array(ciphertext)),
    iv: BackendBytes.fromUint8Array(iv),
  } as StoredScene;
};

// TODO: implement when backend scene persistence is ready
const getBackendDocument = async (
  _roomId: string,
): Promise<StoredScene | null> => {
  return null;
};

// TODO: implement when backend scene persistence is ready
const setBackendDocument = async (
  _roomId: string,
  _document: StoredScene,
): Promise<void> => {};

// Backend transaction simulation - using simple read-modify-write
const runBackendTransaction = async <T>(
  roomId: string,
  updateFunction: (document: StoredScene | null) => Promise<T>,
): Promise<T> => {
  const existingDocument = await getBackendDocument(roomId);
  const result = await updateFunction(existingDocument);
  return result;
};

export const saveToStorage = async (
  portal: Portal,
  elements: readonly SyncableExcalidrawElement[],
  appState: AppState,
) => {
  const { roomId, roomKey, socket } = portal;

  // Check if missing required fields (error case)
  if (!roomId || !roomKey || !socket) {
    console.error("Cannot save to storage: missing required fields", {
      roomId: !!roomId,
      roomKey: !!roomKey,
      socket: !!socket,
    });
    return null;
  }

  // Check if already saved (happy path - no need to log)
  if (isSavedToStorage(portal, elements)) {
    return null;
  }

  const storedScene = await runBackendTransaction(roomId, async (snapshot) => {
    if (!snapshot) {
      const storedScene = await createStorageSceneDocument(elements, roomKey);
      await setBackendDocument(roomId, storedScene);
      return storedScene;
    }

    const prevStoredScene = snapshot;
    const prevStoredElements = getSyncableElements(
      restoreElements(await decryptElements(prevStoredScene, roomKey), null),
    );
    const reconciledElements = getSyncableElements(
      reconcileElements(
        elements,
        prevStoredElements as OrderedExcalidrawElement[] as RemoteExcalidrawElement[],
        appState,
      ),
    );

    const storedScene = await createStorageSceneDocument(
      reconciledElements,
      roomKey,
    );

    await setBackendDocument(roomId, storedScene);

    // Return the stored elements as the in memory `reconciledElements` could have mutated in the meantime
    return storedScene;
  });

  const storedElements = getSyncableElements(
    restoreElements(await decryptElements(storedScene, roomKey), null),
  );

  StorageSceneVersionCache.set(socket, storedElements);

  return storedElements;
};

export const loadFromStorage = async (
  roomId: string,
  roomKey: string,
  socket: CollabSocket | null,
): Promise<readonly SyncableExcalidrawElement[] | null> => {
  const storedScene = await getBackendDocument(roomId);

  if (!storedScene) {
    return null;
  }

  const elements = getSyncableElements(
    restoreElements(await decryptElements(storedScene, roomKey), null),
  );

  if (socket) {
    StorageSceneVersionCache.set(socket, elements);
  }

  return elements;
};

export const loadFilesFromStorage = async (
  prefix: string,
  decryptionKey: string,
  filesIds: readonly FileId[],
  /** The collab room whose backend config owns these files. */
  roomId?: string | null,
) => {
  if (!filesIds || filesIds.length === 0) {
    return { loadedFiles: [], erroredFiles: new Map<FileId, true>() };
  }

  const loadedFiles: BinaryFileData[] = [];
  const erroredFiles = new Map<FileId, true>();

  const config = _getBackendConfig(roomId);

  // No backend was armed for this surface — see `backendConfigs`. Report the
  // ids as "not loaded" without issuing a request.
  if (!config) {
    _reportUnarmedBackend(roomId, "download", filesIds);
    filesIds.forEach((id) => erroredFiles.set(id, true));
    return { loadedFiles, erroredFiles };
  }

  try {
    const { loadedFiles: downloadedFiles, erroredFiles: downloadErrors } =
      await downloadFilesFromBackend(config, prefix, filesIds);

    await Promise.all(
      downloadedFiles.map(async ({ id, buffer }) => {
        try {
          const { data, metadata } = await decompressData<BinaryFileMetadata>(
            buffer,
            {
              decryptionKey,
            },
          );

          const dataURL = new TextDecoder().decode(data) as DataURL;

          loadedFiles.push({
            mimeType: metadata.mimeType || MIME_TYPES.binary,
            id: id as FileId,
            dataURL,
            created: metadata?.created || Date.now(),
            lastRetrieved: metadata?.created || Date.now(),
          });
        } catch (error) {
          erroredFiles.set(id as FileId, true);
          _reportFileError(config.onFileError, {
            op: "decrypt",
            fileId: id,
            message: _errMessage(error),
          });
        }
      }),
    );

    // Marking errored files from backend
    downloadErrors.forEach((id) => {
      erroredFiles.set(id as FileId, true);
    });
  } catch (error) {
    // Marking all files as errored if the API call fails
    _reportFileError(config.onFileError, {
      op: "download",
      message: _errMessage(error),
    });
    filesIds.forEach((id) => erroredFiles.set(id, true));
  }

  return { loadedFiles, erroredFiles };
};
