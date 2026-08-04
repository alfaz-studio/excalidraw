/**
 * @fileoverview Storage module for Excalidraw data persistence with external Jitsi backend.
 *
 * Handles scene archival, file management, and real-time collaboration through
 * JWT-authenticated API calls to the external backend service. Scenes are stored
 * as plain `.excalidraw` documents — see {@link StoredScene} for why they are not
 * encrypted; embedded image files still are.
 */
import { reconcileElements } from "@excalidraw/excalidraw";

import { getSceneVersion } from "@excalidraw/element";

import { restoreElements } from "@excalidraw/excalidraw/data/restore";

import { decompressData } from "@excalidraw/excalidraw/data/encode";
import {
  isValidExcalidrawData,
  serializeAsJSON,
} from "@excalidraw/excalidraw/data/json";
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

import type { CollabSocket } from "@excalidraw/excalidraw/types";

import { getSyncableElements } from ".";

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

/**
 * A scene as the storage backend holds it.
 *
 * Plain elements, not an encrypted blob: the room key lives only in the
 * meeting's room metadata, which is discarded when the meeting ends, so a scene
 * encrypted with it would become permanently unreadable exactly when someone
 * wants to open it. The archived object is therefore a real `.excalidraw` file.
 */
type StoredScene = {
  sceneVersion: number;
  elements: readonly ExcalidrawElement[];
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

/**
 * The scene object's fixed file id under the session — one board per meeting.
 *
 * Cross-repo contract: the dashboard API looks the object up by this exact name
 * (`WHITEBOARD_FILE_ID` in the sonacove repo's `apps/api/src/lib/whiteboard-store.ts`).
 * Changing it on one side alone makes archived boards silently stop appearing.
 */
const SCENE_FILE_ID = "whiteboard.excalidraw";

/**
 * Whether this participant archives the scene.
 *
 * Every peer runs the same save throttle, so without a single designated writer
 * they would all read-modify-write one object with no locking — upstream leaned
 * on Firebase transactions, which this backend has none of.
 */
const _canPersistScene = (): boolean => {
  const meetingDetails = _getMeetingDetails();

  return Boolean(
    meetingDetails?.sessionId &&
      _getToken() &&
      meetingDetails.canPersistScene === true,
  );
};

/** `…/sessions/<id>/files` — the session's file collection, or null pre-init. */
const _sessionFilesUrl = (): string | null => {
  const meetingDetails = _getMeetingDetails();

  if (!meetingDetails?.sessionId) {
    return null;
  }
  const api = _getBackendApi();

  return `${api.baseUrl}${api.apiPrefix}/sessions/${meetingDetails.sessionId}/files`;
};

const getBackendDocument = async (
  _roomId: string,
): Promise<StoredScene | null> => {
  const baseUrl = _sessionFilesUrl();

  if (!baseUrl || !_getToken()) {
    return null;
  }

  try {
    // The backend answers with a presigned URL rather than the bytes.
    const response = await fetch(`${baseUrl}/${SCENE_FILE_ID}`, {
      method: "GET",
      headers: _getAuthHeaders(),
    });

    // 404 is the ordinary "first save of this meeting" case, not a failure.
    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    if (!data?.presignedUrl) {
      return null;
    }

    const sceneResponse = await fetch(data.presignedUrl);
    if (!sceneResponse.ok) {
      return null;
    }

    const scene = await sceneResponse.json();

    if (!isValidExcalidrawData(scene)) {
      return null;
    }

    const elements = scene.elements ?? [];

    // Version is derived, never trusted from the file.
    return { sceneVersion: getSceneVersion(elements), elements };
  } catch (error) {
    console.error("Failed to load whiteboard scene from storage:", error);
    return null;
  }
};

const setBackendDocument = async (
  _roomId: string,
  document: StoredScene,
): Promise<void> => {
  const baseUrl = _sessionFilesUrl();
  const meetingDetails = _getMeetingDetails();

  if (!baseUrl || !meetingDetails) {
    return;
  }

  // `serializeAsJSON` in "database" mode is what every other export path uses,
  // so the archived object stays a canonical `.excalidraw` file and picks up
  // any future bump to VERSIONS.excalidraw for free.
  const body = serializeAsJSON(
    document.elements,
    {} as AppState,
    {},
    "database",
  );
  const blob = new Blob([body], { type: MIME_TYPES.excalidraw });

  const formData = new FormData();
  formData.append(
    "metadata",
    JSON.stringify({
      conferenceFullName: meetingDetails.roomJid,
      fileId: SCENE_FILE_ID,
      fileSize: blob.size,
      timestamp: Date.now(),
    }),
  );
  formData.append("file", blob, SCENE_FILE_ID);

  const response = await fetch(baseUrl, {
    method: "POST",
    headers: _getAuthHeaders(),
    body: formData,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Whiteboard scene upload failed: ${response.status} ${response.statusText} ${text}`,
    );
  }
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

  // Non-writers bail BEFORE the read: the read exists only to reconcile against
  // what is already stored ahead of a write, so for them it would be a full
  // scene download every throttle tick, thrown away — and marking the version
  // cache afterwards would claim elements were saved that never were.
  if (!_canPersistScene()) {
    return null;
  }

  // Check if already saved (happy path - no need to log)
  if (isSavedToStorage(portal, elements)) {
    return null;
  }

  // Read-modify-write, not a transaction: the backend offers no compare-and-set,
  // which is exactly why there is a single designated writer above.
  const snapshot = await getBackendDocument(roomId);
  const merged = snapshot
    ? getSyncableElements(
        reconcileElements(
          elements,
          getSyncableElements(
            restoreElements(snapshot.elements, null),
          ) as OrderedExcalidrawElement[] as RemoteExcalidrawElement[],
          appState,
        ),
      )
    : elements;

  await setBackendDocument(roomId, {
    sceneVersion: getSceneVersion(merged),
    elements: merged,
  });

  // Restored rather than returned as-is: `merged` may mutate in the meantime.
  const storedElements = getSyncableElements(restoreElements(merged, null));

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
    restoreElements(storedScene.elements, null),
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
