import { NextResponse } from "next/server";
import { studioErrorResponse } from "@andyyyds/shared/studio";
import { MediaLibraryError } from "./studio-media";

export function mediaErrorResponse(error: unknown) {
  if (error instanceof MediaLibraryError) {
    return NextResponse.json(
      {
        error: error.message,
        ...(error.code ? { code: error.code } : {}),
        ...(error.details || {}),
      },
      { status: error.status },
    );
  }
  const mapped = studioErrorResponse(error);
  return NextResponse.json({ error: mapped.error }, { status: mapped.status });
}
