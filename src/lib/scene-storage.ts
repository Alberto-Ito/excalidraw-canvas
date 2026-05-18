import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";

export type StoredRoomScene = {
  roomId: string;
  elements: readonly OrderedExcalidrawElement[];
  files: BinaryFiles;
  appState: Pick<AppState, "scrollX" | "scrollY" | "viewBackgroundColor"> &
    Partial<Pick<AppState, "zoom">>;
  savedAt: string;
};

const ROOM_SCENES_DIR = path.join(process.cwd(), ".data", "room-scenes");

function normalizeRoomId(roomId: string) {
  const normalized = roomId.trim().toLowerCase();

  if (!normalized) {
    throw new Error("roomId is required");
  }

  const safeRoomId = normalized.replace(/[^a-z0-9_-]/g, "-");

  if (!safeRoomId) {
    throw new Error("roomId is invalid");
  }

  return safeRoomId;
}

async function getRoomScenePath(roomId: string) {
  await mkdir(ROOM_SCENES_DIR, { recursive: true });

  return path.join(ROOM_SCENES_DIR, `${normalizeRoomId(roomId)}.json`);
}

export async function saveRoomScene(scene: StoredRoomScene) {
  const filePath = await getRoomScenePath(scene.roomId);

  await writeFile(filePath, JSON.stringify(scene, null, 2), "utf8");
}

export async function loadRoomScene(roomId: string) {
  const filePath = await getRoomScenePath(roomId);
  const sceneJson = await readFile(filePath, "utf8");

  return JSON.parse(sceneJson) as StoredRoomScene;
}
