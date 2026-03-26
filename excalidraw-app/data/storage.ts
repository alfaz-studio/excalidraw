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
  IMeetingDetails,
} from "@excalidraw/excalidraw/types";
import type {
  ExcalidrawElement,
  FileId,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";

import type { RemoteExcalidrawElement } from "@excalidraw/excalidraw/data/reconcile";

import { getSyncableElements } from ".";

import type { Socket } from "socket.io-client";

import type { SyncableExcalidrawElement } from ".";
import type Portal from "../collab/Portal";

const BACKEND_CONFIG = {
  baseUrl:
    import.meta.env.VITE_APP_STORAGE_BACKEND_URL || "http://localhost:3000",
  apiPrefix: import.meta.env.VITE_APP_STORAGE_API_PREFIX || "/api/file-sharing",
};

let backendApi: { baseUrl: string; apiPrefix: string } | null = null;
let meetingDetailsCache: IMeetingDetails | null = null; // Cache for meeting details

// Initialize backend configuration with storageBackendUrl & meetingDetails (Token comes from meetingDetails)
export const initializeBackend = (
  storageBackendUrl?: string,
  meetingDetails?: IMeetingDetails,
) => {
  backendApi = {
    baseUrl: storageBackendUrl || BACKEND_CONFIG.baseUrl,
    apiPrefix: BACKEND_CONFIG.apiPrefix,
  };
  meetingDetailsCache = meetingDetails || null;
};

const _getBackendApi = () => {
  if (!backendApi) {
    backendApi = {
      baseUrl: BACKEND_CONFIG.baseUrl,
      apiPrefix: BACKEND_CONFIG.apiPrefix,
    };
  }
  return backendApi;
};

const _getToken = () => {
  return meetingDetailsCache?.token;
};

const _getMeetingDetails = (): IMeetingDetails | null => {
  return meetingDetailsCache;
};

export const loadStorage = async () => {
  return _getBackendApi();
};

const _getAuthHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = {};
  const token = _getToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
};

// Helper function to upload files using Multer
const uploadFilesWithMulter = async (
  prefix: string,
  files: { id: FileId; buffer: Uint8Array }[],
): Promise<{ savedFiles: FileId[]; erroredFiles: FileId[] }> => {
  if (!files || files.length === 0) {
    return { savedFiles: [], erroredFiles: [] };
  }

  const api = _getBackendApi();
  const meetingDetails = _getMeetingDetails();
  const baseUrl = `${api.baseUrl}${api.apiPrefix}`;

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
        headers: _getAuthHeaders(),
        body: formData,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        console.error(
          `Upload failed for file ${id}: ${response.status} ${response.statusText} ${text}`,
        );
        erroredFiles.push(id);
        continue;
      }

      const result = await response.json().catch(() => null);
      if (!result) {
        console.error(`Invalid response for file ${id}`);
        erroredFiles.push(id);
        continue;
      }

      savedFiles.push(id);
    } catch (error) {
      console.error(`Error uploading file ${id}:`, error);
      erroredFiles.push(id);
    }
  }

  return { savedFiles, erroredFiles };
};

// Helper function to download files
const downloadFilesFromBackend = async (
  prefix: string,
  fileIds: readonly FileId[],
) => {
  // Early return if no files to download
  if (!fileIds || fileIds.length === 0) {
    return { loadedFiles: [], erroredFiles: [] };
  }

  const api = _getBackendApi();
  const baseUrl = `${api.baseUrl}${api.apiPrefix}`;
  const meetingDetails = _getMeetingDetails();

  if (!meetingDetails?.sessionId || !meetingDetails?.roomJid) {
    throw new Error("Missing required meeting details (sessionId or roomJid)");
  }
  const loadedFiles: Array<{ id: FileId; buffer: Uint8Array }> = [];
  const erroredFiles: FileId[] = [];

  const headers = _getAuthHeaders();

  await Promise.all(
    [...new Set(fileIds)].map(async (id) => {
      try {
        const encodedFileId = encodeURIComponent(`${prefix}/${id}`);
        const url = `${baseUrl}/sessions/${meetingDetails.sessionId}/files/${encodedFileId}`;
        const response = await fetch(url, {
          method: "GET",
          headers,
        });

        if (response.ok) {
          // Backend returns { presignedUrl, fileName } - fetch the actual file from S3
          const data = await response.json();
          if (!data.presignedUrl) {
            console.error(`No presigned URL returned for file ${id}`);
            erroredFiles.push(id);
            return;
          }

          const fileResponse = await fetch(data.presignedUrl);
          if (!fileResponse.ok) {
            console.error(
              `Failed to download file from S3: ${id}, Status: ${fileResponse.status}`,
            );
            erroredFiles.push(id);
            return;
          }

          const arrayBuffer = await fileResponse.arrayBuffer();
          loadedFiles.push({
            id,
            buffer: new Uint8Array(arrayBuffer),
          });
        } else {
          erroredFiles.push(id);
          console.error(
            `Failed to download file: ${id}, Status: ${response.status}`,
          );
        }
      } catch (error) {
        erroredFiles.push(id);
        console.error(`Error downloading file ${id}:`, error);
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
  private static cache = new WeakMap<Socket, number>();
  static get = (socket: Socket) => {
    return StorageSceneVersionCache.cache.get(socket);
  };
  static set = (
    socket: Socket,
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
}: {
  prefix: string;
  files: { id: FileId; buffer: Uint8Array }[];
}) => {
  if (!files || files.length === 0) {
    return { savedFiles: [], erroredFiles: [] };
  }

  const erroredFiles: FileId[] = [];
  const savedFiles: FileId[] = [];

  try {
    const result = await uploadFilesWithMulter(prefix, files);

    savedFiles.push(...(result.savedFiles || []));
    erroredFiles.push(...(result.erroredFiles || []));
  } catch (error) {
    console.error("Error uploading files to backend:", error);
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
  socket: Socket | null,
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
) => {
  if (!filesIds || filesIds.length === 0) {
    return { loadedFiles: [], erroredFiles: new Map<FileId, true>() };
  }

  const loadedFiles: BinaryFileData[] = [];
  const erroredFiles = new Map<FileId, true>();

  try {
    const { loadedFiles: downloadedFiles, erroredFiles: downloadErrors } =
      await downloadFilesFromBackend(prefix, filesIds);

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
          console.error("Error processing file:", id, error);
        }
      }),
    );

    // Marking errored files from backend
    downloadErrors.forEach((id) => {
      erroredFiles.set(id as FileId, true);
    });
  } catch (error) {
    // Marking all files as errored if the API call fails
    console.error("Error loading files from backend:", error);
    filesIds.forEach((id) => erroredFiles.set(id, true));
  }

  return { loadedFiles, erroredFiles };
};
