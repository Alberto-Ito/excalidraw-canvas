import { NextResponse } from "next/server";
import {
  loadRoomScene,
  saveRoomScene,
  type StoredRoomScene,
} from "@/lib/scene-storage";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const roomId = searchParams.get("roomId")?.trim();

  if (!roomId) {
    return NextResponse.json(
      { error: "roomId is required" },
      { status: 400 },
    );
  }

  try {
    const scene = await loadRoomScene(roomId);

    return NextResponse.json(scene);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return NextResponse.json(
        { error: `No saved scene found for room "${roomId}"` },
        { status: 404 },
      );
    }

    return NextResponse.json(
      { error: "Failed to load room scene" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  let body: StoredRoomScene;

  try {
    body = (await request.json()) as StoredRoomScene;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.roomId?.trim()) {
    return NextResponse.json(
      { error: "roomId is required" },
      { status: 400 },
    );
  }

  await saveRoomScene({
    ...body,
    roomId: body.roomId.trim(),
    savedAt: new Date().toISOString(),
  });

  return NextResponse.json({ ok: true });
}
