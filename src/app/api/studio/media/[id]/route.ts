import { NextResponse } from "next/server";
import { z } from "zod";
import { deleteMediaAssets, updateMediaAsset } from "@andyyyds/courses/lib/studio-media";
import { mediaErrorResponse } from "@andyyyds/courses/lib/studio-media-response";
import { ASSET_DESC_MAX, ASSET_NAME_MAX } from "@andyyyds/shared/media";
import { canDeleteMedia } from "@andyyyds/shared/roles";
import { deleteStoredFile } from "@andyyyds/shared/storage";
import { requireCourseStudioUser } from "@andyyyds/shared/studio";

const patchSchema = z.object({
  name: z.string().trim().min(1).max(ASSET_NAME_MAX).optional(),
  description: z.string().trim().max(ASSET_DESC_MAX).optional(),
  categoryId: z.string().nullable().optional(),
  durationSec: z.number().int().min(0).optional(),
  purposeIds: z.array(z.string()).optional(),
  schoolIds: z.array(z.string()).optional(),
  termIds: z.array(z.string()).optional(),
  tagIds: z.array(z.string()).optional(),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireCourseStudioUser();
    const { id } = await params;
    const body = patchSchema.parse(await req.json());
    const asset = await updateMediaAsset(session.id, id, {
      ...body,
      categoryId: body.categoryId === undefined ? undefined : body.categoryId || null,
    });
    return NextResponse.json({ asset });
  } catch (error) {
    return mediaErrorResponse(error);
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireCourseStudioUser();
    if (!canDeleteMedia(session.role)) {
      return NextResponse.json(
        { error: "老师账号不可删除素材，请联系站长处理" },
        { status: 403 },
      );
    }
    const { id } = await params;
    const result = await deleteMediaAssets(session.id, [id]);
    if (result.blocked.length > 0 && result.deletedIds.length === 0) {
      return NextResponse.json(
        { error: result.blocked[0]?.reason || "素材已被课程使用，不能删除", blocked: result.blocked },
        { status: 409 },
      );
    }
    for (const asset of result.deletedFiles) {
      await deleteStoredFile(asset.fileUrl, session.id, {
        vodVideoId: asset.vodVideoId,
        storageProvider: asset.storageProvider,
      });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return mediaErrorResponse(error);
  }
}
