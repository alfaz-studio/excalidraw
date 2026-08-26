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
      const url = `${baseUrl}/sessions/${encodeURIComponent(
        meetingDetails.sessionId,
      )}/files`;

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
        const url = `${baseUrl}/sessions/${encodeURIComponent(
          meetingDetails.sessionId,
        )}/files/${encodedFileId}/content`;
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

/**
 * The scene object's fixed file id under the session — one board per meeting.
 *
 * Cross-repo contract: the dashboard API looks the object up by this exact name
 * (`WHITEBOARD_FILE_ID` in the sonacove repo's `apps/api/src/lib/whiteboard-store.ts`).
 * Changing it on one side alone makes archived boards silently stop appearing.
 */
const SCENE_FILE_ID = "whiteboard.excalidraw";

/**
 * The object name this room archives its scene under.
 *
 * Per room, not global: a surface may hold several scenes at once (the document tab keeps one
 * board per page, each its own collab room), and they would otherwise share one object and
 * overwrite each other. Falls back to the whiteboard's fixed name, so a caller that sets
 * nothing behaves exactly as before.
 */
const _sceneFileIdFor = (config: BackendConfig | null): string =>
  config?.meetingDetails?.sceneFileId || SCENE_FILE_ID;

/**
 * What happened to the archived scene, for the host to surface to the user.
 *
 * `sceneFileId` names WHICH scene. Several boards can be archiving at once — the whiteboard
 * stays mounted behind a visibility swap while the document tab keeps one scene per page — and
 * a listener that cannot tell them apart acts on another surface's outcome. It is the stable
 * discriminator: `whiteboard.excalidraw` for the board, `pdfdoc-<hash>-<page>.excalidraw` for a
 * document page.
 */
export type SceneArchiveEvent = {
  sceneFileId: string;
} & /** `final` marks the save the host asked for on the way out, as opposed to a
 *  routine throttled tick. Anything the host derives from the scene — a
 *  preview it otherwise rate-limits — must refresh on this one, because there
 *  is no later save to correct it. */ (
  | { status: "saved"; final?: boolean }
  | { status: "restored"; savedAt?: number }
  | { status: "failed"; error: unknown }
);

/**
 * A SET, not a slot.
 *
 * One slot meant the last surface to mount silently unregistered the others — and since the
 * events carried no identity, whichever listener survived also received outcomes belonging to
 * boards it knew nothing about. The whiteboard's listener uploads a preview on every `saved`,
 * so a document page's save would have uploaded a whiteboard thumbnail.
 */
const sceneArchiveListeners = new Set<(event: SceneArchiveEvent) => void>();

/**
 * Registers a host callback for scene-archive outcomes.
 *
 * Mirrors `setFileSaveOverride`: the fork owns the archival, the host owns how
 * (and whether) to tell the user about it. Without this the whole feature is
 * invisible — a user has no way to know their board outlives the meeting, and no
 * way to know when it did not.
 *
 * @param {Function|null} listener - Called on every outcome; null to unregister.
 * @returns {void}
 */
export const addSceneArchiveListener = (
  listener: (event: SceneArchiveEvent) => void,
) => {
  sceneArchiveListeners.add(listener);

  return () => {
    sceneArchiveListeners.delete(listener);
  };
};

/**
 * The live board's final-save, registered by the collab layer while it is
 * mounted. Null when no board is open.
 */
let sceneFlushHandler: (() => Promise<void>) | null = null;

/**
 * Registers the handler that {@link flushSceneArchive} drives.
 *
 * @param {Function|null} handler - Performs a final save; null to unregister.
 * @returns {void}
 */
export const setSceneFlushHandler = (handler: (() => Promise<void>) | null) => {
  sceneFlushHandler = handler;
};

/**
 * Archives the board NOW, and resolves when the upload has actually landed.
 *
 * For the host's leave flow. The unload-time saves cannot be awaited — nothing
 * can await a page that is going away — so they ride `keepalive`, which the spec
 * caps at 64 KiB of in-flight body. Above that cap the request is a plain fetch
 * racing navigation, and a busy board clears 56 KiB easily, so the edits since
 * the last 20s tick are exactly what gets dropped.
 *
 * Awaiting this BEFORE navigating removes the race instead of narrowing it: the
 * page is still alive, so no cap and no keepalive are involved. Resolves rather
 * than rejects on failure — a board that could not be saved must not be able to
 * trap the user in the meeting.
 *
 * @returns {Promise<void>} Resolves once the save settles, or immediately if no
 * board is open / this client is not the elected writer.
 */
export const flushSceneArchive = async (): Promise<void> => {
  try {
    await sceneFlushHandler?.();
  } catch (error) {
    console.error("Scene archive flush failed:", error);
  }
};

/** Never let a host listener's failure break the save path. */
const notifyArchive = (event: SceneArchiveEvent) => {
  for (const listener of sceneArchiveListeners) {
    try {
      listener(event);
    } catch (error) {
      // Per listener: one host's bad callback must not deprive the others of the event, nor
      // break the save path it is reporting on.
      console.error("Scene archive listener threw:", error);
    }
  }
};

/**
 * Whether this participant archives the scene.
 *
 * Every peer runs the same save throttle, so without a single designated writer
 * they would all read-modify-write one object with no locking — upstream leaned
 * on Firebase transactions, which this backend has none of.
 */
const _canPersistScene = (roomId: string | null | undefined): boolean => {
  const meetingDetails = _getBackendConfig(roomId)?.meetingDetails;

  return Boolean(
    meetingDetails?.sessionId &&
      meetingDetails.token &&
      meetingDetails.canPersistScene === true,
  );
};

/**
 * Whether this participant would archive the scene if asked.
 *
 * Exposed so a caller can skip the work of PREPARING a save it is not going to
 * perform. `saveToStorage` bails on the same condition, but only after the
 * caller has deep-cloned the entire element array — which every non-writer in
 * the meeting was doing, on its own main thread, while people draw.
 */
export const canPersistScene = (roomId: string | null | undefined): boolean =>
  _canPersistScene(roomId);

/**
 * `…/sessions/<id>/files` — the session's file collection, or null pre-init.
 *
 * The id is percent-encoded because it is a ROOM NAME, and a room name reached
 * as "quick meeting" is the literal string `quick%20meeting` — the meet client
 * encodes internal spaces on the way in and keeps them encoded. Interpolated
 * raw, that `%20` is decoded back to a space by the server's path parser, and
 * the id it compares against the token's `meeting_id` claim no longer matches:
 * every archive tick 403s with "SessionId mismatch" and the board is never
 * saved. Rooms with no encodable character were unaffected, which is why this
 * survived: it only breaks rooms with spaces in the name.
 */
/** The files endpoint for an ALREADY-RESOLVED config — see `setBackendDocument`'s `pinned`. */
const _filesUrlFor = (config: BackendConfig | null): string | null => {
  const sessionId = config?.meetingDetails?.sessionId;

  if (!config || !sessionId) {
    return null;
  }

  return `${config.baseUrl}${config.apiPrefix}/sessions/${encodeURIComponent(
    sessionId,
  )}/files`;
};

/**
 * Outcome of a read.
 *
 * "absent" and "error" MUST stay distinguishable. A write reconciles against
 * what it reads, so collapsing them means a transient 500 reads as "there is no
 * scene" and the next write replaces the stored board with whatever this client
 * happens to hold — which, for a writer whose own restore just failed, is
 * nothing. That is how a blip wipes a term's worth of a recurring class's board.
 */
type SceneReadResult =
  | { status: "found"; scene: StoredScene; savedAt?: number }
  | { status: "absent" }
  /** `reason` distinguishes the ways a read can fail. They all gate the write
   *  identically, but they reach the user's telemetry as one message otherwise,
   *  which cost a log join to tell "the request failed" from "the body was not a
   *  scene". */
  | { status: "error"; reason: string };

/**
 * Rooms this client has read and found EMPTY, and has not written to since.
 *
 * Only the designated writer is recorded. It is the only client that can put a scene there, so
 * its own "absent" answer stays true until it writes — no request can tell it anything it does
 * not already know. Every other client keeps reading, because for them the answer can change
 * under them at any time.
 *
 * This matters on a surface that switches rooms constantly: a document tab keeps one room per
 * page, and most pages of most decks are never drawn on, so without this a reader paging
 * through a deck issues a 404 per page per visit — for good measure, repeatedly, since
 * revisiting a page reads it again.
 */
const knownEmptyRooms = new Set<string>();

const getBackendDocument = async (
  roomId: string,
  /** See `setBackendDocument`'s `pinned` — the same teardown race applies to the read. */
  pinned?: BackendConfig | null,
): Promise<SceneReadResult> => {
  const config = pinned ?? _getBackendConfig(roomId);
  const baseUrl = _filesUrlFor(config);

  if (!config || !baseUrl || !config.meetingDetails?.token) {
    return { status: "error", reason: "no-backend-config" };
  }

  if (knownEmptyRooms.has(roomId)) {
    return { status: "absent" };
  }

  try {
    // Read the bytes from our own API, exactly as the image loader above does
    // and for the same reason: the presigned route hands back an object-store
    // URL, and reading THAT body in JS needs a CORS header the bucket's
    // endpoint type cannot be given. It fails on every board that has already
    // been archived once, which is every board after its first save.
    const response = await fetch(
      `${baseUrl}/${encodeURIComponent(_sceneFileIdFor(config))}/content`,
      {
        method: "GET",
        headers: _getAuthHeaders(config),
      },
    );

    // 404 is the ordinary "nothing archived yet" case. Anything else — 5xx, a
    // gateway timeout, an expired token — leaves us unable to say.
    if (response.status === 404) {
      // Remembered for the writer only — see `knownEmptyRooms`.
      if (_canPersistScene(roomId)) {
        knownEmptyRooms.add(roomId);
      }

      return { status: "absent" };
    }
    if (!response.ok) {
      return { status: "error", reason: `http-${response.status}` };
    }

    // The object's own mtime. Absent unless the content route forwards S3's
    // `Last-Modified`; `savedAt` is optional precisely so a deployment that does
    // not simply reports nothing rather than a wrong time.
    const lastModified = Date.parse(
      response.headers.get("last-modified") ?? "",
    );
    const scene = await response.json();

    // An object that exists but is not a scene cannot be reconciled against and
    // is not worth preserving — overwriting it is the repair.
    if (!isValidExcalidrawData(scene)) {
      console.warn("Archived whiteboard is not a valid scene; replacing it.");

      return { status: "absent" };
    }

    const elements = scene.elements ?? [];

    // Version is derived, never trusted from the file.
    return {
      status: "found",
      savedAt: Number.isNaN(lastModified) ? undefined : lastModified,
      scene: { sceneVersion: getSceneVersion(elements), elements },
    };
  } catch (error) {
    console.error("Failed to load whiteboard scene from storage:", error);

    return { status: "error", reason: "fetch-threw" };
  }
};

/**
 * Body ceiling for a `keepalive` request.
 *
 * The spec caps all in-flight keepalive bodies at 64 KiB and REJECTS anything
 * over it, so this must stay under that with room for the multipart envelope and
 * headers. A scene above the ceiling falls back to a normal request, which the
 * unload may cancel — `beforeUnload`'s confirm dialog is what covers that case.
 */
const KEEPALIVE_MAX_BYTES = 56 * 1024;

const setBackendDocument = async (
  roomId: string,
  document: StoredScene,
  opts?: { final?: boolean },
  /**
   * The config resolved when the save STARTED.
   *
   * A save is fired without being awaited — `stopCollaboration` does exactly that on the way
   * out — and `destroySocketClient` releases the room's config a moment later. Re-resolving it
   * here therefore finds nothing precisely on the final save of a session, and the write is
   * skipped silently: no POST, no error, and the last edits of a meeting are lost. Passing the
   * config the caller already holds removes that window.
   */
  pinned?: BackendConfig | null,
): Promise<void> => {
  // The room is about to stop being empty, so the memo above no longer holds. Dropped before
  // the write rather than after: a write that fails leaves the room in a state this client
  // cannot vouch for, and re-reading is the safe answer.
  knownEmptyRooms.delete(roomId);

  const config = pinned ?? _getBackendConfig(roomId);
  const baseUrl = _filesUrlFor(config);
  const meetingDetails = config?.meetingDetails;

  if (!config || !baseUrl || !meetingDetails) {
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
      fileId: _sceneFileIdFor(config),
      fileSize: blob.size,
      timestamp: Date.now(),
    }),
  );
  formData.append("file", blob, _sceneFileIdFor(config));

  // The last save of a meeting races the page going away: both `beforeUnload`
  // and `stopCollaboration` fire it without awaiting, and an ordinary fetch in
  // flight when the document unloads is cancelled — losing exactly the edits
  // nobody gets a second chance at. `keepalive` lets it outlive the page.
  const response = await fetch(baseUrl, {
    method: "POST",
    headers: _getAuthHeaders(config),
    body: formData,
    keepalive: Boolean(opts?.final) && blob.size <= KEEPALIVE_MAX_BYTES,
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
  opts?: { final?: boolean; flushed?: boolean },
) => {
  const { roomId, roomKey, socket } = portal;

  // Pinned for the whole save. `stopCollaboration` fires this without awaiting it and then
  // tears the session down, and that teardown releases the room's config — so by the time the
  // write runs, re-resolving would find nothing. That is precisely the FINAL save of a
  // session, the one whose loss nobody gets a second chance at.
  const pinnedConfig = _getBackendConfig(portal.roomId);

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
  if (!_canPersistScene(roomId)) {
    return null;
  }

  // A board that was opened and never drawn on is not a board. Archiving it puts
  // a whiteboard badge on the meeting and offers a blank download. Skipped only
  // while nothing has been stored yet: once a scene exists, an emptied board is a
  // deliberate clear that must overwrite it — and a cleared board still carries
  // tombstoned elements here, so it never reads as empty.
  if (
    elements.length === 0 &&
    StorageSceneVersionCache.get(socket) === undefined
  ) {
    return null;
  }

  // Check if already saved (happy path - no need to log)
  if (isSavedToStorage(portal, elements)) {
    return null;
  }

  let storedElements: readonly SyncableExcalidrawElement[];

  try {
    // Read-modify-write, not a transaction: the backend offers no compare-and-set,
    // which is exactly why there is a single designated writer above.
    const snapshot = await getBackendDocument(roomId, pinnedConfig);

    // Could not read: refuse to write. Overwriting a scene we failed to read
    // would discard whatever it held — and this client's own copy may be the
    // empty one, if its restore is what failed. Skipping costs one tick; the
    // next one retries, and the user is told so they can save to disk.
    if (snapshot.status === "error") {
      const error = new Error(
        `Whiteboard archive skipped: could not read the stored scene (${snapshot.reason})`,
      );

      notifyArchive({
        status: "failed",
        error,
        sceneFileId: _sceneFileIdFor(pinnedConfig),
      });

      return null;
    }

    const merged =
      snapshot.status === "found"
        ? getSyncableElements(
            reconcileElements(
              elements,
              getSyncableElements(
                restoreElements(snapshot.scene.elements, null),
              ) as OrderedExcalidrawElement[] as RemoteExcalidrawElement[],
              appState,
            ),
          )
        : elements;

    await setBackendDocument(
      roomId,
      { sceneVersion: getSceneVersion(merged), elements: merged },
      opts,
      pinnedConfig,
    );

    // Restored rather than returned as-is: `merged` may mutate in the meantime.
    storedElements = getSyncableElements(restoreElements(merged, null));
  } catch (error) {
    // Surfaced, not swallowed: the user believes the board is kept, and only
    // they can do anything about it (save it to disk before leaving).
    notifyArchive({
      status: "failed",
      error,
      sceneFileId: _sceneFileIdFor(pinnedConfig),
    });
    throw error;
  }

  StorageSceneVersionCache.set(socket, storedElements);
  notifyArchive({
    status: "saved",
    final: opts?.flushed,
    sceneFileId: _sceneFileIdFor(pinnedConfig),
  });

  return storedElements;
};

export const loadFromStorage = async (
  roomId: string,
  roomKey: string,
  socket: CollabSocket | null,
): Promise<readonly SyncableExcalidrawElement[] | null> => {
  const result = await getBackendDocument(roomId);

  // A failed read is reported: it is the difference between "this room has no
  // board" and "we could not tell", and only the second one means the writer
  // must not go on to overwrite it.
  if (result.status === "error") {
    notifyArchive({
      status: "failed",
      error: new Error(
        `Could not load the archived whiteboard (${result.reason})`,
      ),
      sceneFileId: _sceneFileIdFor(_getBackendConfig(roomId)),
    });

    return null;
  }

  if (result.status === "absent") {
    return null;
  }

  const elements = getSyncableElements(
    restoreElements(result.scene.elements, null),
  );

  // Content appearing on a board the user expected to be blank needs explaining.
  if (elements.length > 0) {
    notifyArchive({
      status: "restored",
      // When the stored scene was last written, so a host can tell marks made before this
      // meeting from marks made during it — the difference between "these were already here"
      // and the ordinary case of a page you drew on a moment ago.
      savedAt: result.savedAt,
      sceneFileId: _sceneFileIdFor(_getBackendConfig(roomId)),
    });
  }

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
