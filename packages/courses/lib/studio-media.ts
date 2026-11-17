/**
 * 素材库的读写都从这里走。调用方必须传入会话里的 ownerId，不能改用请求体里的所有者。
 * 分类、标签和批量整理只改元数据，不移动存储对象，也不改课时上的 fileUrl / mediaAssetId。
 */
import { Prisma } from "@prisma/client";
import { prisma } from "@andyyyds/shared/db";
import { isAdmin, type RoleInput } from "@andyyyds/shared/roles";
import {
  DEFAULT_MEDIA_PURPOSES,
  MEDIA_NAME_SORT_CAP,
  MEDIA_ORGANIZE_MAX,
  UNCATEGORIZED_LABEL,
  applyIdField,
  categoryDepth,
  categoryPath,
  descendantIds,
  detectMediaFormat,
  isVocabularyKind,
  nextAttributeSnapshot,
  organizeChangesSomething,
  parentKeyOf,
  previewTemplateAdditions,
  snapshotEquals,
  sortAssetsByName,
  sortCategorySiblings,
  splitDeletableAssets,
  undoSnapshot,
  validateCategoryPlacement,
  type CategoryFieldChange,
  type CategoryNode,
  type IdFieldChange,
  type MediaAssetDto,
  type MediaAttributeSnapshot,
  type MediaCategoryDto,
  type MediaFormat,
  type MediaListQuery,
  type MediaOrganizeDiff,
  type MediaVocabularyDto,
  type OrganizeRequest,
  type VocabularyKind,
} from "@andyyyds/shared/media-library";

export class MediaLibraryError extends Error {
  status: number;
  code?: string;
  details?: Record<string, unknown>;

  constructor(
    status: number,
    message: string,
    code?: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "MediaLibraryError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const assetInclude = {
  vocabularyLinks: { include: { vocabulary: true } },
} satisfies Prisma.MediaAssetInclude;

type AssetRow = Prisma.MediaAssetGetPayload<{ include: typeof assetInclude }>;

function fail(status: number, message: string, code?: string, details?: Record<string, unknown>): never {
  throw new MediaLibraryError(status, message, code, details);
}

async function ownerNodes(ownerId: string, allOwners = false): Promise<CategoryNode[]> {
  const rows = await prisma.mediaCategory.findMany({
    where: allOwners ? {} : { ownerId },
    select: {
      id: true,
      name: true,
      parentId: true,
      sortOrder: true,
      ownerId: true,
    },
  });
  return rows;
}

function toAssetDto(asset: AssetRow, nodes: CategoryNode[]): MediaAssetDto {
  const category = asset.categoryId
    ? nodes.find((node) => node.id === asset.categoryId) || null
    : null;
  const ofKind = (kind: VocabularyKind) =>
    asset.vocabularyLinks
      .filter((link) => link.vocabulary.kind === kind)
      .map((link) => link.vocabulary)
      .sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name, "zh"));
  return {
    id: asset.id,
    name: asset.name,
    description: asset.description,
    type: asset.type,
    fileUrl: asset.fileUrl,
    fileName: asset.fileName,
    mimeType: asset.mimeType,
    format: detectMediaFormat(asset.mimeType, asset.fileName),
    sizeBytes: asset.sizeBytes,
    durationSec: asset.durationSec,
    categoryId: asset.categoryId,
    category: category
      ? { id: category.id, name: category.name, path: categoryPath(category.id, nodes) }
      : null,
    createdAt: asset.createdAt.toISOString(),
    purposes: ofKind("PURPOSE").map((item) => ({ id: item.id, name: item.name })),
    schools: ofKind("SCHOOL").map((item) => ({
      id: item.id,
      name: item.name,
      isGeneral: item.isGeneral,
    })),
    terms: ofKind("TERM").map((item) => ({ id: item.id, name: item.name })),
    tags: ofKind("TAG").map((item) => ({ id: item.id, name: item.name })),
  };
}

function snapshotOf(asset: AssetRow): MediaAttributeSnapshot {
  const ids = (kind: VocabularyKind) =>
    asset.vocabularyLinks
      .filter((link) => link.vocabulary.kind === kind)
      .map((link) => link.vocabularyId)
      .sort();
  return {
    categoryId: asset.categoryId,
    purposeIds: ids("PURPOSE"),
    schoolIds: ids("SCHOOL"),
    termIds: ids("TERM"),
    tagIds: ids("TAG"),
  };
}

async function ensureDefaultPurposes(ownerId: string) {
  const existing = await prisma.mediaVocabulary.findMany({
    where: { ownerId, kind: "PURPOSE" },
    select: { name: true },
  });
  const have = new Set(existing.map((item) => item.name));
  const missing = DEFAULT_MEDIA_PURPOSES.filter((name) => !have.has(name));
  if (missing.length === 0) return;
  await prisma.mediaVocabulary.createMany({
    data: missing.map((name, index) => ({
      ownerId,
      kind: "PURPOSE",
      name,
      sortOrder: index,
      isGeneral: false,
    })),
  });
}

export async function listCategories(ownerId: string): Promise<{
  categories: MediaCategoryDto[];
  summary: { all: number; uncategorized: number };
}> {
  await ensureDefaultPurposes(ownerId);
  const [nodes, grouped, all, uncategorized] = await Promise.all([
    ownerNodes(ownerId),
    prisma.mediaAsset.groupBy({
      by: ["categoryId"],
      where: { ownerId },
      _count: { _all: true },
    }),
    prisma.mediaAsset.count({ where: { ownerId } }),
    prisma.mediaAsset.count({ where: { ownerId, categoryId: null } }),
  ]);
  const direct = new Map<string, number>();
  for (const row of grouped) {
    if (row.categoryId) direct.set(row.categoryId, row._count._all);
  }
  const categories = sortCategorySiblings(nodes).map((node) => {
    const descendants = descendantIds(node.id, nodes);
    const treeCount = descendants.reduce(
      (sum, id) => sum + (direct.get(id) || 0),
      direct.get(node.id) || 0,
    );
    return {
      id: node.id,
      name: node.name,
      parentId: node.parentId,
      sortOrder: node.sortOrder,
      depth: categoryDepth(node.id, nodes),
      path: categoryPath(node.id, nodes),
      directCount: direct.get(node.id) || 0,
      treeCount,
    };
  });
  return { categories, summary: { all, uncategorized } };
}

async function requireOwnedCategory(ownerId: string, categoryId: string) {
  const category = await prisma.mediaCategory.findFirst({
    where: { id: categoryId, ownerId },
  });
  if (!category) fail(404, "分类不存在");
  return category;
}

export async function createCategory(
  ownerId: string,
  input: { name: string; parentId?: string | null },
) {
  const nodes = await ownerNodes(ownerId);
  const parentId = input.parentId || null;
  const check = validateCategoryPlacement({
    nodes,
    ownerId,
    name: input.name,
    parentId,
  });
  if (!check.ok) fail(400, check.error);
  const siblings = nodes.filter((node) => (node.parentId || null) === parentId);
  try {
    const created = await prisma.mediaCategory.create({
      data: {
        name: input.name.trim(),
        ownerId,
        parentId,
        parentKey: parentKeyOf(parentId),
        sortOrder: (siblings.length + 1) * 10,
      },
    });
    return created;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      fail(400, "同一层级已有同名分类");
    }
    throw error;
  }
}

export async function updateCategory(
  ownerId: string,
  categoryId: string,
  input: { name?: string; parentId?: string | null; direction?: "up" | "down" },
) {
  const current = await requireOwnedCategory(ownerId, categoryId);
  if (input.direction) {
    return reorderCategory(ownerId, categoryId, input.direction === "up" ? -1 : 1);
  }
  const nodes = await ownerNodes(ownerId);
  const parentId = input.parentId === undefined ? current.parentId : input.parentId;
  const name = input.name === undefined ? current.name : input.name;
  const check = validateCategoryPlacement({
    nodes,
    ownerId,
    categoryId,
    name,
    parentId,
  });
  if (!check.ok) fail(400, check.error);
  try {
    return await prisma.mediaCategory.update({
      where: { id: categoryId },
      data: {
        name: name.trim(),
        parentId,
        parentKey: parentKeyOf(parentId),
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      fail(400, "同一层级已有同名分类");
    }
    throw error;
  }
}

async function reorderCategory(ownerId: string, categoryId: string, direction: -1 | 1) {
  const nodes = await ownerNodes(ownerId);
  const current = nodes.find((node) => node.id === categoryId);
  if (!current) fail(404, "分类不存在");
  const siblings = sortCategorySiblings(
    nodes.filter((node) => (node.parentId || null) === (current.parentId || null)),
  );
  const index = siblings.findIndex((node) => node.id === categoryId);
  const target = index + direction;
  if (target < 0 || target >= siblings.length) return current;
  const next = siblings.slice();
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item);
  await prisma.$transaction(
    next.map((node, order) =>
      prisma.mediaCategory.update({
        where: { id: node.id },
        data: { sortOrder: (order + 1) * 10 },
      }),
    ),
  );
  return prisma.mediaCategory.findFirstOrThrow({ where: { id: categoryId, ownerId } });
}

export async function deleteCategory(
  ownerId: string,
  categoryId: string,
  destination: string | null | undefined,
) {
  const nodes = await ownerNodes(ownerId);
  const current = nodes.find((node) => node.id === categoryId);
  if (!current) fail(404, "分类不存在");
  const children = nodes.filter((node) => node.parentId === categoryId);
  if (children.length > 0) {
    fail(400, "请先移走子分类", "CATEGORY_HAS_CHILDREN", { childCount: children.length });
  }
  const assetCount = await prisma.mediaAsset.count({
    where: { ownerId, categoryId },
  });
  if (assetCount > 0 && destination === undefined) {
    fail(409, "分类里还有素材，请选择保留去向", "CATEGORY_NONEMPTY", { assetCount });
  }
  let destinationId: string | null = null;
  if (assetCount > 0 && destination) {
    if (destination === categoryId) fail(400, "不能把素材留在即将删除的分类");
    await requireOwnedCategory(ownerId, destination);
    destinationId = destination;
  }
  await prisma.$transaction([
    prisma.mediaAsset.updateMany({
      where: { ownerId, categoryId },
      data: { categoryId: destinationId },
    }),
    prisma.mediaCategory.delete({ where: { id: categoryId } }),
  ]);
  await prisma.siteAuditLog.create({
    data: {
      actorId: ownerId,
      action: "media.category.delete",
      entityType: "MediaCategory",
      entityId: categoryId,
      detail: JSON.stringify({
        name: current.name,
        assetCount,
        destinationId,
      }),
    },
  });
  return { ok: true, assetCount, destinationId };
}

export async function directoryTemplate(ownerId: string, confirm: boolean) {
  const nodes = await ownerNodes(ownerId);
  const plan = previewTemplateAdditions(nodes);
  if (!confirm) return { plan, created: [] as string[] };
  const created: string[] = [];
  await prisma.$transaction(async (tx) => {
    const rootIdByName = new Map<string, string>();
    for (const node of nodes) {
      if (!node.parentId) rootIdByName.set(node.name, node.id);
    }
    for (const item of plan) {
      if (item.action === "keep") continue;
      const parentId = item.parentName ? rootIdByName.get(item.parentName) || null : null;
      if (item.parentName && !parentId) fail(400, "父分类尚未创建");
      const row = await tx.mediaCategory.create({
        data: {
          name: item.name,
          ownerId,
          parentId,
          parentKey: parentKeyOf(parentId),
          sortOrder: 100,
        },
      });
      if (!parentId) rootIdByName.set(item.name, row.id);
      created.push(row.id);
    }
  });
  return { plan, created };
}

export async function listVocabulary(ownerId: string, kind?: VocabularyKind) {
  await ensureDefaultPurposes(ownerId);
  const rows = await prisma.mediaVocabulary.findMany({
    where: { ownerId, ...(kind ? { kind } : {}) },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
  return rows.map(toVocabularyDto);
}

function toVocabularyDto(row: {
  id: string;
  kind: string;
  name: string;
  isGeneral: boolean;
  sortOrder: number;
}): MediaVocabularyDto {
  return {
    id: row.id,
    kind: isVocabularyKind(row.kind) ? row.kind : "TAG",
    name: row.name,
    isGeneral: row.isGeneral,
    sortOrder: row.sortOrder,
  };
}

export async function createVocabulary(
  ownerId: string,
  input: { kind: VocabularyKind; name: string; isGeneral?: boolean },
) {
  const name = input.name.trim();
  if (!name) fail(400, "请填写名称");
  const isGeneral = input.kind === "SCHOOL" && (input.isGeneral === true || name === "通用");
  try {
    const row = await prisma.mediaVocabulary.create({
      data: {
        ownerId,
        kind: input.kind,
        name,
        isGeneral,
      },
    });
    return toVocabularyDto(row);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const existing = await prisma.mediaVocabulary.findFirst({
        where: { ownerId, kind: input.kind, name },
      });
      if (existing) return toVocabularyDto(existing);
      fail(400, "同名选项已存在");
    }
    throw error;
  }
}

export async function deleteVocabulary(ownerId: string, id: string) {
  const row = await prisma.mediaVocabulary.findFirst({ where: { id, ownerId } });
  if (!row) fail(404, "选项不存在");
  const used = await prisma.mediaAssetVocabulary.count({ where: { vocabularyId: id } });
  if (used > 0) fail(400, "仍有素材使用该选项", "VOCABULARY_IN_USE", { used });
  await prisma.mediaVocabulary.delete({ where: { id } });
  return { ok: true };
}

async function ownedVocabularyIds(ownerId: string, kind: VocabularyKind, ids: string[]) {
  if (ids.length === 0) return [];
  const rows = await prisma.mediaVocabulary.findMany({
    where: { ownerId, kind, id: { in: ids } },
    select: { id: true },
  });
  if (rows.length !== new Set(ids).size) fail(400, "有选项不存在或无权使用");
  return rows.map((row) => row.id);
}

async function existingVocabularyIds(kind: VocabularyKind, ids: string[]) {
  if (ids.length === 0) return [];
  const rows = await prisma.mediaVocabulary.findMany({
    where: { kind, id: { in: ids } },
    select: { id: true },
  });
  if (rows.length !== new Set(ids).size) fail(400, "有选项不存在或无权使用");
  return rows.map((row) => row.id);
}

export async function assertUploadTargets(
  ownerId: string,
  input: {
    categoryId?: string | null;
    purposeIds?: string[];
    schoolIds?: string[];
    termIds?: string[];
    tagIds?: string[];
  },
) {
  if (input.categoryId) {
    const category = await prisma.mediaCategory.findFirst({
      where: { id: input.categoryId, ownerId },
      select: { id: true },
    });
    if (!category) {
      fail(409, "分类已删除，请改选分类后重试", "CATEGORY_GONE");
    }
  }
  await ownedVocabularyIds(ownerId, "PURPOSE", input.purposeIds || []);
  await ownedVocabularyIds(ownerId, "SCHOOL", input.schoolIds || []);
  await ownedVocabularyIds(ownerId, "TERM", input.termIds || []);
  await ownedVocabularyIds(ownerId, "TAG", input.tagIds || []);
}

export async function findUploadSession(ownerId: string, uploadSessionId: string | null | undefined) {
  if (!uploadSessionId) return null;
  const existing = await prisma.mediaAsset.findFirst({
    where: { uploadSessionId },
    include: assetInclude,
  });
  if (!existing) return null;
  if (existing.ownerId !== ownerId) fail(409, "上传会话无效");
  const nodes = await ownerNodes(ownerId);
  return toAssetDto(existing, nodes);
}

export async function createMediaAsset(input: {
  ownerId: string;
  name: string;
  description?: string;
  type: string;
  fileUrl: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  durationSec?: number;
  storageProvider: string;
  vodVideoId?: string;
  categoryId?: string | null;
  uploadSessionId?: string | null;
  purposeIds?: string[];
  schoolIds?: string[];
  termIds?: string[];
  tagIds?: string[];
}) {
  const existing = await findUploadSession(input.ownerId, input.uploadSessionId);
  if (existing) return existing;
  await assertUploadTargets(input.ownerId, input);
  const links = [
    ...(input.purposeIds || []),
    ...(input.schoolIds || []),
    ...(input.termIds || []),
    ...(input.tagIds || []),
  ];
  try {
    const created = await prisma.mediaAsset.create({
      data: {
        name: input.name,
        description: input.description || "",
        type: input.type,
        fileUrl: input.fileUrl,
        fileName: input.fileName,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        durationSec: input.durationSec || 0,
        storageProvider: input.storageProvider,
        vodVideoId: input.vodVideoId || "",
        ownerId: input.ownerId,
        categoryId: input.categoryId || null,
        uploadSessionId: input.uploadSessionId || null,
        vocabularyLinks: links.length
          ? { create: links.map((vocabularyId) => ({ vocabularyId })) }
          : undefined,
      },
      include: assetInclude,
    });
    const nodes = await ownerNodes(input.ownerId);
    return toAssetDto(created, nodes);
  } catch (error) {
    if (
      input.uploadSessionId &&
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const again = await findUploadSession(input.ownerId, input.uploadSessionId);
      if (again) return again;
    }
    throw error;
  }
}

function formatFilter(format: MediaFormat): Prisma.MediaAssetWhereInput {
  switch (format) {
    case "pdf":
      return {
        OR: [
          { mimeType: "application/pdf" },
          { fileName: { endsWith: ".pdf" } },
          { fileName: { endsWith: ".PDF" } },
        ],
      };
    case "word":
      return {
        OR: [
          { mimeType: { contains: "word" } },
          { fileName: { endsWith: ".doc" } },
          { fileName: { endsWith: ".docx" } },
        ],
      };
    case "ppt":
      return {
        OR: [
          { mimeType: { contains: "presentation" } },
          { fileName: { endsWith: ".ppt" } },
          { fileName: { endsWith: ".pptx" } },
        ],
      };
    case "sheet":
      return {
        OR: [
          { mimeType: { contains: "spreadsheet" } },
          { mimeType: { contains: "excel" } },
          { fileName: { endsWith: ".xls" } },
          { fileName: { endsWith: ".xlsx" } },
        ],
      };
    case "text":
      return {
        OR: [{ mimeType: "text/plain" }, { fileName: { endsWith: ".txt" } }],
      };
    case "archive":
      return {
        OR: [
          { mimeType: { contains: "zip" } },
          { mimeType: { contains: "compressed" } },
          { fileName: { endsWith: ".zip" } },
          { fileName: { endsWith: ".rar" } },
          { fileName: { endsWith: ".7z" } },
        ],
      };
    case "image":
      return { OR: [{ type: "IMAGE" }, { mimeType: { startsWith: "image/" } }] };
    case "video":
      return { OR: [{ type: "VIDEO" }, { mimeType: { startsWith: "video/" } }] };
    case "audio":
      return { OR: [{ type: "AUDIO" }, { mimeType: { startsWith: "audio/" } }] };
    default:
      return {};
  }
}

async function buildListWhere(
  ownerId: string,
  query: MediaListQuery,
  allOwners = false,
): Promise<Prisma.MediaAssetWhereInput> {
  const and: Prisma.MediaAssetWhereInput[] = allOwners ? [] : [{ ownerId }];
  if (query.ids.length > 0) {
    and.push({ id: { in: query.ids } });
    return { AND: and };
  }
  if (query.view === "uncategorized") and.push({ categoryId: null });
  if (query.view === "category" && query.categoryId) {
    const nodes = await ownerNodes(ownerId, allOwners);
    const category = nodes.find((node) => node.id === query.categoryId);
    if (!category) fail(404, "分类不存在");
    const ids = query.includeDescendants
      ? [category.id, ...descendantIds(category.id, nodes)]
      : [category.id];
    and.push({ categoryId: { in: ids } });
  }
  if (query.type) and.push({ type: query.type });
  if (query.format) and.push(formatFilter(query.format));
  const vocabFilters: Array<[VocabularyKind, string[]]> = [
    ["PURPOSE", query.purposeIds],
    ["SCHOOL", query.schoolIds],
    ["TERM", query.termIds],
    ["TAG", query.tagIds],
  ];
  for (const [kind, ids] of vocabFilters) {
    if (ids.length === 0) continue;
    const owned = allOwners
      ? await existingVocabularyIds(kind, ids)
      : await ownedVocabularyIds(ownerId, kind, ids);
    and.push({
      vocabularyLinks: { some: { vocabularyId: { in: owned } } },
    });
  }
  if (query.q) {
    and.push({
      OR: [
        { name: { contains: query.q } },
        { description: { contains: query.q } },
        { fileName: { contains: query.q } },
        {
          vocabularyLinks: {
            some: {
              vocabulary: {
                ...(allOwners ? {} : { ownerId }),
                kind: "TAG",
                name: { contains: query.q },
              },
            },
          },
        },
      ],
    });
  }
  return { AND: and };
}

export async function listMedia(
  ownerId: string,
  query: MediaListQuery,
  options?: { allOwners?: boolean },
) {
  const allOwners = options?.allOwners === true;
  const where = await buildListWhere(ownerId, query, allOwners);
  const nodes = await ownerNodes(ownerId, allOwners);
  if (query.ids.length > 0) {
    const rows = await prisma.mediaAsset.findMany({ where, include: assetInclude });
    const order = new Map(query.ids.map((id, index) => [id, index]));
    rows.sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0));
    const assets = rows.map((row) => toAssetDto(row, nodes));
    return { assets, total: assets.length, page: 1, pageSize: assets.length || query.pageSize };
  }
  const total = await prisma.mediaAsset.count({ where });
  const pages = Math.max(1, Math.ceil(total / query.pageSize));
  const page = Math.min(query.page, pages);
  const skip = (page - 1) * query.pageSize;
  let rows: AssetRow[];
  if (query.sort === "name" && total > 0 && total <= MEDIA_NAME_SORT_CAP) {
    const names = await prisma.mediaAsset.findMany({
      where,
      select: { id: true, name: true },
    });
    const slice = sortAssetsByName(names).slice(skip, skip + query.pageSize);
    const pageRows = await prisma.mediaAsset.findMany({
      where: { id: { in: slice.map((item) => item.id) } },
      include: assetInclude,
    });
    const order = new Map(slice.map((item, index) => [item.id, index]));
    pageRows.sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0));
    rows = pageRows;
  } else {
    rows = await prisma.mediaAsset.findMany({
      where,
      include: assetInclude,
      orderBy:
        query.sort === "name"
          ? [{ name: "asc" }, { id: "asc" }]
          : [{ createdAt: "desc" }, { id: "desc" }],
      skip,
      take: query.pageSize,
    });
  }
  return {
    assets: rows.map((row) => toAssetDto(row, nodes)),
    total,
    page,
    pageSize: query.pageSize,
  };
}

async function replaceKindLinks(
  tx: Prisma.TransactionClient,
  assetId: string,
  kind: VocabularyKind,
  ids: string[],
) {
  const current = await tx.mediaAssetVocabulary.findMany({
    where: { assetId, vocabulary: { kind } },
    select: { vocabularyId: true },
  });
  const currentIds = current.map((item) => item.vocabularyId);
  const next = new Set(ids);
  const remove = currentIds.filter((id) => !next.has(id));
  if (remove.length > 0) {
    await tx.mediaAssetVocabulary.deleteMany({
      where: { assetId, vocabularyId: { in: remove } },
    });
  }
  const have = new Set(currentIds);
  const add = ids.filter((id) => !have.has(id));
  if (add.length > 0) {
    await tx.mediaAssetVocabulary.createMany({
      data: add.map((vocabularyId) => ({ assetId, vocabularyId })),
    });
  }
}

async function writeSnapshot(
  tx: Prisma.TransactionClient,
  assetId: string,
  snapshot: MediaAttributeSnapshot,
) {
  await tx.mediaAsset.update({
    where: { id: assetId },
    data: { categoryId: snapshot.categoryId },
  });
  await replaceKindLinks(tx, assetId, "PURPOSE", snapshot.purposeIds);
  await replaceKindLinks(tx, assetId, "SCHOOL", snapshot.schoolIds);
  await replaceKindLinks(tx, assetId, "TERM", snapshot.termIds);
  await replaceKindLinks(tx, assetId, "TAG", snapshot.tagIds);
}

export async function updateMediaAsset(
  ownerId: string,
  assetId: string,
  input: {
    name?: string;
    description?: string;
    categoryId?: string | null;
    durationSec?: number;
    purposeIds?: string[];
    schoolIds?: string[];
    termIds?: string[];
    tagIds?: string[];
  },
) {
  const asset = await prisma.mediaAsset.findFirst({
    where: { id: assetId, ownerId },
    include: assetInclude,
  });
  if (!asset) fail(404, "素材不存在");
  await assertUploadTargets(ownerId, {
    categoryId: input.categoryId,
    purposeIds: input.purposeIds,
    schoolIds: input.schoolIds,
    termIds: input.termIds,
    tagIds: input.tagIds,
  });
  const current = snapshotOf(asset);
  const next: MediaAttributeSnapshot = {
    categoryId: input.categoryId === undefined ? current.categoryId : input.categoryId,
    purposeIds: input.purposeIds || current.purposeIds,
    schoolIds: input.schoolIds || current.schoolIds,
    termIds: input.termIds || current.termIds,
    tagIds: input.tagIds || current.tagIds,
  };
  await prisma.$transaction(async (tx) => {
    await tx.mediaAsset.update({
      where: { id: assetId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.durationSec !== undefined ? { durationSec: input.durationSec } : {}),
        categoryId: next.categoryId,
      },
    });
    if (input.purposeIds) await replaceKindLinks(tx, assetId, "PURPOSE", next.purposeIds);
    if (input.schoolIds) await replaceKindLinks(tx, assetId, "SCHOOL", next.schoolIds);
    if (input.termIds) await replaceKindLinks(tx, assetId, "TERM", next.termIds);
    if (input.tagIds) await replaceKindLinks(tx, assetId, "TAG", next.tagIds);
  });
  const updated = await prisma.mediaAsset.findFirstOrThrow({
    where: { id: assetId, ownerId },
    include: assetInclude,
  });
  const nodes = await ownerNodes(ownerId);
  return toAssetDto(updated, nodes);
}

type ReferenceAsset = {
  id: string;
  name: string;
  fileUrl: string;
  vodVideoId: string;
  storageProvider: string;
  ownerId: string;
};

export async function assetReferences(ownerId: string, ids: string[]) {
  const assets = await prisma.mediaAsset.findMany({
    where: { ownerId, id: { in: ids } },
    select: {
      id: true,
      name: true,
      fileUrl: true,
      vodVideoId: true,
      storageProvider: true,
      ownerId: true,
    },
  });
  return { assets, blocked: await referenceBlocks(assets) };
}

async function referenceBlocks(assets: ReferenceAsset[]) {
  const blocked = new Map<string, { assetId: string; name: string; reason: string }>();
  const mark = (asset: ReferenceAsset | undefined, reason: string) => {
    if (!asset || blocked.has(asset.id)) return;
    blocked.set(asset.id, { assetId: asset.id, name: asset.name, reason });
  };
  const urls = assets.map((asset) => asset.fileUrl).filter(Boolean);
  const lessons = await prisma.lesson.findMany({
    where: {
      OR: [
        { mediaAssetId: { in: assets.map((asset) => asset.id) } },
        ...(urls.length > 0 ? [{ videoUrl: { in: urls } }] : []),
      ],
    },
    select: {
      title: true,
      mediaAssetId: true,
      videoUrl: true,
      chapter: { select: { course: { select: { title: true } } } },
    },
  });
  for (const lesson of lessons) {
    for (const asset of assets.filter((item) =>
      item.id === lesson.mediaAssetId || (item.fileUrl && item.fileUrl === lesson.videoUrl),
    )) {
      mark(asset, `已被课程「${lesson.chapter.course.title}」的课时「${lesson.title}」使用`);
    }
  }
  if (urls.length > 0) {
    const resources = await prisma.lessonResource.findMany({
      where: { fileUrl: { in: urls } },
      select: {
        fileUrl: true,
        title: true,
        lesson: {
          select: {
            title: true,
            chapter: { select: { course: { select: { title: true, productType: true } } } },
          },
        },
      },
    });
    for (const resource of resources) {
      const course = resource.lesson.chapter.course;
      for (const asset of assets.filter((item) => item.fileUrl === resource.fileUrl)) {
        mark(
          asset,
          `已被${course.productType === "PRODUCT" ? "商品" : "课程"}「${course.title}」的讲义「${resource.title}」使用`,
        );
      }
    }
    const products = await prisma.course.findMany({
      where: {
        OR: [
          { coverUrl: { in: urls } },
          ...urls.map((url) => ({ galleryJson: { contains: url } })),
        ],
      },
      select: { title: true, productType: true, coverUrl: true, galleryJson: true },
    });
    for (const product of products) {
      const referenced = assets.filter(
        (item) =>
          item.fileUrl &&
          (item.fileUrl === product.coverUrl || product.galleryJson.includes(item.fileUrl)),
      );
      for (const asset of referenced) {
        mark(
          asset,
          `已被${product.productType === "PRODUCT" ? "商品" : "课程"}「${product.title}」用作封面或图片`,
        );
      }
    }
  }
  return blocked;
}

export async function deleteMediaAssetsForManager(
  actor: RoleInput & { id: string },
  ids: string[],
) {
  if (!isAdmin(actor)) return deleteMediaAssets(actor.id, ids);
  const uniqueIds = [...new Set(ids)];
  const assets = await prisma.mediaAsset.findMany({
    where: { id: { in: uniqueIds } },
    select: {
      id: true,
      name: true,
      fileUrl: true,
      vodVideoId: true,
      storageProvider: true,
      ownerId: true,
    },
  });
  if (assets.length === 0) fail(404, "没有可删除的素材");
  const blocked = await referenceBlocks(assets);
  return removeUnreferenced(assets, blocked);
}

export async function deleteMediaAssets(ownerId: string, ids: string[]) {
  const uniqueIds = [...new Set(ids)];
  const { assets, blocked } = await assetReferences(ownerId, uniqueIds);
  return removeUnreferenced(assets, blocked, ownerId);
}

async function removeUnreferenced(
  assets: ReferenceAsset[],
  blocked: Map<string, { assetId: string; name: string; reason: string }>,
  ownerId?: string,
) {
  if (assets.length === 0) fail(404, "没有可删除的素材");
  const blockedIds = new Set(blocked.keys());
  const { deletable } = splitDeletableAssets(
    assets.map((asset) => asset.id),
    blockedIds,
  );
  const deletableRows = assets.filter((asset) => deletable.includes(asset.id));
  if (deletableRows.length > 0) {
    await prisma.mediaAsset.deleteMany({
      where: {
        ...(ownerId ? { ownerId } : {}),
        id: { in: deletableRows.map((asset) => asset.id) },
      },
    });
  }
  return {
    deletedIds: deletableRows.map((asset) => asset.id),
    deletedFiles: deletableRows,
    blocked: [...blocked.values()],
  };
}

function collectIds(change: IdFieldChange): string[] {
  if (change.mode === "set" || change.mode === "add" || change.mode === "remove") {
    return change.ids;
  }
  return [];
}

export async function organizeMedia(ownerId: string, request: OrganizeRequest) {
  const assetIds = [...new Set(request.assetIds)].slice(0, MEDIA_ORGANIZE_MAX);
  if (assetIds.length === 0) fail(400, "请选择素材");
  if (!organizeChangesSomething(request)) fail(400, "没有要修改的字段");
  if (request.category.mode === "set") {
    await requireOwnedCategory(ownerId, request.category.categoryId);
  }
  await ownedVocabularyIds(ownerId, "PURPOSE", collectIds(request.purposes));
  await ownedVocabularyIds(ownerId, "SCHOOL", collectIds(request.schools));
  await ownedVocabularyIds(ownerId, "TERM", collectIds(request.terms));
  await ownedVocabularyIds(ownerId, "TAG", collectIds(request.tags));

  const rows = await prisma.mediaAsset.findMany({
    where: { ownerId, id: { in: assetIds } },
    include: assetInclude,
  });
  const found = new Set(rows.map((row) => row.id));
  const failed = assetIds
    .filter((id) => !found.has(id))
    .map((id) => ({ assetId: id, name: id, error: "素材不存在或无权修改" }));
  const diffs: MediaOrganizeDiff[] = [];
  for (const row of rows) {
    const before = snapshotOf(row);
    const after = nextAttributeSnapshot(before, request);
    if (snapshotEquals(before, after)) continue;
    diffs.push({ assetId: row.id, name: row.name, before, after });
  }
  const log = await prisma.$transaction(async (tx) => {
    for (const diff of diffs) {
      await writeSnapshot(tx, diff.assetId, diff.after);
    }
    const created = await tx.mediaOrganizeLog.create({
      data: {
        ownerId,
        actorId: ownerId,
        action: "BATCH_UPDATE",
        assetCount: diffs.length,
        diffJson: JSON.stringify(diffs),
      },
    });
    await tx.siteAuditLog.create({
      data: {
        actorId: ownerId,
        action: "media.organize",
        entityType: "MediaOrganizeLog",
        entityId: created.id,
        detail: JSON.stringify({
          assetCount: diffs.length,
          category: request.category.mode,
          purposes: request.purposes.mode,
          schools: request.schools.mode,
          terms: request.terms.mode,
          tags: request.tags.mode,
        }),
      },
    });
    return created;
  });
  return {
    ok: true,
    logId: log.id,
    updated: diffs.length,
    failed,
  };
}

export async function undoOrganize(ownerId: string, logId: string) {
  const log = await prisma.mediaOrganizeLog.findFirst({
    where: { id: logId, ownerId },
  });
  if (!log) fail(404, "找不到这次整理记录");
  if (log.undoneAt) fail(400, "这次整理已经撤销");
  const diffs = JSON.parse(log.diffJson) as MediaOrganizeDiff[];
  const conflicts: Array<{ assetId: string; name: string; fields: string[] }> = [];
  let restored = 0;
  await prisma.$transaction(async (tx) => {
    for (const diff of diffs) {
      const row = await tx.mediaAsset.findFirst({
        where: { id: diff.assetId, ownerId },
        include: assetInclude,
      });
      if (!row) {
        conflicts.push({ assetId: diff.assetId, name: diff.name, fields: ["素材已不存在"] });
        continue;
      }
      const current = snapshotOf(row);
      const result = undoSnapshot(current, diff);
      if (result.conflicts.length > 0) {
        conflicts.push({ assetId: diff.assetId, name: diff.name, fields: result.conflicts });
      }
      if (!snapshotEquals(current, result.next)) {
        await writeSnapshot(tx, row.id, result.next);
        restored += 1;
      }
    }
    await tx.mediaOrganizeLog.update({
      where: { id: log.id },
      data: { undoneAt: new Date() },
    });
    await tx.siteAuditLog.create({
      data: {
        actorId: ownerId,
        action: "media.organize.undo",
        entityType: "MediaOrganizeLog",
        entityId: log.id,
        detail: JSON.stringify({ restored, conflicts: conflicts.length }),
      },
    });
  });
  return { ok: true, restored, conflicts };
}

export function categoryFieldFromBody(value: unknown): CategoryFieldChange {
  if (!value || typeof value !== "object") return { mode: "keep" };
  const mode = "mode" in value ? String(value.mode) : "keep";
  if (mode === "clear") return { mode: "clear" };
  if (mode === "set" && "categoryId" in value && typeof value.categoryId === "string") {
    return { mode: "set", categoryId: value.categoryId };
  }
  return { mode: "keep" };
}

export function idFieldFromBody(value: unknown): IdFieldChange {
  if (!value || typeof value !== "object") return { mode: "keep" };
  const mode = "mode" in value ? String(value.mode) : "keep";
  const ids =
    "ids" in value && Array.isArray(value.ids)
      ? value.ids.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];
  if (mode === "clear") return { mode: "clear" };
  if (mode === "set" || mode === "add" || mode === "remove") return { mode, ids };
  return { mode: "keep" };
}

export const mediaLibraryUncategorizedLabel = UNCATEGORIZED_LABEL;

