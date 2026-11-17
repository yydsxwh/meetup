import { NextResponse } from "next/server";
import { z } from "zod";
import {
  assertUploadTargets,
  createMediaAsset,
  findUploadSession,
} from "@andyyyds/courses/lib/studio-media";
import { mediaErrorResponse } from "@andyyyds/courses/lib/studio-media-response";
import {
  ASSET_DESC_MAX,
  ASSET_NAME_MAX,
  MAX_UPLOAD_BYTES,
  classifyMediaKind,
  inferMimeType,
  isAllowedUpload,
  isMediaKind,
} from "@andyyyds/shared/media";
import { completeOssBrowserMultipart } from "@andyyyds/shared/storage";
import { requireCourseStudioUser } from "@andyyyds/shared/studio";
import {
  completeVodBrowserMultipart,
  vodUrlFromVideoId,
} from "@andyyyds/shared/aliyun-vod";

export const runtime = "nodejs";

const partSchema = z.object({
  partNumber: z.coerce.number().int().min(1).max(10000),
  etag: z.string().trim().min(1).max(200),
});

const completeSchema = z.object({
  name: z.string().trim().min(1).max(ASSET_NAME_MAX),
  description: z.string().trim().max(ASSET_DESC_MAX).optional(),
  categoryId: z.string().optional(),
  durationSec: z.coerce.number().int().min(0).optional(),
  uploadSessionId: z.string().trim().min(8).max(80).optional(),
  purposeIds: z.array(z.string()).optional(),
  schoolIds: z.array(z.string()).optional(),
  termIds: z.array(z.string()).optional(),
  tagIds: z.array(z.string()).optional(),
  fileName: z.string().trim().min(1).max(240),
  mimeType: z.string().trim().max(120).optional(),
  sizeBytes: z.coerce.number().int().min(0).max(MAX_UPLOAD_BYTES),
  mediaKind: z.string().optional(),
  provider: z.enum(["ALIYUN_VOD", "ALIYUN_OSS"]),
  vodVideoId: z.string().trim().min(1).max(128).optional(),
  fileUrl: z.string().trim().min(1).max(2000).optional(),
  vod: z
    .object({
      host: z.string().trim().min(1).max(300),
      bucket: z.string().trim().min(1).max(120),
      objectKey: z.string().trim().min(1).max(1000),
      accessKeyId: z.string().trim().min(1).max(200),
      accessKeySecret: z.string().trim().min(1).max(200),
      securityToken: z.string().trim().min(1).max(4000),
      uploadId: z.string().trim().max(200).optional(),
      parts: z.array(partSchema).max(10000).optional(),
    })
    .optional(),
  oss: z
    .object({
      objectKey: z.string().trim().min(1).max(1000),
      uploadId: z.string().trim().min(1).max(200),
      parts: z.array(partSchema).min(1).max(10000),
    })
    .optional(),
});

/** 直传云端完成后登记 MediaAsset；点播文件已在 CreateUploadVideo 时创建 */
export async function POST(req: Request) {
  try {
    const session = await requireCourseStudioUser();
    const body = completeSchema.parse(await req.json());
    const mimeType = inferMimeType(body.mimeType || "", body.fileName);
    if (!isAllowedUpload(mimeType, body.fileName)) {
      return NextResponse.json({ error: "不支持的文件类型" }, { status: 400 });
    }

    const existing = await findUploadSession(session.id, body.uploadSessionId);
    if (existing) return NextResponse.json({ asset: existing });

    const categoryId = body.categoryId?.trim() || null;
    await assertUploadTargets(session.id, {
      categoryId,
      purposeIds: body.purposeIds,
      schoolIds: body.schoolIds,
      termIds: body.termIds,
      tagIds: body.tagIds,
    });

    let mediaKind = body.mediaKind && isMediaKind(body.mediaKind)
      ? body.mediaKind
      : classifyMediaKind(mimeType, body.fileName);

    let fileUrl = "";
    let storageProvider = body.provider;
    let vodVideoId = "";

    if (body.provider === "ALIYUN_VOD") {
      if (!body.vodVideoId) {
        return NextResponse.json({ error: "缺少点播 VideoId" }, { status: 400 });
      }
      // 多分片时由服务端 CompleteMultipart；单次 PUT 预签名则 uploadId 为空
      if (body.vod?.uploadId) {
        if (!body.vod.parts?.length) {
          return NextResponse.json(
            { error: "缺少点播分片 ETag" },
            { status: 400 },
          );
        }
        await completeVodBrowserMultipart({
          host: body.vod.host,
          bucket: body.vod.bucket,
          objectKey: body.vod.objectKey,
          accessKeyId: body.vod.accessKeyId,
          accessKeySecret: body.vod.accessKeySecret,
          securityToken: body.vod.securityToken,
          uploadId: body.vod.uploadId,
          parts: body.vod.parts,
        });
      }
      vodVideoId = body.vodVideoId;
      fileUrl = body.fileUrl || vodUrlFromVideoId(vodVideoId);
      mediaKind = "VIDEO";
    } else {
      if (!body.oss) {
        return NextResponse.json({ error: "缺少 OSS 分片信息" }, { status: 400 });
      }
      await completeOssBrowserMultipart(body.oss);
      if (!body.fileUrl) {
        return NextResponse.json({ error: "缺少文件地址" }, { status: 400 });
      }
      fileUrl = body.fileUrl;
    }

    const asset = await createMediaAsset({
      ownerId: session.id,
      name: body.name,
      description: body.description || "",
      type: mediaKind,
      fileUrl,
      fileName: body.fileName,
      mimeType,
      sizeBytes: body.sizeBytes,
      durationSec: body.durationSec || 0,
      storageProvider,
      vodVideoId,
      categoryId,
      uploadSessionId: body.uploadSessionId || null,
      purposeIds: body.purposeIds,
      schoolIds: body.schoolIds,
      termIds: body.termIds,
      tagIds: body.tagIds,
    });

    return NextResponse.json({ asset });
  } catch (error) {
    return mediaErrorResponse(error);
  }
}
