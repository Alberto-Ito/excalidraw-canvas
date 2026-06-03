import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";

export const DEFAULT_ROOM_ID = "demo-room";

export type SceneSnapshot = {
  elements: readonly OrderedExcalidrawElement[];
  appState: Pick<
    AppState,
    "scrollX" | "scrollY" | "viewBackgroundColor" | "zoom"
  >;
  files: BinaryFiles;
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function getCollabRoomServerUrl() {
  const roomServerUrl = process.env.NEXT_PUBLIC_EXCALIDRAW_ROOM_URL;

  if (!roomServerUrl) {
    throw new Error(
      "Missing NEXT_PUBLIC_EXCALIDRAW_ROOM_URL. Configure the collaboration room server URL in your environment.",
    );
  }

  return roomServerUrl;
}

export function getRoomId(searchParams: URLSearchParams) {
  return searchParams.get("room")?.trim() || DEFAULT_ROOM_ID;
}

export function serializeSceneSnapshot(scene: SceneSnapshot) {
  return textEncoder.encode(JSON.stringify(scene)).buffer;
}

export function deserializeSceneSnapshot(data: ArrayBuffer) {
  return JSON.parse(textDecoder.decode(new Uint8Array(data))) as SceneSnapshot;
}

export function getSceneSignature(scene: SceneSnapshot) {
  return JSON.stringify({
    elements: scene.elements.map((element) => ({
      id: element.id,
      version: element.version,
      versionNonce: element.versionNonce,
      isDeleted: element.isDeleted,
    })),
    appState: scene.appState,
    fileIds: Object.keys(scene.files).sort(),
  });
}
