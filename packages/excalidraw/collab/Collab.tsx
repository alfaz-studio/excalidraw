import {
  CaptureUpdateAction,
  getSceneVersion,
  restoreElements,
  zoomToFitBounds,
  reconcileElements,
} from "@excalidraw/excalidraw";
import { ErrorDialog } from "@excalidraw/excalidraw/components/ErrorDialog";
import { APP_NAME, EVENT } from "@excalidraw/common";
import {
  IDLE_THRESHOLD,
  ACTIVE_THRESHOLD,
  UserIdleState,
  assertNever,
  isDevEnv,
  isTestEnv,
  preventUnload,
  resolvablePromise,
  throttleRAF,
} from "@excalidraw/common";
import { decryptData } from "@excalidraw/excalidraw/data/encryption";
import { getVisibleSceneBounds } from "@excalidraw/element";
import { newElementWith } from "@excalidraw/element";
import { isImageElement, isInitializedImageElement } from "@excalidraw/element";
import { AbortError } from "@excalidraw/excalidraw/errors";
import { t } from "@excalidraw/excalidraw/i18n";
import { withBatchedUpdates } from "@excalidraw/excalidraw/reactUtils";

import throttle from "lodash.throttle";
import { PureComponent } from "react";

import type {
  ReconciledExcalidrawElement,
  RemoteExcalidrawElement,
} from "@excalidraw/excalidraw/data/reconcile";
import type { ImportedDataState } from "@excalidraw/excalidraw/data/types";
import type {
  ExcalidrawElement,
  FileId,
  InitializedExcalidrawImageElement,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";
import type {
  BinaryFileData,
  SocketId,
  Collaborator,
  CollabSocket,
  Gesture,
  ExcalidrawCollabProps,
  ExcalidrawFileError,
  IMeetingDetails,
} from "@excalidraw/excalidraw/types";
import type { Mutable, ValueOf } from "@excalidraw/common/utility-types";

import { appJotaiStore, atom } from "../../../excalidraw-app/app-jotai";
import {
  CURSOR_SYNC_TIMEOUT,
  STALE_COLLABORATOR_TIMEOUT_MS,
  STALE_CHECK_INTERVAL_MS,
  FILE_UPLOAD_MAX_BYTES,
  FIREBASE_STORAGE_PREFIXES,
  INITIAL_SCENE_UPDATE_TIMEOUT,
  LOAD_IMAGES_TIMEOUT,
  WS_SUBTYPES,
  SYNC_FULL_SCENE_INTERVAL_MS,
  WS_EVENTS,
} from "../../../excalidraw-app/app_constants";
import {
  generateCollaborationLinkData,
  getCollaborationLink,
  getSyncableElements,
} from "../../../excalidraw-app/data";
import {
  encodeFilesForUpload,
  FileManager,
  updateStaleImageStatuses,
} from "../../../excalidraw-app/data/FileManager";
import { LocalData } from "../../../excalidraw-app/data/LocalData";
import {
  loadFilesFromStorage,
  loadFromStorage,
  saveFilesToStorage,
  saveToStorage,
  initializeBackend,
  releaseBackend,
  expectBackend,
} from "../../../excalidraw-app/data/storage";
import {
  importUsernameFromLocalStorage,
  saveUsernameToLocalStorage,
} from "../../../excalidraw-app/data/localStorage";
import { resetBrowserStateVersions } from "../../../excalidraw-app/data/tabSync";

import { collabErrorIndicatorAtom } from "../../../excalidraw-app/collab/CollabError";
import Portal from "../../../excalidraw-app/collab/Portal";

import type {
  SocketUpdateDataSource,
  SyncableExcalidrawElement,
} from "../../../excalidraw-app/data";

export const collabAPIAtom = atom<CollabAPI | null>(null);
export const isCollaboratingAtom = atom(false);
export const isOfflineAtom = atom(false);

interface CollabState {
  errorMessage: string | null;
  /** errors related to saving */
  dialogNotifiedErrors: Record<string, boolean>;
  username: string;
  activeRoomLink: string | null;
}

export const activeRoomLinkAtom = atom<string | null>(null);

type CollabInstance = InstanceType<typeof Collab>;

export interface CollabAPI {
  /** function so that we can access the latest value from stale callbacks */
  isCollaborating: () => boolean;
  onPointerUpdate: CollabInstance["onPointerUpdate"];
  startCollaboration: CollabInstance["startCollaboration"];
  leaveRoom: CollabInstance["leaveRoom"];
  stopCollaboration: CollabInstance["stopCollaboration"];
  syncElements: CollabInstance["syncElements"];
  fetchImageFilesFromFirebase: CollabInstance["fetchImageFilesFromFirebase"];
  setUsername: CollabInstance["setUsername"];
  getUsername: CollabInstance["getUsername"];
  getActiveRoomLink: CollabInstance["getActiveRoomLink"];
  setCollabError: CollabInstance["setErrorDialog"];
}

// interface CollabProps {
//   excalidrawAPI: ExcalidrawImperativeAPI;
// }

const textDecoder = new TextDecoder("utf-8");

class Collab extends PureComponent<ExcalidrawCollabProps, CollabState> {
  portal: Portal;
  fileManager: FileManager;
  excalidrawAPI: ExcalidrawCollabProps["excalidrawAPI"];
  activeIntervalId: number | null;
  idleTimeoutId: number | null;

  private socketInitializationTimer?: number;
  private lastBroadcastedOrReceivedSceneVersion: number = -1;

  /** A stored scene whose reconcile is waiting for the current stroke to finish. */
  private pendingStoredScene: readonly ExcalidrawElement[] | null = null;

  /**
   * Bumped whenever a collab session starts or ends.
   *
   * Several paths fetch a scene and apply it after an await — the storage read on joining an
   * empty room, the merge of a persisted scene when a peer sends nothing, the reconcile that
   * follows a save. Each was written when a session lasted as long as the component did, so
   * "am I still collaborating" was the same question as "is this still the session I fetched
   * for". On a surface that switches rooms — a document tab keeps one per page — those come
   * apart, and a fetch that lands after a page turn merges the previous page's marks into the
   * one now on screen. Capture this before an await, compare after.
   */
  private sessionGeneration = 0;
  private collaborators = new Map<SocketId, Collaborator>();
  private collaboratorLastSeen = new Map<SocketId, number>();
  private staleCollaboratorTimerId: number | null = null;
  private clientId = crypto.randomUUID();

  /**
   * SONACOVE: the identity stamped onto this client's elements. Prefers the
   * host-supplied id (a Sonacove participant id, stable across a reconnect) and
   * falls back to `clientId` so ownership still works standalone — but note the
   * fallback is regenerated per Collab instance, so a reconnect would orphan
   * earlier strokes. See elementOwnership.ts.
   */
  getElementAuthorId = (): string =>
    this.props.elementAuthorId ?? this.clientId;

  /** SONACOVE: see StorageCapabilities. Both halves default on once armed. */
  get filesEnabled(): boolean {
    return (
      Boolean(this.props.storageBackendUrl) &&
      (this.props.storageCapabilities?.files ?? true)
    );
  }

  get sceneEnabled(): boolean {
    return (
      Boolean(this.props.storageBackendUrl) &&
      (this.props.storageCapabilities?.scene ?? true)
    );
  }

  constructor(props: ExcalidrawCollabProps) {
    super(props);
    this.state = {
      errorMessage: null,
      dialogNotifiedErrors: {},
      username: importUsernameFromLocalStorage() || "",
      activeRoomLink: null,
    };
    this.portal = new Portal(this as any);
    this.fileManager = new FileManager({
      getFiles: async (fileIds) => {
        const { roomId, roomKey } = this.portal;

        // Not an abort: callers of `fetchImageFilesFromFirebase` don't catch,
        // so a surface with file storage off must resolve empty rather than
        // reject.
        if (!this.filesEnabled) {
          return { loadedFiles: [], erroredFiles: new Map() };
        }

        if (!roomId || !roomKey) {
          throw new AbortError();
        }

        return loadFilesFromStorage(
          `files/rooms/${roomId}`,
          roomKey,
          fileIds,
          roomId,
        );
      },
      saveFiles: async ({ addedFiles }) => {
        const { roomId, roomKey } = this.portal;
        if (!roomId || !roomKey || !this.filesEnabled) {
          throw new AbortError();
        }

        const { savedFiles, erroredFiles } = await saveFilesToStorage({
          prefix: `${FIREBASE_STORAGE_PREFIXES.collabFiles}/${roomId}`,
          files: await encodeFilesForUpload({
            files: addedFiles,
            encryptionKey: roomKey,
            maxBytes: FILE_UPLOAD_MAX_BYTES,
          }),
          roomId,
        });

        return {
          savedFiles: savedFiles.reduce(
            (acc: Map<FileId, BinaryFileData>, id: FileId) => {
              const fileData = addedFiles.get(id);
              if (fileData) {
                acc.set(id, fileData);
              }
              return acc;
            },
            new Map(),
          ),
          erroredFiles: erroredFiles.reduce(
            (acc: Map<FileId, BinaryFileData>, id: FileId) => {
              const fileData = addedFiles.get(id);
              if (fileData) {
                acc.set(id, fileData);
              }
              return acc;
            },
            new Map(),
          ),
        };
      },
    });
    this.excalidrawAPI = props.excalidrawAPI;
    this.activeIntervalId = null;
    this.idleTimeoutId = null;
  }

  private onUmmount: (() => void) | null = null;

  componentDidMount() {
    window.addEventListener(EVENT.BEFORE_UNLOAD, this.beforeUnload);
    window.addEventListener("online", this.onOfflineStatusToggle);
    window.addEventListener("offline", this.onOfflineStatusToggle);
    window.addEventListener(EVENT.UNLOAD, this.onUnload);

    const unsubOnUserFollow = this.excalidrawAPI.onUserFollow((payload) => {
      this.portal.socket && this.portal.broadcastUserFollowed(payload);
    });
    const throttledRelayUserViewportBounds = throttleRAF(
      this.relayVisibleSceneBounds,
    );
    const unsubOnScrollChange = this.excalidrawAPI.onScrollChange(() =>
      throttledRelayUserViewportBounds(),
    );
    this.onUmmount = () => {
      unsubOnUserFollow();
      unsubOnScrollChange();
    };

    this.onOfflineStatusToggle();

    const collabAPI: CollabAPI = {
      isCollaborating: this.isCollaborating,
      onPointerUpdate: this.onPointerUpdate,
      startCollaboration: this.startCollaboration,
      leaveRoom: this.leaveRoom,
      syncElements: this.syncElements,
      fetchImageFilesFromFirebase: this.fetchImageFilesFromFirebase,
      stopCollaboration: this.stopCollaboration,
      setUsername: this.setUsername,
      getUsername: this.getUsername,
      getActiveRoomLink: this.getActiveRoomLink,
      setCollabError: this.setErrorDialog,
    };

    appJotaiStore.set(collabAPIAtom, collabAPI);

    // The atom above is shared by every mounted board; this is how the app that rendered THIS
    // one gets THIS one. See `onCollabAPI`.
    this.props.onCollabAPI?.(collabAPI);

    if (this.props.useTestEnv) {
      window.collab = window.collab || ({} as Window["collab"]);
      Object.defineProperties(window, {
        collab: {
          configurable: true,
          value: this,
        },
      });
    }
  }

  onOfflineStatusToggle = () => {
    appJotaiStore.set(isOfflineAtom, !window.navigator.onLine);
  };

  componentDidUpdate(prevProps: ExcalidrawCollabProps) {
    // Re-initialize storage backend when the token changes (initial fetch or refresh)
    const { storageBackendUrl, meetingDetails } = this.props;
    if (
      storageBackendUrl &&
      meetingDetails?.token &&
      meetingDetails.token !== prevProps.meetingDetails?.token
    ) {
      this.armBackend(storageBackendUrl, meetingDetails);
    }
  }

  /**
   * `portal.roomId` is only set once `portal.open()` runs, two awaits into
   * startCollaboration. A token arriving inside that window has no room to arm,
   * so it is stashed and flushed the moment the room exists — otherwise neither
   * path initialises the backend and every file op silently no-ops.
   */
  private pendingBackendConfig: {
    storageBackendUrl: string;
    meetingDetails: IMeetingDetails;
  } | null = null;

  private armBackend = (
    storageBackendUrl: string,
    meetingDetails: IMeetingDetails,
  ) => {
    if (!this.portal.roomId) {
      this.pendingBackendConfig = { storageBackendUrl, meetingDetails };
      return;
    }

    this.pendingBackendConfig = null;
    initializeBackend(
      this.portal.roomId,
      storageBackendUrl,
      meetingDetails,
      this.onFileError,
    );
  };

  private flushPendingBackendConfig = () => {
    const pending = this.pendingBackendConfig;

    if (pending) {
      this.armBackend(pending.storageBackendUrl, pending.meetingDetails);
    }
  };

  /** Late-bound so a prop swap after initializeBackend still reaches the host. */
  private onFileError = (error: ExcalidrawFileError) => {
    this.props.onFileError?.(error);
  };

  componentWillUnmount() {
    window.removeEventListener("online", this.onOfflineStatusToggle);
    window.removeEventListener("offline", this.onOfflineStatusToggle);
    window.removeEventListener(EVENT.BEFORE_UNLOAD, this.beforeUnload);
    window.removeEventListener(EVENT.UNLOAD, this.onUnload);
    window.removeEventListener(EVENT.POINTER_MOVE, this.onPointerMove);
    window.removeEventListener(
      EVENT.VISIBILITY_CHANGE,
      this.onVisibilityChange,
    );
    if (this.activeIntervalId) {
      window.clearInterval(this.activeIntervalId);
      this.activeIntervalId = null;
    }
    if (this.idleTimeoutId) {
      window.clearTimeout(this.idleTimeoutId);
      this.idleTimeoutId = null;
    }
    if (this.staleCollaboratorTimerId) {
      window.clearInterval(this.staleCollaboratorTimerId);
      this.staleCollaboratorTimerId = null;
    }
    this.onUmmount?.();

    // Close the socket.io connection to prevent runaway reconnection loops
    // that can exhaust browser WebSocket resources and crash the meeting.
    // Content is preserved server-side and re-synced on reconnect.
    this.destroySocketClient({ isUnload: true });
  }

  isCollaborating = () => appJotaiStore.get(isCollaboratingAtom)!;

  private setIsCollaborating = (isCollaborating: boolean) => {
    appJotaiStore.set(isCollaboratingAtom, isCollaborating);
  };

  private onUnload = () => {
    this.destroySocketClient({ isUnload: true });
  };

  private beforeUnload = withBatchedUpdates((event: BeforeUnloadEvent) => {
    const syncableElements = getSyncableElements(
      this.getSceneElementsIncludingDeleted(),
    );

    if (
      this.isCollaborating() &&
      this.fileManager.shouldPreventUnload(syncableElements)
      // || !isSavedToFirebase(this.portal, syncableElements)
    ) {
      // this won't run in time if user decides to leave the site, but
      //  the purpose is to run in immediately after user decides to stay
      this.saveCollabRoomToFirebase(syncableElements);

      preventUnload(event);
    }
  });

  saveCollabRoomToFirebase = async (
    syncableElements: readonly SyncableExcalidrawElement[],
  ) => {
    // Scene persistence off: the reconcile below would re-apply a stored
    // snapshot over whatever the user is drawing right now.
    if (!this.sceneEnabled) {
      return;
    }

    const generation = this.sessionGeneration;

    try {
      const storedElements = await saveToStorage(
        this.portal,
        syncableElements,
        this.excalidrawAPI.getAppState(),
      );

      if (!storedElements) {
        return;
      }

      this.resetErrorIndicator();

      if (generation !== this.sessionGeneration) {
        return;
      }

      if (this.isCollaborating()) {
        this.applyStoredScene(storedElements);
      }
    } catch (error) {
      console.error("Failed to save collab room:", error);
    }
  };

  /**
   * Archives what is on the board for the room being left, and detaches from it.
   *
   * Split out of `stopCollaboration` so `leaveRoom` can leave a room WITHOUT the second
   * archive a full stop would perform — that one runs after the caller has repainted, and
   * would write the incoming page's marks into the outgoing page's storage.
   *
   * Every statement here is synchronous: the archive reads the scene as it stands now and
   * hands it on by value, so a repaint immediately afterwards cannot corrupt it.
   */
  private archiveAndDetach = (opts: { keepCollaborating: boolean }) => {
    this.queueBroadcastAllElements.cancel();
    this.queueSaveToFirebase.cancel();
    this.loadImageFiles.cancel();
    this.resetErrorIndicator(true);

    // Only what a room actually holds gets archived. Without a socket there is no room to
    // write to and `saveToStorage` would bail anyway — but loudly, on `console.error`, which
    // on a surface that leaves a room per page turn is a steady stream of alarming noise
    // about a save that was never possible.
    if (this.portal.socket) {
      this.saveCollabRoomToFirebase(
        getSyncableElements(
          this.excalidrawAPI.getSceneElementsIncludingDeleted(),
        ),
      );
    }

    if (this.portal.socket && this.fallbackInitializationHandler) {
      this.portal.socket.off(
        "connect_error",
        this.fallbackInitializationHandler,
      );
    }

    LocalData.fileStorage.reset();
    this.destroySocketClient({ keepCollaborating: opts.keepCollaborating });
  };

  /**
   * Leaves the current room — archiving what it holds — without ending the session.
   *
   * The half of a room change that has to happen AT the change. A surface that keeps one room
   * per page joins on a debounce, so leaving and joining are deliberately separated in time;
   * fusing them into one "switch" would archive the outgoing room 450ms late, by which point
   * the board is showing the page that replaced it, and the wrong marks get written.
   *
   * ⚠️ Synchronous, and callers depend on that: it is what lets them repaint immediately
   * afterwards. The archive reads the scene as it stands now, so the repaint cannot corrupt
   * it, and with the room detached the repaint can be neither broadcast nor archived anywhere.
   *
   * Also the only way to abandon a join that is still in flight. `destroySocketClient` bumps
   * the session generation, which `startCollaboration` re-checks once its transport connects —
   * so a join whose page has since been turned away from closes its socket instead of opening
   * a session on a room nobody is looking at any more.
   *
   * @param {object} opts - `keepCollaborating` when another room follows immediately, so the
   * flag does not flap and re-commit the toolbar on every page turn.
   * @returns {void}
   */
  leaveRoom = (opts?: { keepCollaborating?: boolean }) => {
    this.archiveAndDetach({
      keepCollaborating: opts?.keepCollaborating ?? false,
    });
  };

  stopCollaboration = (keepRemoteState = true) => {
    if (!keepRemoteState) {
      this.archiveAndDetach({ keepCollaborating: false });

      return;
    }

    this.queueBroadcastAllElements.cancel();
    this.queueSaveToFirebase.cancel();
    this.loadImageFiles.cancel();
    this.resetErrorIndicator(true);

    this.saveCollabRoomToFirebase(
      getSyncableElements(
        this.excalidrawAPI.getSceneElementsIncludingDeleted(),
      ),
    );

    if (this.portal.socket && this.fallbackInitializationHandler) {
      this.portal.socket.off(
        "connect_error",
        this.fallbackInitializationHandler,
      );
    }

    if (window.confirm(t("alerts.collabStopOverridePrompt"))) {
      // hack to ensure that we prefer we disregard any new browser state
      // that could have been saved in other tabs while we were collaborating
      resetBrowserStateVersions();

      window.history.pushState({}, APP_NAME, window.location.origin);
      this.destroySocketClient();

      LocalData.fileStorage.reset();

      const elements = this.excalidrawAPI
        .getSceneElementsIncludingDeleted()
        .map((element) => {
          if (isImageElement(element) && element.status === "saved") {
            return newElementWith(element, { status: "pending" });
          }
          return element;
        });

      this.excalidrawAPI.updateScene({
        elements,
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    }
  };

  private destroySocketClient = (opts?: {
    isUnload?: boolean;

    /** Set by `leaveRoom`: the session continues in another room — see below. */
    keepCollaborating?: boolean;
  }) => {
    // Every teardown path funnels through here, and `portal.close()` below nulls
    // the roomId — so this is the only place the config is reliably released.
    releaseBackend(this.portal.roomId);
    this.pendingBackendConfig = null;

    if (this.staleCollaboratorTimerId) {
      window.clearInterval(this.staleCollaboratorTimerId);
      this.staleCollaboratorTimerId = null;
    }
    this.collaboratorLastSeen.clear();
    this.lastBroadcastedOrReceivedSceneVersion = -1;

    // Belongs to the room being torn down — if carried into the next one, it would merge a
    // stale board into it.
    this.pendingStoredScene = null;
    this.sessionGeneration++;
    this.portal.close();
    this.fileManager.reset();
    if (!opts?.isUnload) {
      this.setActiveRoomLink(null);
      this.collaborators = new Map();
      this.excalidrawAPI.updateScene({
        collaborators: this.collaborators,
      });

      // A switch re-joins in the same breath, so the session never actually ends. Dropping the
      // flag and raising it again re-commits excalidraw's whole toolbar on every page turn —
      // which is how a relocated laser button ended up duplicated once per turn — and churns
      // React exactly while someone is flipping through a deck.
      if (!opts?.keepCollaborating) {
        this.setIsCollaborating(false);
        LocalData.resumeSave("collaboration");
      }
    }
  };

  private fetchImageFilesFromFirebase = async (opts: {
    elements: readonly ExcalidrawElement[];
    /**
     * Indicates whether to fetch files that are errored or pending and older
     * than 10 seconds.
     *
     * Use this as a mechanism to fetch files which may be ok but for some
     * reason their status was not updated correctly.
     */
    forceFetchFiles?: boolean;
  }) => {
    const unfetchedImages = opts.elements
      .filter((element) => {
        return (
          isInitializedImageElement(element) &&
          !this.fileManager.isFileTracked(element.fileId) &&
          !element.isDeleted &&
          (opts.forceFetchFiles
            ? element.status !== "pending" ||
              Date.now() - element.updated > 10000
            : element.status === "saved")
        );
      })
      .map((element) => (element as InitializedExcalidrawImageElement).fileId);

    return await this.fileManager.getFiles(unfetchedImages);
  };

  private decryptPayload = async (
    iv: Uint8Array,
    encryptedData: ArrayBuffer,
    decryptionKey: string,
  ): Promise<ValueOf<SocketUpdateDataSource>> => {
    try {
      // Empty IV = plaintext (no encryption)
      if (iv.byteLength === 0) {
        return JSON.parse(textDecoder.decode(new Uint8Array(encryptedData)));
      }

      const decrypted = await decryptData(
        iv as Uint8Array<ArrayBuffer>,
        encryptedData,
        decryptionKey,
      );

      return JSON.parse(textDecoder.decode(new Uint8Array(decrypted)));
    } catch (error) {
      window.alert(t("alerts.decryptFailed"));
      console.error(error);
      return {
        type: WS_SUBTYPES.INVALID_RESPONSE,
      };
    }
  };

  private fallbackInitializationHandler: null | (() => any) = null;

  startCollaboration = async (
    existingRoomLinkData: null | { roomId: string; roomKey: string },
  ) => {
    if (!this.state.username) {
      import("@excalidraw/random-username").then(({ getRandomUsername }) => {
        // Don't overwrite a username that was set while loading
        if (!this.state.username) {
          const username = getRandomUsername();
          this.setUsername(username);
        }
      });
    }

    if (this.portal.socket) {
      return null;
    }

    let roomId;
    let roomKey;

    if (existingRoomLinkData) {
      ({ roomId, roomKey } = existingRoomLinkData);
    } else {
      ({ roomId, roomKey } = await generateCollaborationLinkData());
      window.history.pushState(
        {},
        APP_NAME,
        getCollaborationLink({ roomId, roomKey }),
      );
    }

    // Initialize storage backend if storageBackendUrl & jwt are provided
    const { storageBackendUrl, meetingDetails } = this.props;

    // Marks the room as one that is *meant* to have storage, so a later file op
    // that finds no config can tell "never armed on purpose" from a real gap.
    if (storageBackendUrl) {
      expectBackend(roomId, this.onFileError);
    }

    if (
      storageBackendUrl &&
      meetingDetails?.sessionId &&
      meetingDetails.token
    ) {
      try {
        if (!meetingDetails.sessionId) {
          console.warn("Missing sessionId in whiteboard");
        }
        if (!meetingDetails.token) {
          console.warn("Missing token in whiteboard");
        }
        initializeBackend(
          roomId,
          storageBackendUrl,
          meetingDetails,
          this.onFileError,
        );
      } catch (error) {
        console.error("Failed to initialize storage backend:", error);
        this.setErrorDialog(
          `Storage initialization failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    } else {
      // eslint-disable-next-line no-console
      console.log("Storage not initialized missing");
    }

    // TODO: `ImportedDataState` type here seems abused
    const scenePromise = resolvablePromise<
      | (ImportedDataState & { elements: readonly OrderedExcalidrawElement[] })
      | null
    >();

    this.setIsCollaborating(true);
    LocalData.pauseSave("collaboration");

    const createSocket = async (): Promise<CollabSocket> => {
      // Host-injected transport (e.g. LiveKit data channels in Sonacove
      // Meets) — bypasses the socket.io relay entirely, so the socket.io
      // client chunk is never even fetched.
      if (this.props.collabSocketFactory) {
        return await this.props.collabSocketFactory({ roomId });
      }

      const { default: socketIOClient } = await import(
        /* webpackChunkName: "socketIoClient" */ "socket.io-client"
      );

      return socketIOClient(this.props.collabServerUrl || "", {
        transports: ["websocket", "polling"],
        // Keep reconnecting for the lifetime of the Collab instance.
        // componentWillUnmount calls destroySocketClient(), which is what
        // prevents the leaked-socket crash the old 5-attempt cap was
        // guarding against. An attempt cap just strands real users on
        // flaky networks.
        reconnection: true,
        reconnectionDelay: 500,
        reconnectionDelayMax: 5000,
        query: {
          roomId,
        },
      });
    };

    const fallbackInitializationHandler = () => {
      this.initializeRoom({
        roomLinkData: existingRoomLinkData,
        fetchScene: true,
      }).then((scene) => {
        scenePromise.resolve(scene);
      });
    };
    this.fallbackInitializationHandler = fallbackInitializationHandler;

    try {
      const { meetingDetails } = this.props;
      const generation = this.sessionGeneration;
      const socket = await createSocket();

      // The room was left while its transport was still connecting. Nothing checked this
      // before, so the session opened anyway — on a surface that switches rooms, that meant a
      // live socket on the page you had already turned away from, and the marks you drew next
      // being broadcast and archived under it.
      if (generation !== this.sessionGeneration) {
        socket.close();
        LocalData.resumeSave("collaboration");

        return null;
      }

      this.portal.socket = this.portal.open(
        socket,
        roomId,
        roomKey,
        meetingDetails
          ? {
              meetingId: meetingDetails.sessionId,
              roomName: meetingDetails.roomJid,
              sceneType: meetingDetails.sceneType || "whiteboard",
              clientId: this.clientId,
            }
          : { clientId: this.clientId },
      );

      this.flushPendingBackendConfig();

      // The room is LIVE here — outgoing edits broadcast from this point. What still lies
      // ahead is the SEED: waiting to learn whether anyone else is present, then two round
      // trips for the stored scene. Callers that ask "are my marks reaching anyone" must be
      // answered now and not when `startCollaboration` finally resolves, or they report a
      // healthy session as unshared for well over a second.
      this.props.onRoomOpen?.(roomId);

      this.portal.socket.once("connect_error", fallbackInitializationHandler);
    } catch (error) {
      // Unlike socketIOClient (which never throws synchronously — it
      // reconnects), an injected collabSocketFactory can reject, so this
      // path is reachable: roll back the collaboration state entered above,
      // or local persistence would stay paused for the rest of the session.
      LocalData.resumeSave("collaboration");
      this.setIsCollaborating(false);
      console.error(error);
      this.setErrorDialog(
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }

    if (!existingRoomLinkData) {
      const elements = this.excalidrawAPI.getSceneElements().map((element) => {
        if (isImageElement(element) && element.status === "saved") {
          return newElementWith(element, { status: "pending" });
        }
        return element;
      });
      // remove deleted elements from elements array to ensure we don't
      // expose potentially sensitive user data in case user manually deletes
      // existing elements (or clears scene), which would otherwise be persisted
      // to database even if deleted before creating the room.
      this.excalidrawAPI.updateScene({
        elements,
        captureUpdate: CaptureUpdateAction.NEVER,
      });

      this.saveCollabRoomToFirebase(getSyncableElements(elements));
    }

    // fallback in case you're not alone in the room but still don't receive
    // initial SCENE_INIT message
    this.socketInitializationTimer = window.setTimeout(
      fallbackInitializationHandler,
      INITIAL_SCENE_UPDATE_TIMEOUT,
    );

    // All socket listeners are moving to Portal
    this.portal.socket.on(
      "client-broadcast",
      async (encryptedData: ArrayBuffer, iv: Uint8Array) => {
        if (!this.portal.roomKey) {
          return;
        }

        const decryptedData = await this.decryptPayload(
          iv,
          encryptedData,
          this.portal.roomKey,
        );

        switch (decryptedData.type) {
          case WS_SUBTYPES.INVALID_RESPONSE:
            return;
          case WS_SUBTYPES.INIT: {
            const remoteElements = decryptedData.payload.elements;
            if (!this.portal.socketInitialized) {
              this.initializeRoom({ fetchScene: false });
              const reconciledElements =
                this._reconcileElements(remoteElements);
              this.handleRemoteSceneUpdate(reconciledElements);
              // noop if already resolved via init from firebase
              scenePromise.resolve({
                elements: reconciledElements,
                scrollToContent: true,
              });

              // Initialized from a peer that had nothing to send — fold any
              // persisted scene in (fire and forget; see mergePersistedScene
              // for why this is needed and safe). Gated on an EMPTY INIT so
              // the common established-room join doesn't stampede the
              // storage backend with one GET per client: a peer with content
              // is at least as fresh as storage, since members persist
              // continuously.
              if (
                existingRoomLinkData &&
                this.sceneEnabled &&
                remoteElements.length === 0
              ) {
                this.mergePersistedScene(existingRoomLinkData);
              }
            } else if (this.excalidrawAPI.getSceneElements().length === 0) {
              // A SCENE_INIT that arrives AFTER the socket was already marked
              // initialized would otherwise be silently dropped. On a quick
              // rejoin the INITIAL_SCENE_UPDATE_TIMEOUT (5s) fallback can flip
              // socketInitialized to true with an empty scene before a peer's
              // re-broadcast lands, stranding the rejoiner on a blank board.
              // Applying the late INIT when the local board is empty recovers
              // it. Reconciliation is version-based and idempotent (the same
              // path UPDATE takes unguarded), and this branch only runs with no
              // local elements, so there is nothing to clobber.
              this.handleRemoteSceneUpdate(
                this._reconcileElements(remoteElements),
              );
            }
            break;
          }
          case WS_SUBTYPES.UPDATE:
            this.handleRemoteSceneUpdate(
              this._reconcileElements(decryptedData.payload.elements),
            );
            break;
          case WS_SUBTYPES.MOUSE_LOCATION: {
            const { pointer, button, username, selectedElementIds } =
              decryptedData.payload;

            const socketId: SocketUpdateDataSource["MOUSE_LOCATION"]["payload"]["socketId"] =
              decryptedData.payload.socketId ||
              // @ts-ignore legacy, see #2094 (#2097)
              decryptedData.payload.socketID;

            this.updateCollaborator(socketId, {
              pointer,
              button,
              selectedElementIds,
              username,
            });

            break;
          }

          case WS_SUBTYPES.USER_VISIBLE_SCENE_BOUNDS: {
            const { sceneBounds, socketId } = decryptedData.payload;

            const appState = this.excalidrawAPI.getAppState();

            // we're not following the user
            // (shouldn't happen, but could be late message or bug upstream)
            if (appState.userToFollow?.socketId !== socketId) {
              console.warn(
                `receiving remote client's (from ${socketId}) viewport bounds even though we're not subscribed to it!`,
              );
              return;
            }

            // cross-follow case, ignore updates in this case
            if (
              appState.userToFollow &&
              appState.followedBy.has(appState.userToFollow.socketId)
            ) {
              return;
            }

            this.excalidrawAPI.updateScene({
              appState: zoomToFitBounds({
                appState,
                bounds: sceneBounds,
                fitToViewport: true,
                viewportZoomFactor: 1,
              }).appState,
            });

            break;
          }

          case WS_SUBTYPES.IDLE_STATUS: {
            const { userState, socketId, username } = decryptedData.payload;
            this.updateCollaborator(socketId, {
              userState,
              username,
            });
            break;
          }

          default: {
            assertNever(decryptedData, null);
          }
        }
      },
    );

    this.portal.socket.on("first-in-room", async () => {
      if (this.portal.socket) {
        this.portal.socket.off("first-in-room");
      }
      const generation = this.sessionGeneration;
      const sceneData = await this.initializeRoom({
        fetchScene: true,
        roomLinkData: existingRoomLinkData,
      });

      // The room was left while its scene was being fetched — resolving now would seed the
      // session that replaced it with this one's contents.
      if (generation !== this.sessionGeneration) {
        return;
      }

      scenePromise.resolve(sceneData);
    });

    this.portal.socket.on(
      WS_EVENTS.USER_FOLLOW_ROOM_CHANGE,
      (followedBy: SocketId[]) => {
        this.excalidrawAPI.updateScene({
          appState: { followedBy: new Set(followedBy) },
        });

        this.relayVisibleSceneBounds({ force: true });
      },
    );

    this.initializeIdleDetector();

    if (this.staleCollaboratorTimerId) {
      window.clearInterval(this.staleCollaboratorTimerId);
    }
    this.staleCollaboratorTimerId = window.setInterval(
      this.pruneStaleCollaborators,
      STALE_CHECK_INTERVAL_MS,
    );

    this.setActiveRoomLink(window.location.href);

    return scenePromise;
  };

  private initializeRoom = async ({
    fetchScene,
    roomLinkData,
  }:
    | {
        fetchScene: true;
        roomLinkData: { roomId: string; roomKey: string } | null;
      }
    | { fetchScene: false; roomLinkData?: null }) => {
    clearTimeout(this.socketInitializationTimer!);
    if (this.portal.socket && this.fallbackInitializationHandler) {
      this.portal.socket.off(
        "connect_error",
        this.fallbackInitializationHandler,
      );
    }
    if (fetchScene && roomLinkData && this.portal.socket && this.sceneEnabled) {
      try {
        const elements = await loadFromStorage(
          roomLinkData.roomId,
          roomLinkData.roomKey,
          this.portal.socket,
        );
        if (elements) {
          // Reconciled against the live scene rather than replacing it, and NOT preceded by a
          // `resetScene()`.
          //
          // The reset used to run BEFORE this fetch, so every join blanked the board for two
          // round trips (the storage API answers with a presigned URL, then the object store
          // answers with the bytes). A caller that seeds the board before joining — the
          // document tab paints a page's known marks the instant you turn to it — had that
          // seed wiped mid-join and watched it pop back in a second later.
          //
          // Reconciling also keeps anything drawn DURING the join: a plain replace discarded
          // strokes made in that window, silently. Same shape as `mergePersistedScene`, which
          // is what the not-first-in-room path already does.
          return {
            elements: this._reconcileElements(elements),
            scrollToContent: true,
          };
        }
      } catch (error) {
        // log the error and move on. other peers will sync us the scene.
        console.error(error);
      } finally {
        this.portal.markSocketInitialized();
      }
    } else {
      this.portal.markSocketInitialized();
    }
    return null;
  };

  /**
   * Merge the HTTP-persisted scene into the local one via reconciliation
   * (no scene reset — element id+version wins, so this is safe and
   * idempotent at any time after initialization).
   *
   * Needed when initialization happened via a peer's SCENE_INIT rather than
   * `first-in-room`: when several clients join within the same announce
   * window (the norm — every participant mounts on the same metadata
   * broadcast), none of them is "first", so none takes the
   * `initializeRoom({ fetchScene: true })` path and a previously persisted
   * scene would never load. Every client merging independently is cheap
   * (one GET; empty store is a no-op) and converges regardless of timing.
   */
  private mergePersistedScene = async (roomLinkData: {
    roomId: string;
    roomKey: string;
  }) => {
    const generation = this.sessionGeneration;

    try {
      const elements = await loadFromStorage(
        roomLinkData.roomId,
        roomLinkData.roomKey,
        this.portal.socket,
      );

      if (elements?.length && generation === this.sessionGeneration) {
        this.handleRemoteSceneUpdate(this._reconcileElements(elements));
      }
    } catch (error) {
      // Non-fatal: peers and the periodic full sync keep us converged.
      console.error(error);
    }
  };

  private _reconcileElements = (
    remoteElements: readonly ExcalidrawElement[],
  ): ReconciledExcalidrawElement[] => {
    const localElements = this.getSceneElementsIncludingDeleted();
    const appState = this.excalidrawAPI.getAppState();
    const restoredRemoteElements = restoreElements(remoteElements, null);
    const reconciledElements = reconcileElements(
      localElements,
      restoredRemoteElements as RemoteExcalidrawElement[],
      appState,
    );

    // Avoid broadcasting to the rest of the collaborators the scene
    // we just received!
    // Note: this needs to be set before updating the scene as it
    // synchronously calls render.
    this.setLastBroadcastedOrReceivedSceneVersion(
      getSceneVersion(reconciledElements),
    );

    return reconciledElements;
  };

  private loadImageFiles = throttle(async () => {
    const response = await this.fetchImageFilesFromFirebase({
      elements: this.excalidrawAPI.getSceneElementsIncludingDeleted(),
    });
    if (!response) {
      return;
    }
    const { loadedFiles, erroredFiles } = response;

    this.excalidrawAPI.addFiles(loadedFiles);

    updateStaleImageStatuses({
      excalidrawAPI: this.excalidrawAPI,
      erroredFiles,
      elements: this.excalidrawAPI.getSceneElementsIncludingDeleted(),
    });
  }, LOAD_IMAGES_TIMEOUT);

  /**
   * Whether the user is mid-interaction — drawing, resizing or dragging.
   *
   * The gap this closes is `selectedElementsAreBeingDragged`. Reconciliation protects an
   * element the user is actively editing by ID — `shouldDiscardRemoteElement` forces the local
   * copy to win for `newElement`, `resizingElement` and `editingTextElement` whatever the
   * versions say — but a plain drag of ALREADY-EXISTING elements has no such guard. It falls
   * through to the version/nonce comparison, so a stored snapshot that happens to out-version
   * the local copy replaces elements out from under the cursor mid-drag.
   *
   * The other three are covered here as defence in depth. They are cheap to include, and the
   * id-guard that protects them lives in another module with no test tying the two together.
   */
  private isInteracting = () => {
    const {
      cursorButton,
      newElement,
      resizingElement,
      selectedElementsAreBeingDragged,
    } = this.excalidrawAPI.getAppState();

    return (
      cursorButton === "down" ||
      !!newElement ||
      !!resizingElement ||
      selectedElementsAreBeingDragged
    );
  };

  /**
   * Merges what storage holds into the live scene, waiting for the interaction to end.
   *
   * The RAW stored elements are held rather than the reconciled result, and the reconcile is
   * re-run at flush time: `_reconcileElements` reads the local scene when it is called, so
   * re-running it merges against whatever has been drawn since by version. Applying a stale
   * reconciled snapshot instead would drop those strokes — trading one bug for a worse one.
   */
  private applyStoredScene = (stored: readonly ExcalidrawElement[]) => {
    if (this.isInteracting()) {
      this.pendingStoredScene = stored;

      return;
    }

    this.pendingStoredScene = null;
    this.handleRemoteSceneUpdate(this._reconcileElements(stored));
  };

  private handleRemoteSceneUpdate = (
    elements: ReconciledExcalidrawElement[],
  ) => {
    this.excalidrawAPI.updateScene({
      elements,
      captureUpdate: CaptureUpdateAction.NEVER,
    });

    this.loadImageFiles();
  };

  private onPointerMove = () => {
    if (this.idleTimeoutId) {
      window.clearTimeout(this.idleTimeoutId);
      this.idleTimeoutId = null;
    }

    this.idleTimeoutId = window.setTimeout(this.reportIdle, IDLE_THRESHOLD);

    if (!this.activeIntervalId) {
      this.activeIntervalId = window.setInterval(
        this.reportActive,
        ACTIVE_THRESHOLD,
      );
    }
  };

  private onVisibilityChange = () => {
    if (document.hidden) {
      if (this.idleTimeoutId) {
        window.clearTimeout(this.idleTimeoutId);
        this.idleTimeoutId = null;
      }
      if (this.activeIntervalId) {
        window.clearInterval(this.activeIntervalId);
        this.activeIntervalId = null;
      }
      this.onIdleStateChange(UserIdleState.AWAY);
    } else {
      this.idleTimeoutId = window.setTimeout(this.reportIdle, IDLE_THRESHOLD);
      this.activeIntervalId = window.setInterval(
        this.reportActive,
        ACTIVE_THRESHOLD,
      );
      this.onIdleStateChange(UserIdleState.ACTIVE);
    }
  };

  private reportIdle = () => {
    this.onIdleStateChange(UserIdleState.IDLE);
    if (this.activeIntervalId) {
      window.clearInterval(this.activeIntervalId);
      this.activeIntervalId = null;
    }
  };

  private reportActive = () => {
    this.onIdleStateChange(UserIdleState.ACTIVE);
  };

  private initializeIdleDetector = () => {
    document.addEventListener(EVENT.POINTER_MOVE, this.onPointerMove);
    document.addEventListener(EVENT.VISIBILITY_CHANGE, this.onVisibilityChange);
  };

  setCollaborators(sockets: SocketId[]) {
    const collaborators: InstanceType<typeof Collab>["collaborators"] =
      new Map();
    const now = Date.now();
    const socketSet = new Set(sockets);
    for (const socketId of sockets) {
      collaborators.set(
        socketId,
        Object.assign({}, this.collaborators.get(socketId), {
          isCurrentUser: socketId === this.portal.socket?.id,
        }),
      );
      this.collaboratorLastSeen.set(socketId, now);
    }
    for (const socketId of this.collaboratorLastSeen.keys()) {
      if (!socketSet.has(socketId)) {
        this.collaboratorLastSeen.delete(socketId);
      }
    }
    this.collaborators = collaborators;
    this.excalidrawAPI.updateScene({ collaborators });
  }

  updateCollaborator = (socketId: SocketId, updates: Partial<Collaborator>) => {
    const collaborators = new Map(this.collaborators);
    const user: Mutable<Collaborator> = Object.assign(
      {},
      collaborators.get(socketId),
      updates,
      {
        isCurrentUser: socketId === this.portal.socket?.id,
      },
    );
    collaborators.set(socketId, user);
    this.collaboratorLastSeen.set(socketId, Date.now());
    this.collaborators = collaborators;

    this.excalidrawAPI.updateScene({
      collaborators,
    });
  };

  private pruneStaleCollaborators = () => {
    if (!this.isCollaborating()) {
      return;
    }
    const now = Date.now();
    let pruned = false;
    const collaborators = new Map(this.collaborators);
    for (const [socketId, collaborator] of collaborators) {
      if (collaborator.isCurrentUser) {
        continue;
      }
      const lastSeen = this.collaboratorLastSeen.get(socketId);
      if (
        lastSeen !== undefined &&
        now - lastSeen > STALE_COLLABORATOR_TIMEOUT_MS
      ) {
        collaborators.delete(socketId);
        this.collaboratorLastSeen.delete(socketId);
        pruned = true;
      }
    }
    if (pruned) {
      this.collaborators = collaborators;
      this.excalidrawAPI.updateScene({ collaborators });
    }
  };

  public setLastBroadcastedOrReceivedSceneVersion = (version: number) => {
    this.lastBroadcastedOrReceivedSceneVersion = version;
  };

  public getLastBroadcastedOrReceivedSceneVersion = () => {
    return this.lastBroadcastedOrReceivedSceneVersion;
  };

  public getSceneElementsIncludingDeleted = () => {
    return this.excalidrawAPI.getSceneElementsIncludingDeleted();
  };

  onPointerUpdate = throttle(
    (payload: {
      pointer: SocketUpdateDataSource["MOUSE_LOCATION"]["payload"]["pointer"];
      button: SocketUpdateDataSource["MOUSE_LOCATION"]["payload"]["button"];
      pointersMap: Gesture["pointers"];
    }) => {
      payload.pointersMap.size < 2 &&
        this.portal.socket &&
        this.portal.broadcastMouseLocation(payload);
    },
    CURSOR_SYNC_TIMEOUT,
  );

  relayVisibleSceneBounds = (props?: { force: boolean }) => {
    const appState = this.excalidrawAPI.getAppState();

    if (this.portal.socket && (appState.followedBy.size > 0 || props?.force)) {
      this.portal.broadcastVisibleSceneBounds(
        {
          sceneBounds: getVisibleSceneBounds(appState),
        },
        `follow@${this.portal.socket.id}`,
      );
    }
  };

  onIdleStateChange = (userState: UserIdleState) => {
    this.portal.broadcastIdleChange(userState);
  };

  broadcastElements = (elements: readonly OrderedExcalidrawElement[]) => {
    if (
      getSceneVersion(elements) >
      this.getLastBroadcastedOrReceivedSceneVersion()
    ) {
      this.portal.broadcastScene(WS_SUBTYPES.UPDATE, elements, false);
      this.lastBroadcastedOrReceivedSceneVersion = getSceneVersion(elements);
      this.queueBroadcastAllElements();
    }
  };

  syncElements = (elements: readonly OrderedExcalidrawElement[]) => {
    this.broadcastElements(elements);

    // The flush point for a reconcile deferred past a stroke. `syncElements` runs on every
    // scene change, and lifting the pen finalises the element — so the first change after the
    // interaction ends lands here.
    if (this.pendingStoredScene) {
      this.applyStoredScene(this.pendingStoredScene);
    }

    this.queueSaveToFirebase();
  };

  queueBroadcastAllElements = throttle(() => {
    this.portal.broadcastScene(
      WS_SUBTYPES.UPDATE,
      this.excalidrawAPI.getSceneElementsIncludingDeleted(),
      true,
    );
    const currentVersion = this.getLastBroadcastedOrReceivedSceneVersion();
    const newVersion = Math.max(
      currentVersion,
      getSceneVersion(this.getSceneElementsIncludingDeleted()),
    );
    this.setLastBroadcastedOrReceivedSceneVersion(newVersion);
  }, SYNC_FULL_SCENE_INTERVAL_MS);

  queueSaveToFirebase = throttle(
    () => {
      if (this.portal.socketInitialized) {
        this.saveCollabRoomToFirebase(
          getSyncableElements(
            this.excalidrawAPI.getSceneElementsIncludingDeleted(),
          ),
        );
      }
    },
    SYNC_FULL_SCENE_INTERVAL_MS,
    { leading: false },
  );

  setUsername = (username: string) => {
    this.setState({ username });
    saveUsernameToLocalStorage(username);
  };

  getUsername = () => this.state.username;

  setActiveRoomLink = (activeRoomLink: string | null) => {
    this.setState({ activeRoomLink });
    appJotaiStore.set(activeRoomLinkAtom, activeRoomLink);
  };

  getActiveRoomLink = () => this.state.activeRoomLink;

  setErrorIndicator = (errorMessage: string | null) => {
    appJotaiStore.set(collabErrorIndicatorAtom, {
      message: errorMessage,
      nonce: Date.now(),
    });
  };

  resetErrorIndicator = (resetDialogNotifiedErrors = false) => {
    appJotaiStore.set(collabErrorIndicatorAtom, { message: null, nonce: 0 });
    if (resetDialogNotifiedErrors) {
      this.setState({
        dialogNotifiedErrors: {},
      });
    }
  };

  setErrorDialog = (errorMessage: string | null) => {
    this.setState({
      errorMessage,
    });
  };

  render() {
    const { errorMessage } = this.state;

    return (
      <>
        {errorMessage != null && (
          <ErrorDialog onClose={() => this.setErrorDialog(null)}>
            {errorMessage}
          </ErrorDialog>
        )}
      </>
    );
  }
}

declare global {
  interface Window {
    // @ts-ignoreQ
    collab: InstanceType<typeof Collab>;
  }
}

if (isTestEnv() || isDevEnv()) {
  window.collab = window.collab || ({} as Window["collab"]);
}

export default Collab;

export type TCollabClass = Collab;
