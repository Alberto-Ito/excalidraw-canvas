"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState, type ComponentProps } from "react";
import { io, type Socket } from "socket.io-client";
import type {
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";
import {
  DEFAULT_ROOM_ID,
  deserializeSceneSnapshot,
  getCollabRoomServerUrl,
  getRoomId,
  getSceneSignature,
  serializeSceneSnapshot,
  type SceneSnapshot,
} from "@/lib/collab";

type FlutterBridgeMessage = {
  type: "scene-change";
  roomId: string;
  payload: SceneSnapshot;
  updatedAt: string;
};

type FlutterRestoreMessage = {
  type: "restore-scene";
  roomId: string;
  payload: SceneSnapshot;
  restoredAt?: string;
};

type FlutterBridgeInboundMessage = FlutterRestoreMessage;

type FlutterJavascriptChannel = {
  postMessage: (message: string) => void;
};

type WindowWithFlutterBridge = Window &
  typeof globalThis & {
    FlutterChannel?: FlutterJavascriptChannel;
    __EXCALIDRAW_RESTORE_SCENE__?: (message: FlutterRestoreMessage) => void;
    webkit?: {
      messageHandlers?: Record<string, { postMessage: (message: string) => void }>;
    };
  };

const BasicExcalidraw = dynamic(
  async () => {
    const mod = await import("@excalidraw/excalidraw");
    const Excalidraw = mod.Excalidraw;
    const MainMenu = mod.MainMenu;

    return function BasicExcalidrawCanvas({
      excalidrawAPI,
      initialData,
      isCollaborating,
      onChange,
    }: {
      excalidrawAPI: (api: ExcalidrawImperativeAPI) => void;
      initialData: ExcalidrawInitialDataState | Promise<ExcalidrawInitialDataState>;
      isCollaborating: boolean;
      onChange: NonNullable<ComponentProps<typeof Excalidraw>["onChange"]>;
    }) {
      return (
        <Excalidraw
          UIOptions={{
            canvasActions: {
              changeViewBackgroundColor: false,
              clearCanvas: false,
              export: false,
              loadScene: false,
              saveAsImage: false,
              saveToActiveFile: false,
              toggleTheme: false,
            },
            tools: {
              image: true,
            },
            welcomeScreen: false,
          }}
          excalidrawAPI={excalidrawAPI}
          gridModeEnabled={false}
          initialData={initialData}
          isCollaborating={isCollaborating}
          onChange={onChange}
          theme="light"
          viewModeEnabled={false}
          zenModeEnabled={false}
        >
          <MainMenu />
        </Excalidraw>
      );
    };
  },
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full w-full items-center justify-center bg-slate-100 text-sm text-slate-500">
        Loading canvas...
      </div>
    ),
  },
);

const COLLAB_BROADCAST_DELAY_MS = 150;
const FLUTTER_PUBLISH_DELAY_MS = 400;
const REMOTE_SCENE_IV = new Uint8Array(12);
const DEBUG_MODE = process.env.NEXT_PUBLIC_DEBUG_MODE === "true";
const DEFAULT_FLUTTER_BRIDGE_NAME = "FlutterChannel";

async function createInitialScene(): Promise<ExcalidrawInitialDataState> {
  return {
    elements: [],
    appState: {
      viewBackgroundColor: "#f8fafc",
    },
    files: {},
  };
}

function buildSceneSnapshot(api: ExcalidrawImperativeAPI): SceneSnapshot {
  return {
    elements: api.getSceneElementsIncludingDeleted(),
    appState: {
      scrollX: api.getAppState().scrollX,
      scrollY: api.getAppState().scrollY,
      viewBackgroundColor: api.getAppState().viewBackgroundColor,
      zoom: api.getAppState().zoom,
    },
    files: api.getFiles(),
  };
}

function publishSceneToFlutter(message: FlutterBridgeMessage) {
  if (typeof window === "undefined") {
    return;
  }

  const targetWindow = window as WindowWithFlutterBridge;
  const bridgeName =
    process.env.NEXT_PUBLIC_FLUTTER_BRIDGE_NAME || DEFAULT_FLUTTER_BRIDGE_NAME;
  const serializedMessage = JSON.stringify(message);
  const javascriptChannel = targetWindow[
    bridgeName as keyof WindowWithFlutterBridge
  ] as FlutterJavascriptChannel | undefined;
  const webkitHandler = targetWindow.webkit?.messageHandlers?.[bridgeName];

  if (javascriptChannel?.postMessage) {
    javascriptChannel.postMessage(serializedMessage);
    return;
  }

  if (webkitHandler?.postMessage) {
    webkitHandler.postMessage(serializedMessage);
  }
}

function isSceneSnapshot(value: unknown): value is SceneSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<SceneSnapshot>;

  return (
    Array.isArray(candidate.elements) &&
    !!candidate.appState &&
    typeof candidate.appState === "object" &&
    !!candidate.files &&
    typeof candidate.files === "object"
  );
}

function parseFlutterInboundMessage(value: unknown): FlutterBridgeInboundMessage | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<FlutterBridgeInboundMessage>;

  if (
    candidate.type !== "restore-scene" ||
    typeof candidate.roomId !== "string" ||
    !isSceneSnapshot(candidate.payload)
  ) {
    return null;
  }

  return {
    type: "restore-scene",
    roomId: candidate.roomId,
    payload: candidate.payload,
    restoredAt:
      typeof candidate.restoredAt === "string" ? candidate.restoredAt : undefined,
  };
}

export default function Canvas() {
  const [initialData] = useState(() => createInitialScene());
  const [roomId] = useState(() => {
    if (typeof window === "undefined") {
      return DEFAULT_ROOM_ID;
    }

    return getRoomId(new URLSearchParams(window.location.search));
  });
  const [collabStatus, setCollabStatus] = useState(
    `Connecting to room "${roomId}"...`,
  );
  const collabBroadcastTimeoutRef = useRef<number | null>(null);
  const flutterPublishTimeoutRef = useRef<number | null>(null);
  const excalidrawAPIRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const applyingRemoteSceneRef = useRef(false);
  const lastRemoteSceneSignatureRef = useRef<string | null>(null);
  const lastPublishedFlutterSignatureRef = useRef<string | null>(null);
  const latestSceneSnapshotRef = useRef<SceneSnapshot | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const applySceneSnapshot = (sceneSnapshot: SceneSnapshot) => {
      const api = excalidrawAPIRef.current;

      if (!api) {
        return;
      }

      latestSceneSnapshotRef.current = sceneSnapshot;
      lastRemoteSceneSignatureRef.current = getSceneSignature(sceneSnapshot);
      lastPublishedFlutterSignatureRef.current = getSceneSignature(sceneSnapshot);
      applyingRemoteSceneRef.current = true;

      api.resetScene();

      if (Object.keys(sceneSnapshot.files).length > 0) {
        api.addFiles(Object.values(sceneSnapshot.files));
      }

      api.updateScene({
        elements: sceneSnapshot.elements,
        appState: sceneSnapshot.appState,
        captureUpdate: "NEVER",
      });

      window.setTimeout(() => {
        applyingRemoteSceneRef.current = false;
      }, 0);
    };

    const handleRestoreMessage = (message: FlutterRestoreMessage) => {
      if (message.roomId !== roomId) {
        return;
      }

      applySceneSnapshot(message.payload);
    };

    const handleWindowMessage = (event: MessageEvent<unknown>) => {
      const parsedMessage = parseFlutterInboundMessage(event.data);

      if (!parsedMessage) {
        return;
      }

      handleRestoreMessage(parsedMessage);
    };

    const targetWindow = window as WindowWithFlutterBridge;

    targetWindow.__EXCALIDRAW_RESTORE_SCENE__ = handleRestoreMessage;
    window.addEventListener("message", handleWindowMessage);

    return () => {
      delete targetWindow.__EXCALIDRAW_RESTORE_SCENE__;
      window.removeEventListener("message", handleWindowMessage);
    };
  }, [roomId]);

  useEffect(() => {
    return () => {
      if (collabBroadcastTimeoutRef.current !== null) {
        window.clearTimeout(collabBroadcastTimeoutRef.current);
      }
      if (flutterPublishTimeoutRef.current !== null) {
        window.clearTimeout(flutterPublishTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    console.info("[collab]", {
      roomId,
      status: collabStatus,
    });
  }, [collabStatus, roomId]);

  useEffect(() => {
    const socket = io(getCollabRoomServerUrl(), {
      transports: ["websocket", "polling"],
    });

    socketRef.current = socket;

    socket.on("connect", () => {
      setCollabStatus(`Connected to room "${roomId}"`);
    });

    socket.on("connect_error", (error) => {
      console.error("[collab] connect_error", error);
      setCollabStatus("Collaboration server unavailable");
    });

    socket.on("init-room", () => {
      socket.emit("join-room", roomId);
    });

    socket.on("first-in-room", () => {
      setCollabStatus(`Connected. Waiting for peers in "${roomId}"`);
    });

    socket.on("room-user-change", (socketIds: string[]) => {
      const peerCount = Math.max(socketIds.length - 1, 0);
      setCollabStatus(
        `Room "${roomId}" connected${peerCount > 0 ? ` | ${peerCount} peer${peerCount === 1 ? "" : "s"}` : ""}`,
      );
    });

    socket.on("new-user", () => {
      const api = excalidrawAPIRef.current;

      if (!api) {
        return;
      }

      const sceneSnapshot = buildSceneSnapshot(api);

      latestSceneSnapshotRef.current = sceneSnapshot;
      socket.emit(
        "server-broadcast",
        roomId,
        serializeSceneSnapshot(sceneSnapshot),
        REMOTE_SCENE_IV,
      );
    });

    socket.on("client-broadcast", (encryptedData: ArrayBuffer) => {
      if (DEBUG_MODE) {
        console.debug("[collab] received client-broadcast");
      }
      const api = excalidrawAPIRef.current;

      if (!api) {
        return;
      }

      const nextScene = deserializeSceneSnapshot(encryptedData);
      latestSceneSnapshotRef.current = nextScene;
      lastRemoteSceneSignatureRef.current = getSceneSignature(nextScene);

      applyingRemoteSceneRef.current = true;

      if (Object.keys(nextScene.files).length > 0) {
        api.addFiles(Object.values(nextScene.files));
      }

      api.updateScene({
        elements: nextScene.elements,
        appState: nextScene.appState,
        captureUpdate: "NEVER",
      });

      window.setTimeout(() => {
        applyingRemoteSceneRef.current = false;
      }, 0);
    });

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [roomId]);

  return (
    <section className="relative h-full w-full">
      <BasicExcalidraw
        excalidrawAPI={(api) => {
          excalidrawAPIRef.current = api;
        }}
        initialData={initialData}
        isCollaborating
        onChange={(elements, appState, files) => {
          const sceneSnapshot: SceneSnapshot = {
            elements,
            appState: {
              scrollX: appState.scrollX,
              scrollY: appState.scrollY,
              viewBackgroundColor: appState.viewBackgroundColor,
              zoom: appState.zoom,
            },
            files,
          };

          latestSceneSnapshotRef.current = sceneSnapshot;

          if (applyingRemoteSceneRef.current) {
            return;
          }

          const sceneSignature = getSceneSignature(sceneSnapshot);

          if (lastRemoteSceneSignatureRef.current === sceneSignature) {
            lastRemoteSceneSignatureRef.current = null;
            return;
          }

          if (collabBroadcastTimeoutRef.current !== null) {
            window.clearTimeout(collabBroadcastTimeoutRef.current);
          }
          if (flutterPublishTimeoutRef.current !== null) {
            window.clearTimeout(flutterPublishTimeoutRef.current);
          }

          collabBroadcastTimeoutRef.current = window.setTimeout(() => {
            const socket = socketRef.current;
            const latestSceneSnapshot = latestSceneSnapshotRef.current;

            if (!socket || !socket.connected || !latestSceneSnapshot) {
              return;
            }

            if (DEBUG_MODE) {
              console.debug("[collab] emit server-broadcast", {
                connected: socket.connected,
                roomId,
                elements: latestSceneSnapshot.elements.length,
              });
            }

            socket.emit(
              "server-broadcast",
              roomId,
              serializeSceneSnapshot(latestSceneSnapshot),
              REMOTE_SCENE_IV,
            );
          }, COLLAB_BROADCAST_DELAY_MS);

          flutterPublishTimeoutRef.current = window.setTimeout(() => {
            const latestSceneSnapshot = latestSceneSnapshotRef.current;

            if (!latestSceneSnapshot) {
              return;
            }

            const flutterSceneSignature = getSceneSignature(latestSceneSnapshot);

            if (
              lastPublishedFlutterSignatureRef.current === flutterSceneSignature
            ) {
              return;
            }

            publishSceneToFlutter({
              type: "scene-change",
              roomId,
              payload: latestSceneSnapshot,
              updatedAt: new Date().toISOString(),
            });
            lastPublishedFlutterSignatureRef.current = flutterSceneSignature;
          }, FLUTTER_PUBLISH_DELAY_MS);
        }}
      />
    </section>
  );
}
