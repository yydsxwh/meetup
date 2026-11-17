import { NextResponse } from "next/server";
import { z } from "zod";
import {
  assertUploadTargets,
  createMediaAsset,
  deleteMediaAssetsForManager,
  findUploadSession,
} from "@andyyyds/courses/lib/studio-media";
import { mediaErrorResponse } from "@andyyyds/courses/lib/studio-media-response";
import {
  ASSET_DESC_MAX,
  ASSET_NAME_MAX,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_LABEL,
  MAX_PROXY_UPLOAD_BYTES,
  classifyMediaKind,
  inferMimeType,
  isAllowedUpload,
} from "@andyyyds/shared/media";
import { parseIdListInput, parseMediaListParams, storageCategorySegment } from "@andyyyds/shared/media-library";
import { listMedia } from "@andyyyds/courses/lib/studio-media";
import { canDeleteMedia, isAdmin } from "@andyyyds/shared/roles";
import { formatVodError } from "@andyyyds/shared/aliyun-vod";
import { deleteStoredFile, storeUpload } from "@andyyyds/shared/storage";
import { requireCourseStudioUser } from "@andyyyds/shared/studio";

export const runtime = "nodejs";

const metaSchema = z.object({
  name: z.string().trim().min(1).max(ASSET_NAME_MAX),
  description: z.string().trim().max(ASSET_DESC_MAX).optional(),
  categoryId: z.string().optional(),
  durationSec: z.coerce.number().int().min(0).optional(),
  uploadSessionId: z.string().trim().min(8).max(80).optional(),
});

export async function GET(req: Request) {
  try {
    const session = await requireCourseStudioUser();
    const url = new URL(req.url);
    const allOwners = url.searchParams.get("scope") === "all";
    if (allOwners && !isAdmin(session)) {
      return NextResponse.json({ error: "只有站长可以查看全站素材" }, { status: 403 });
    }
    const query = parseMediaListParams(url.searchParams);
    const page = await listMedia(session.id, query, { allOwners });
    return NextResponse.json(page);
  } catch (error) {
    return mediaErrorResponse(error);
  }
}

export async function POST(req: Request) {
  try {
    const session = await requireCourseStudioUser();
    const form = await req.formData();
    const file = form.get("file");
    const externalUrl = String(form.get("externalUrl") || "").trim();
    const parsed = metaSchema.parse({
      name: form.get("name"),
      description: form.get("description") || "",
      categoryId: form.get("categoryId") || undefined,
      durationSec: form.get("durationSec") || 0,
      uploadSessionId: form.get("uploadSessionId") || undefined,
    });
    const categoryId = parsed.categoryId?.trim() || null;
    const attributes = {
      purposeIds: parseIdListInput(form.get("purposeIds")),
      schoolIds: parseIdListInput(form.get("schoolIds")),
      termIds: parseIdListInput(form.get("termIds")),
      tagIds: parseIdListInput(form.get("tagIds")),
    };
    const existing = await findUploadSession(session.id, parsed.uploadSessionId);
    if (existing) return NextResponse.json({ asset: existing });
    await assertUploadTargets(session.id, { categoryId, ...attributes });

    let fileUrl = "";
    let fileName = "";
    let mimeType = "";
    let sizeBytes = 0;
    let storageProvider = "LOCAL";
    let vodVideoId = "";
    let mediaKind = classifyMediaKind("", "");

    if (file instanceof File && file.size > 0) {
      if (file.size > MAX_UPLOAD_BYTES) {
        return NextResponse.json(
          { error: `文件不能超过 ${MAX_UPLOAD_LABEL}` },
          { status: 400 },
        );
      }
      if (file.size > MAX_PROXY_UPLOAD_BYTES) {
        return NextResponse.json(
          {
            error: `超过 ${Math.round(MAX_PROXY_UPLOAD_BYTES / 1024 / 1024)}MB 请使用直传通道（前端会自动切换）`,
          },
          { status: 400 },
        );
      }
      fileName = file.name || "upload.bin";
      mimeType = inferMimeType(file.type || "", fileName);
      if (!isAllowedUpload(mimeType, fileName)) {
        return NextResponse.json(
          {
            error:
              "不支持的文件类型。支持：视频(mp4/webm/mov/avi)、图片(jpg/png/webp/gif)、音频(mp3/wav/aac/m4a)、文档(pdf/doc/xls/ppt/txt)",
          },
          { status: 400 },
        );
      }
      mediaKind = classifyMediaKind(mimeType, fileName);
      const storageSubPath = `${mediaKind.toLowerCase()}/${storageCategorySegment(categoryId)}`;
      const buffer = Buffer.from(await file.arrayBuffer());
      try {
        const stored = await storeUpload({
          ownerId: session.id,
          fileName,
          buffer,
          mimeType,
          title: parsed.name,
          kind: mediaKind === "VIDEO" ? "video" : "file",
          subPath: mediaKind === "VIDEO" ? undefined : storageSubPath,
        });
        fileUrl = stored.fileUrl;
        sizeBytes = file.size;
        storageProvider = stored.provider;
        vodVideoId = stored.vodVideoId || "";
      } catch (uploadError) {
        const raw = uploadError instanceof Error ? uploadError.message : "上传失败";
        const message =
          /signature is not matched|server string to sign|vod\.|aliyuncs/i.test(raw)
            ? formatVodError(uploadError)
            : raw.length > 160
              ? `${raw.slice(0, 140)}…`
              : raw;
        return NextResponse.json({ error: message }, { status: 400 });
      }
    } else if (externalUrl) {
      try {
        const url = new URL(externalUrl);
        if (!["http:", "https:"].includes(url.protocol)) {
          return NextResponse.json({ error: "外链地址无效" }, { status: 400 });
        }
        fileName = decodeURIComponent(url.pathname.split("/").pop() || "external");
        mimeType = inferMimeType("", fileName);
        mediaKind = classifyMediaKind(mimeType, fileName);
        if (mediaKind === "OTHER") {
          mediaKind = "VIDEO";
          mimeType = mimeType === "application/octet-stream" ? "video/mp4" : mimeType;
        }
      } catch {
        return NextResponse.json({ error: "外链地址无效" }, { status: 400 });
      }
      fileUrl = externalUrl;
      storageProvider = "EXTERNAL";
    } else {
      return NextResponse.json({ error: "请上传文件或填写外链" }, { status: 400 });
    }

    const asset = await createMediaAsset({
      ownerId: session.id,
      name: parsed.name,
      description: parsed.description || "",
      type: mediaKind,
      fileUrl,
      fileName,
      mimeType,
      sizeBytes,
      durationSec: parsed.durationSec || 0,
      storageProvider,
      vodVideoId,
      categoryId,
      uploadSessionId: parsed.uploadSessionId || null,
      ...attributes,
    });
    return NextResponse.json({ asset });
  } catch (error) {
    return mediaErrorResponse(error);
  }
}

const bulkDeleteSchema = z.object({
  ids: z.array(z.string().min(1)).min(1, "请选择要删除的素材").max(100),
});

/** 批量删除素材。被课时引用的只拦截，不删文件。 */
export async function DELETE(req: Request) {
  try {
    const session = await requireCourseStudioUser();
    if (!canDeleteMedia(session.role)) {
      return NextResponse.json(
        { error: "老师账号不可删除素材，请联系站长处理" },
        { status: 403 },
      );
    }
    const body = bulkDeleteSchema.parse(await req.json());
    const result = await deleteMediaAssetsForManager(session, body.ids);
    for (const asset of result.deletedFiles) {
      await deleteStoredFile(asset.fileUrl, asset.ownerId, {
        vodVideoId: asset.vodVideoId,
        storageProvider: asset.storageProvider,
      });
    }
    if (result.deletedIds.length === 0 && result.blocked.length > 0) {
      return NextResponse.json(
        {
          error: result.blocked[0]?.reason || "素材已被课程使用，不能删除",
          blocked: result.blocked,
          deletedIds: [],
        },
        { status: 409 },
      );
    }
    return NextResponse.json({
      ok: true,
      deletedIds: result.deletedIds,
      deletedCount: result.deletedIds.length,
      blocked: result.blocked,
    });
  } catch (error) {
    return mediaErrorResponse(error);
  }
}
