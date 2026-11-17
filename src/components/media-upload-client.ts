import {
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_LABEL,
} from "@andyyyds/shared/media";
import {
  uploadFileToOssDirect,
  uploadFileWithSignedParts,
} from "@andyyyds/shared/browser-oss-multipart";
import type { MediaAssetDto } from "@andyyyds/shared/media-library";

export type UploadSnapshot = {
  file: File;
  name: string;
  description: string;
  categoryId: string | null;
  uploadSessionId: string;
  purposeIds: string[];
  schoolIds: string[];
  termIds: string[];
  tagIds: string[];
  onProgress: (loaded: number, total: number) => void;
};

type PrepareResponse = {
  mode: "vod_multipart" | "vod_direct" | "oss_multipart" | "proxy";
  mediaKind?: string;
  mimeType?: string;
  error?: string;
  code?: string;
  vod?: {
    videoId: string;
    fileUrl: string;
    host: string;
    bucket: string;
    objectKey: string;
    accessKeyId: string;
    accessKeySecret: string;
    securityToken: string;
    uploadId?: string;
    partSize?: number;
    parts?: Array<{ partNumber: number; url: string }>;
  };
  oss?: {
    uploadId: string;
    objectKey: string;
    fileUrl: string;
    partSize: number;
    parts: Array<{ partNumber: number; url: string }>;
  };
};

export type UploadResult = {
  ok: boolean;
  code?: string;
  error?: string;
  asset?: MediaAssetDto;
};

function shortUploadError(raw: string | undefined, fallback = "上传失败") {
  const text = (raw || "").trim();
  if (!text) return fallback;
  if (/signature is not matched/i.test(text) || /server string to sign/i.test(text)) {
    return "点播密钥校验失败，请在系统设置重新填写 AccessKey";
  }
  if (text.length > 100) return `${text.slice(0, 90)}…`;
  return text;
}

function uploadWithProgress(
  form: FormData,
  onProgress: (loaded: number, total: number) => void,
): Promise<{ ok: boolean; status: number; data: { asset?: MediaAssetDto; error?: string; code?: string } }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/studio/media");
    xhr.responseType = "json";
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      onProgress(event.loaded, event.total);
    };
    xhr.onload = () => {
      const data =
        xhr.response && typeof xhr.response === "object"
          ? xhr.response
          : (() => {
              try {
                return JSON.parse(xhr.responseText || "{}");
              } catch {
                return { error: "上传响应无效" };
              }
            })();
      resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, data });
    };
    xhr.onerror = () => {
      resolve({ ok: false, status: 0, data: { error: "网络错误，上传中断" } });
    };
    xhr.send(form);
  });
}

function attributeFields(input: UploadSnapshot) {
  return {
    categoryId: input.categoryId || undefined,
    uploadSessionId: input.uploadSessionId,
    purposeIds: input.purposeIds,
    schoolIds: input.schoolIds,
    termIds: input.termIds,
    tagIds: input.tagIds,
  };
}

/** 每个文件使用调用时传入的快照，之后改批次不会改到已经开始的这一次。 */
export async function uploadMediaFile(input: UploadSnapshot): Promise<UploadResult> {
  if (input.file.size > MAX_UPLOAD_BYTES) {
    return { ok: false, error: `文件不能超过 ${MAX_UPLOAD_LABEL}` };
  }
  const prepareRes = await fetch("/api/studio/media/prepare", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: input.name,
      fileName: input.file.name,
      mimeType: input.file.type || "",
      sizeBytes: input.file.size,
      categoryId: input.categoryId || undefined,
      description: input.description || undefined,
    }),
  });
  const prepare = (await prepareRes.json().catch(() => ({}))) as PrepareResponse;
  if (!prepareRes.ok) {
    return {
      ok: false,
      code: prepare.code,
      error: shortUploadError(prepare.error, "无法获取直传凭证"),
    };
  }

  if (prepare.mode === "proxy") {
    const form = new FormData();
    form.set("name", input.name);
    form.set("description", input.description);
    form.set("uploadSessionId", input.uploadSessionId);
    if (input.categoryId) form.set("categoryId", input.categoryId);
    form.set("purposeIds", JSON.stringify(input.purposeIds));
    form.set("schoolIds", JSON.stringify(input.schoolIds));
    form.set("termIds", JSON.stringify(input.termIds));
    form.set("tagIds", JSON.stringify(input.tagIds));
    form.set("file", input.file);
    const result = await uploadWithProgress(form, input.onProgress);
    return {
      ok: result.ok,
      code: result.data.code,
      error: result.ok ? undefined : shortUploadError(result.data.error),
      asset: result.data.asset,
    };
  }

  try {
    if ((prepare.mode === "vod_multipart" || prepare.mode === "vod_direct") && prepare.vod) {
      const vod = prepare.vod;
      let uploadedParts: Array<{ partNumber: number; etag: string }> = [];
      if (vod.parts?.length && vod.partSize) {
        uploadedParts = await uploadFileWithSignedParts({
          file: input.file,
          partSize: vod.partSize,
          parts: vod.parts,
          onProgress: input.onProgress,
          requireEtag: Boolean(vod.uploadId),
        });
      } else {
        await uploadFileToOssDirect({
          file: input.file,
          contentType: prepare.mimeType || input.file.type || "video/mp4",
          creds: {
            host: vod.host,
            bucket: vod.bucket,
            objectKey: vod.objectKey,
            accessKeyId: vod.accessKeyId,
            accessKeySecret: vod.accessKeySecret,
            securityToken: vod.securityToken,
          },
          onProgress: input.onProgress,
        });
      }
      const completeRes = await fetch("/api/studio/media/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: input.name,
          description: input.description,
          fileName: input.file.name,
          mimeType: prepare.mimeType || input.file.type || "",
          sizeBytes: input.file.size,
          mediaKind: prepare.mediaKind || "VIDEO",
          provider: "ALIYUN_VOD",
          vodVideoId: vod.videoId,
          fileUrl: vod.fileUrl,
          ...attributeFields(input),
          vod: {
            host: vod.host,
            bucket: vod.bucket,
            objectKey: vod.objectKey,
            accessKeyId: vod.accessKeyId,
            accessKeySecret: vod.accessKeySecret,
            securityToken: vod.securityToken,
            uploadId: vod.uploadId || undefined,
            parts: vod.uploadId ? uploadedParts : undefined,
          },
        }),
      });
      const completeData = await completeRes.json().catch(() => ({}));
      if (!completeRes.ok || !completeData.asset) {
        return {
          ok: false,
          code: completeData.code,
          error: shortUploadError(completeData.error, "点播直传后入库失败"),
        };
      }
      return { ok: true, asset: completeData.asset as MediaAssetDto };
    }

    if (prepare.mode === "oss_multipart" && prepare.oss) {
      const parts = await uploadFileWithSignedParts({
        file: input.file,
        partSize: prepare.oss.partSize,
        parts: prepare.oss.parts,
        onProgress: input.onProgress,
      });
      const completeRes = await fetch("/api/studio/media/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: input.name,
          description: input.description,
          fileName: input.file.name,
          mimeType: prepare.mimeType || input.file.type || "",
          sizeBytes: input.file.size,
          mediaKind: prepare.mediaKind,
          provider: "ALIYUN_OSS",
          fileUrl: prepare.oss.fileUrl,
          ...attributeFields(input),
          oss: {
            objectKey: prepare.oss.objectKey,
            uploadId: prepare.oss.uploadId,
            parts,
          },
        }),
      });
      const completeData = await completeRes.json().catch(() => ({}));
      if (!completeRes.ok || !completeData.asset) {
        return {
          ok: false,
          code: completeData.code,
          error: shortUploadError(completeData.error, "OSS 直传后入库失败"),
        };
      }
      return { ok: true, asset: completeData.asset as MediaAssetDto };
    }
    return { ok: false, error: "未知的上传模式" };
  } catch (error) {
    const message = error instanceof Error ? error.message : "直传失败";
    return { ok: false, error: shortUploadError(message) };
  }
}

export async function saveExternalMedia(input: {
  name: string;
  description: string;
  categoryId: string | null;
  externalUrl: string;
  uploadSessionId: string;
  purposeIds: string[];
  schoolIds: string[];
  termIds: string[];
  tagIds: string[];
}): Promise<UploadResult> {
  const form = new FormData();
  form.set("name", input.name);
  form.set("description", input.description);
  form.set("externalUrl", input.externalUrl);
  form.set("uploadSessionId", input.uploadSessionId);
  if (input.categoryId) form.set("categoryId", input.categoryId);
  form.set("purposeIds", JSON.stringify(input.purposeIds));
  form.set("schoolIds", JSON.stringify(input.schoolIds));
  form.set("termIds", JSON.stringify(input.termIds));
  form.set("tagIds", JSON.stringify(input.tagIds));
  const result = await uploadWithProgress(form, () => undefined);
  return {
    ok: result.ok,
    code: result.data.code,
    error: result.ok ? undefined : shortUploadError(result.data.error),
    asset: result.data.asset,
  };
}
