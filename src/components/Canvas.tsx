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
              image: false,
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
const REMOTE_SCENE_IV = new Uint8Array(12);

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
  const excalidrawAPIRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const applyingRemoteSceneRef = useRef(false);
  const lastRemoteSceneSignatureRef = useRef<string | null>(null);
  const latestSceneSnapshotRef = useRef<SceneSnapshot | null>(null);

  useEffect(() => {
    return () => {
      if (collabBroadcastTimeoutRef.current !== null) {
        window.clearTimeout(collabBroadcastTimeoutRef.current);
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

    socket.on("connect_error", () => {
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

          if (appState.cursorButton === "down") {
            collabBroadcastTimeoutRef.current = window.setTimeout(() => {
              if (latestSceneSnapshotRef.current) {
                socketRef.current?.emit(
                  "server-broadcast",
                  roomId,
                  serializeSceneSnapshot(latestSceneSnapshotRef.current),
                  REMOTE_SCENE_IV,
                );
              }
            }, COLLAB_BROADCAST_DELAY_MS);
            return;
          }
        }}
      />
    </section>
  );
}
