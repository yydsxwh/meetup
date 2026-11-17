import { NextResponse } from "next/server";
import { z } from "zod";
import { deleteCategory, listCategories, updateCategory } from "@andyyyds/courses/lib/studio-media";
import { mediaErrorResponse } from "@andyyyds/courses/lib/studio-media-response";
import { MEDIA_CATEGORY_NAME_MAX } from "@andyyyds/shared/media";
import { canDeleteMedia } from "@andyyyds/shared/roles";
import { requireCourseStudioUser } from "@andyyyds/shared/studio";

const patchSchema = z.object({
  name: z.string().trim().min(1).max(MEDIA_CATEGORY_NAME_MAX).optional(),
  parentId: z.string().nullable().optional(),
  direction: z.enum(["up", "down"]).optional(),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireCourseStudioUser();
    const { id } = await params;
    const body = patchSchema.parse(await req.json());
    await updateCategory(session.id, id, body);
    const listed = await listCategories(session.id);
    const category = listed.categories.find((item) => item.id === id);
    return NextResponse.json({
      category: category ? { ...category, _count: { assets: category.directCount } } : null,
      categories: listed.categories,
    });
  } catch (error) {
    return mediaErrorResponse(error);
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireCourseStudioUser();
    if (!canDeleteMedia(session.role)) {
      return NextResponse.json(
        { error: "老师账号不可删除分类，请联系站长处理" },
        { status: 403 },
      );
    }
    const { id } = await params;
    const destination = new URL(req.url).searchParams.get("destination");
    const result = await deleteCategory(
      session.id,
      id,
      destination === null ? undefined : destination === "uncategorized" ? null : destination,
    );
    return NextResponse.json(result);
  } catch (error) {
    return mediaErrorResponse(error);
  }
}
