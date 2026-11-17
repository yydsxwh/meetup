import { NextResponse } from "next/server";
import { z } from "zod";
import { createCategory, listCategories } from "@andyyyds/courses/lib/studio-media";
import { mediaErrorResponse } from "@andyyyds/courses/lib/studio-media-response";
import { MEDIA_CATEGORY_NAME_MAX } from "@andyyyds/shared/media";
import { requireCourseStudioUser } from "@andyyyds/shared/studio";

const createSchema = z.object({
  name: z.string().trim().min(1).max(MEDIA_CATEGORY_NAME_MAX),
  parentId: z.string().nullable().optional(),
});

export async function GET() {
  try {
    const session = await requireCourseStudioUser();
    const result = await listCategories(session.id);
    return NextResponse.json({
      ...result,
      categories: result.categories.map((category) => ({
        ...category,
        _count: { assets: category.directCount },
      })),
    });
  } catch (error) {
    return mediaErrorResponse(error);
  }
}

export async function POST(req: Request) {
  try {
    const session = await requireCourseStudioUser();
    const body = createSchema.parse(await req.json());
    const created = await createCategory(session.id, {
      name: body.name,
      parentId: body.parentId || null,
    });
    const listed = await listCategories(session.id);
    const category = listed.categories.find((item) => item.id === created.id);
    return NextResponse.json({
      category: category
        ? { ...category, _count: { assets: category.directCount } }
        : created,
    });
  } catch (error) {
    return mediaErrorResponse(error);
  }
}
