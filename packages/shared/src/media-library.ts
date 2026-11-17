/**
 * 素材分类、筛选、选择草稿与批量整理的纯规则。
 * 不访问数据库：接口和界面共用这里的判断，避免各写一套。
 */
import { fileExtension, isMediaKind, type MediaKind } from "./media";

/** 界面推荐两到三级；根算第一级。 */
export const MEDIA_CATEGORY_MAX_DEPTH = 3;

export const MEDIA_PAGE_SIZE_DEFAULT = 24;
export const MEDIA_PAGE_SIZE_MAX = 48;
export const MEDIA_LIST_ID_MAX = 200;
export const MEDIA_ORGANIZE_MAX = 100;
export const MEDIA_NAME_SORT_CAP = 8000;

/** 虚拟视图，不是可写入的分类。 */
export const MEDIA_VIEW_ALL = "all";
export const MEDIA_VIEW_RECENT = "recent";
export const MEDIA_VIEW_UNCATEGORIZED = "uncategorized";

/** 与历史 categoryId=uncategorized 查询保持同一语义。 */
export const UNCATEGORIZED_QUERY = "uncategorized";
export const UNCATEGORIZED_LABEL = "待整理";

/** 组课时无分类章节的内部键，不拿显示文案当身份。 */
export const UNCATEGORIZED_CHAPTER_KEY = "__uncategorized__";

export const VOCABULARY_KINDS = ["PURPOSE", "SCHOOL", "TERM", "TAG"] as const;
export type VocabularyKind = (typeof VOCABULARY_KINDS)[number];

export const DEFAULT_MEDIA_PURPOSES = [
  "课程录屏",
  "讲义",
  "试卷",
  "答案解析",
  "作业",
  "教材",
  "宣传素材",
] as const;

export const MEDIA_FORMATS = [
  "pdf",
  "word",
  "ppt",
  "sheet",
  "text",
  "archive",
  "image",
  "video",
  "audio",
] as const;
export type MediaFormat = (typeof MEDIA_FORMATS)[number];

export const MEDIA_FORMAT_LABEL: Record<MediaFormat, string> = {
  pdf: "PDF",
  word: "Word",
  ppt: "PPT",
  sheet: "表格",
  text: "文本",
  archive: "压缩包",
  image: "图片",
  video: "视频",
  audio: "音频",
};

/** 只供用户点选启用，不会在上线时自动套到旧素材上。 */
export const MEDIA_DIRECTORY_TEMPLATE: Array<{
  name: string;
  children: string[];
}> = [
  {
    name: "大学数学",
    children: ["高等数学", "微积分", "线性代数", "概率论与数理统计", "常微分方程"],
  },
  { name: "经济金融", children: ["经济学", "金融学"] },
  { name: "其他课程", children: [] },
  { name: "宣传与通用素材", children: ["商品封面", "宣传图片", "介绍视频"] },
];

export type CategoryNode = {
  id: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
  ownerId: string;
};

export type MediaListQuery = {
  ids: string[];
  view: "all" | "recent" | "uncategorized" | "category";
  categoryId?: string;
  includeDescendants: boolean;
  type?: MediaKind;
  format?: MediaFormat;
  purposeIds: string[];
  schoolIds: string[];
  termIds: string[];
  tagIds: string[];
  q: string;
  sort: "recent" | "name";
  page: number;
  pageSize: number;
};

export type CategoryFieldChange =
  | { mode: "keep" }
  | { mode: "clear" }
  | { mode: "set"; categoryId: string };

export type IdFieldChange =
  | { mode: "keep" }
  | { mode: "clear" }
  | { mode: "set"; ids: string[] }
  | { mode: "add"; ids: string[] }
  | { mode: "remove"; ids: string[] };

export type OrganizeRequest = {
  assetIds: string[];
  category: CategoryFieldChange;
  purposes: IdFieldChange;
  schools: IdFieldChange;
  terms: IdFieldChange;
  tags: IdFieldChange;
};

export type MediaAttributeSnapshot = {
  categoryId: string | null;
  purposeIds: string[];
  schoolIds: string[];
  termIds: string[];
  tagIds: string[];
};

export type MediaOrganizeDiff = {
  assetId: string;
  name: string;
  before: MediaAttributeSnapshot;
  after: MediaAttributeSnapshot;
};

export type UploadBatchPatch = {
  categoryId?: string | null;
  purposeIds?: string[];
  schoolIds?: string[];
  termIds?: string[];
  tagIds?: string[];
};

export type UploadItemDraft = {
  key: string;
  displayName: string;
  displayNameTouched: boolean;
  categoryId: string | null;
  categoryTouched: boolean;
  purposeIds: string[];
  purposesTouched: boolean;
  schoolIds: string[];
  schoolsTouched: boolean;
  termIds: string[];
  termsTouched: boolean;
  tagIds: string[];
  tagsTouched: boolean;
  uploadSessionId: string;
  status: "queued" | "uploading" | "done" | "error";
};

const KEEP: IdFieldChange = { mode: "keep" };

export function isVocabularyKind(value: string): value is VocabularyKind {
  return (VOCABULARY_KINDS as readonly string[]).includes(value);
}

export function isMediaFormat(value: string): value is MediaFormat {
  return (MEDIA_FORMATS as readonly string[]).includes(value);
}

/** 根分类用空字符串，避免 SQLite 把多个 NULL 当成不冲突。 */
export function parentKeyOf(parentId: string | null | undefined): string {
  return parentId ? parentId : "";
}

/** 新上传的对象键只用分类 id，不用用户起的文件夹名。 */
export function storageCategorySegment(categoryId: string | null | undefined): string {
  if (!categoryId) return "uncategorized";
  if (!/^[\w-]+$/.test(categoryId)) return "uncategorized";
  return categoryId;
}

export function dedupePreserveOrder(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function sameIdSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((id) => rightSet.has(id));
}

export function toggleSelectedId(selected: string[], id: string): string[] {
  if (selected.includes(id)) return selected.filter((item) => item !== id);
  return [...selected, id];
}

/** 只并入当前这一页已经加载的 id，不会碰未加载结果。 */
export function selectPageIds(selected: string[], pageIds: string[]): string[] {
  return dedupePreserveOrder([...selected, ...pageIds]);
}

export function unselectPageIds(selected: string[], pageIds: string[]): string[] {
  const page = new Set(pageIds);
  return selected.filter((id) => !page.has(id));
}

export function moveSelectedId(
  selected: string[],
  id: string,
  direction: -1 | 1,
): string[] {
  const index = selected.indexOf(id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= selected.length) return selected;
  const next = selected.slice();
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item);
  return next;
}

export function rangeSelectIds(
  selected: string[],
  orderedIds: string[],
  anchorId: string,
  targetId: string,
  additive: boolean,
): string[] {
  const from = orderedIds.indexOf(anchorId);
  const to = orderedIds.indexOf(targetId);
  if (from < 0 || to < 0) return toggleSelectedId(selected, targetId);
  const start = Math.min(from, to);
  const end = Math.max(from, to);
  const range = orderedIds.slice(start, end + 1);
  if (!additive) return dedupePreserveOrder(range);
  return dedupePreserveOrder([...selected, ...range]);
}

export function compareNatural(left: string, right: string): number {
  const leftParts = left.match(/\d+|\D+/g) || [];
  const rightParts = right.match(/\d+|\D+/g) || [];
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const a = leftParts[index];
    const b = rightParts[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    const aNum = /^\d+$/.test(a);
    const bNum = /^\d+$/.test(b);
    if (aNum && bNum) {
      const diff = Number(a) - Number(b);
      if (diff !== 0) return diff;
      if (a.length !== b.length) return a.length - b.length;
      continue;
    }
    if (a !== b) return a.localeCompare(b, "zh");
  }
  return 0;
}

export function categoryById(nodes: CategoryNode[]): Map<string, CategoryNode> {
  return new Map(nodes.map((node) => [node.id, node]));
}

export function categoryDepth(id: string, nodes: CategoryNode[]): number {
  const byId = categoryById(nodes);
  let depth = 0;
  let current = byId.get(id);
  const seen = new Set<string>();
  while (current) {
    if (seen.has(current.id)) return MEDIA_CATEGORY_MAX_DEPTH + 1;
    seen.add(current.id);
    depth += 1;
    if (!current.parentId) break;
    current = byId.get(current.parentId);
  }
  return depth;
}

export function descendantIds(id: string, nodes: CategoryNode[]): string[] {
  const out: string[] = [];
  const queue = nodes.filter((node) => node.parentId === id).map((node) => node.id);
  const seen = new Set<string>();
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next || seen.has(next)) continue;
    seen.add(next);
    out.push(next);
    for (const node of nodes) {
      if (node.parentId === next) queue.push(node.id);
    }
  }
  return out;
}

export function subtreeHeight(id: string, nodes: CategoryNode[]): number {
  const children = nodes.filter((node) => node.parentId === id);
  if (children.length === 0) return 1;
  return 1 + Math.max(...children.map((child) => subtreeHeight(child.id, nodes)));
}

export function categoryPath(id: string, nodes: CategoryNode[]): string {
  const byId = categoryById(nodes);
  const names: string[] = [];
  let current = byId.get(id);
  const seen = new Set<string>();
  while (current) {
    if (seen.has(current.id)) break;
    seen.add(current.id);
    names.push(current.name);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return names.reverse().join(" / ");
}

export function validateCategoryPlacement(input: {
  nodes: CategoryNode[];
  ownerId: string;
  categoryId?: string;
  name: string;
  parentId: string | null;
}): { ok: true } | { ok: false; error: string } {
  const name = input.name.trim();
  if (!name) return { ok: false, error: "请填写分类名称" };
  const nodes = input.nodes.filter((node) => node.ownerId === input.ownerId);
  if (input.parentId) {
    const parent = nodes.find((node) => node.id === input.parentId);
    if (!parent) return { ok: false, error: "父分类不存在" };
    if (input.categoryId && input.parentId === input.categoryId) {
      return { ok: false, error: "分类不能放到自己下面" };
    }
    if (input.categoryId && descendantIds(input.categoryId, nodes).includes(input.parentId)) {
      return { ok: false, error: "分类不能移动到自己的子分类下" };
    }
  }
  const siblingTaken = nodes.some(
    (node) =>
      node.id !== input.categoryId &&
      (node.parentId || null) === input.parentId &&
      node.name === name,
  );
  if (siblingTaken) return { ok: false, error: "同一层级已有同名分类" };

  const parentDepth = input.parentId ? categoryDepth(input.parentId, nodes) : 0;
  const height = input.categoryId ? subtreeHeight(input.categoryId, nodes) : 1;
  if (parentDepth + height > MEDIA_CATEGORY_MAX_DEPTH) {
    return { ok: false, error: `分类最多 ${MEDIA_CATEGORY_MAX_DEPTH} 级` };
  }
  return { ok: true };
}

export function sortCategorySiblings(nodes: CategoryNode[]): CategoryNode[] {
  return nodes.slice().sort((left, right) => {
    if (left.sortOrder !== right.sortOrder) return left.sortOrder - right.sortOrder;
    const byName = compareNatural(left.name, right.name);
    if (byName !== 0) return byName;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

export type TemplatePlanItem = {
  name: string;
  parentName: string | null;
  action: "create" | "keep";
};

/** 只按「父级 + 名称」判断是否已有，不按名字猜测把旧分类搬进去。 */
export function previewTemplateAdditions(nodes: CategoryNode[]): TemplatePlanItem[] {
  const plan: TemplatePlanItem[] = [];
  const roots = nodes.filter((node) => !node.parentId);
  for (const group of MEDIA_DIRECTORY_TEMPLATE) {
    const root = roots.find((node) => node.name === group.name);
    plan.push({
      name: group.name,
      parentName: null,
      action: root ? "keep" : "create",
    });
    const children = root ? nodes.filter((node) => node.parentId === root.id) : [];
    for (const childName of group.children) {
      const child = children.find((node) => node.name === childName);
      plan.push({
        name: childName,
        parentName: group.name,
        action: child ? "keep" : "create",
      });
    }
  }
  return plan;
}

export function detectMediaFormat(mimeType: string, fileName: string): MediaFormat | "" {
  const mime = (mimeType || "").toLowerCase();
  const ext = fileExtension(fileName);
  if (mime === "application/pdf" || ext === "pdf") return "pdf";
  if (
    ext === "doc" ||
    ext === "docx" ||
    mime.includes("wordprocessing") ||
    mime === "application/msword"
  ) {
    return "word";
  }
  if (ext === "ppt" || ext === "pptx" || mime.includes("presentation")) return "ppt";
  if (ext === "xls" || ext === "xlsx" || mime.includes("spreadsheet") || mime.includes("ms-excel")) {
    return "sheet";
  }
  if (ext === "txt" || mime === "text/plain") return "text";
  if (
    ["zip", "rar", "7z", "tar", "gz"].includes(ext) ||
    mime.includes("zip") ||
    mime.includes("compressed") ||
    mime.includes("tar")
  ) {
    return "archive";
  }
  if (mime.startsWith("image/") || ["jpg", "jpeg", "png", "webp", "gif", "bmp"].includes(ext)) {
    return "image";
  }
  if (mime.startsWith("video/") || ["mp4", "webm", "mov", "avi", "mpeg", "mpg", "m4v"].includes(ext)) {
    return "video";
  }
  if (mime.startsWith("audio/") || ["mp3", "wav", "aac", "m4a", "ogg"].includes(ext)) {
    return "audio";
  }
  return "";
}

function readIdList(params: URLSearchParams, key: string): string[] {
  return dedupePreserveOrder(
    params
      .getAll(key)
      .flatMap((value) => value.split(","))
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

export function parseMediaListParams(params: URLSearchParams): MediaListQuery {
  const ids = readIdList(params, "ids").slice(0, MEDIA_LIST_ID_MAX);
  const categoryRaw = (params.get("categoryId") || "").trim();
  const viewRaw = (params.get("view") || "").trim();
  let view: MediaListQuery["view"] = "all";
  let categoryId: string | undefined;
  if (viewRaw === MEDIA_VIEW_RECENT) view = "recent";
  else if (viewRaw === MEDIA_VIEW_UNCATEGORIZED || categoryRaw === UNCATEGORIZED_QUERY) {
    view = "uncategorized";
  } else if (categoryRaw && categoryRaw !== MEDIA_VIEW_ALL) {
    view = "category";
    categoryId = categoryRaw;
  }
  const typeRaw = (params.get("type") || "").trim().toUpperCase();
  const formatRaw = (params.get("format") || "").trim();
  const page = Math.max(1, Math.floor(Number(params.get("page")) || 1));
  const pageSize = Math.min(
    MEDIA_PAGE_SIZE_MAX,
    Math.max(1, Math.floor(Number(params.get("pageSize")) || MEDIA_PAGE_SIZE_DEFAULT)),
  );
  return {
    ids,
    view: ids.length > 0 ? "all" : view,
    categoryId,
    includeDescendants: params.get("includeDescendants") !== "0",
    type: isMediaKind(typeRaw) ? typeRaw : undefined,
    format: isMediaFormat(formatRaw) ? formatRaw : undefined,
    purposeIds: readIdList(params, "purposeId"),
    schoolIds: readIdList(params, "schoolId"),
    termIds: readIdList(params, "termId"),
    tagIds: readIdList(params, "tagId"),
    q: (params.get("q") || "").trim().slice(0, 80),
    sort: view === "recent" || params.get("sort") !== "name" ? "recent" : "name",
    page: ids.length > 0 ? 1 : page,
    pageSize: ids.length > 0 ? Math.max(ids.length, 1) : pageSize,
  };
}

export function buildMediaListSearch(query: MediaListQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.ids.length > 0) {
    params.set("ids", query.ids.join(","));
    return params;
  }
  if (query.view === "recent") params.set("view", "recent");
  if (query.view === "uncategorized") params.set("view", "uncategorized");
  if (query.view === "category" && query.categoryId) {
    params.set("categoryId", query.categoryId);
    if (!query.includeDescendants) params.set("includeDescendants", "0");
  }
  if (query.type) params.set("type", query.type);
  if (query.format) params.set("format", query.format);
  if (query.purposeIds.length > 0) params.set("purposeId", query.purposeIds.join(","));
  if (query.schoolIds.length > 0) params.set("schoolId", query.schoolIds.join(","));
  if (query.termIds.length > 0) params.set("termId", query.termIds.join(","));
  if (query.tagIds.length > 0) params.set("tagId", query.tagIds.join(","));
  if (query.q) params.set("q", query.q);
  if (query.sort === "name") params.set("sort", "name");
  params.set("page", String(query.page));
  params.set("pageSize", String(query.pageSize));
  return params;
}

export type FilterableAsset = {
  name: string;
  description: string;
  fileName: string;
  type: string;
  mimeType: string;
  categoryId: string | null;
  purposeIds: string[];
  schoolIds: string[];
  termIds: string[];
  tagIds: string[];
  tagNames: string[];
};

function overlaps(current: string[], wanted: string[]): boolean {
  if (wanted.length === 0) return true;
  return wanted.some((id) => current.includes(id));
}

/** 同一维度取或，不同维度取且。学校留空不会被当成「通用」。 */
export function assetMatchesListQuery(
  asset: FilterableAsset,
  query: MediaListQuery,
  scopeIds: string[] | null,
): boolean {
  if (query.ids.length > 0) return true;
  if (query.view === "uncategorized" && asset.categoryId) return false;
  if (query.view === "category") {
    if (!asset.categoryId || !scopeIds?.includes(asset.categoryId)) return false;
  }
  if (query.type && asset.type !== query.type) return false;
  if (query.format && detectMediaFormat(asset.mimeType, asset.fileName) !== query.format) {
    return false;
  }
  if (!overlaps(asset.purposeIds, query.purposeIds)) return false;
  if (!overlaps(asset.schoolIds, query.schoolIds)) return false;
  if (!overlaps(asset.termIds, query.termIds)) return false;
  if (!overlaps(asset.tagIds, query.tagIds)) return false;
  if (query.q) {
    const haystack = [asset.name, asset.description, asset.fileName, ...asset.tagNames];
    if (!haystack.some((item) => item.includes(query.q))) return false;
  }
  return true;
}

export function pageWindow<T>(items: T[], page: number, pageSize: number) {
  const size = Math.min(MEDIA_PAGE_SIZE_MAX, Math.max(1, pageSize));
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(1, page), pages);
  const start = (current - 1) * size;
  return {
    items: items.slice(start, start + size),
    total,
    page: current,
    pageSize: size,
    pages,
  };
}

export function sortAssetsByName<T extends { id: string; name: string }>(items: T[]): T[] {
  return items.slice().sort((left, right) => {
    const byName = compareNatural(left.name, right.name);
    if (byName !== 0) return byName;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

export function groupAssetsByCategory<
  T extends { category: { id: string; name: string; path?: string } | null },
>(assets: T[]): Array<{ key: string; title: string; assets: T[] }> {
  const groups: Array<{ key: string; title: string; assets: T[] }> = [];
  const index = new Map<string, number>();
  for (const asset of assets) {
    const key = asset.category?.id || UNCATEGORIZED_CHAPTER_KEY;
    const title = asset.category?.path || asset.category?.name || UNCATEGORIZED_LABEL;
    const found = index.get(key);
    if (found === undefined) {
      index.set(key, groups.length);
      groups.push({ key, title, assets: [asset] });
    } else {
      groups[found].assets.push(asset);
    }
  }
  return groups;
}

export function categoryPathFromLoaded(
  category: {
    name: string;
    parent?: { name: string; parent?: { name: string } | null } | null;
  } | null,
): string {
  if (!category) return "";
  const names: string[] = [];
  if (category.parent?.parent?.name) names.push(category.parent.parent.name);
  if (category.parent?.name) names.push(category.parent.name);
  names.push(category.name);
  return names.join(" / ");
}

export function emptyOrganizeRequest(assetIds: string[]): OrganizeRequest {
  return {
    assetIds,
    category: { mode: "keep" },
    purposes: KEEP,
    schools: KEEP,
    terms: KEEP,
    tags: KEEP,
  };
}

export function organizeChangesSomething(request: OrganizeRequest): boolean {
  return (
    request.category.mode !== "keep" ||
    request.purposes.mode !== "keep" ||
    request.schools.mode !== "keep" ||
    request.terms.mode !== "keep" ||
    request.tags.mode !== "keep"
  );
}

export function applyIdField(current: string[], change: IdFieldChange): string[] {
  if (change.mode === "keep") return current.slice();
  if (change.mode === "clear") return [];
  if (change.mode === "set") return dedupePreserveOrder(change.ids);
  if (change.mode === "add") return dedupePreserveOrder([...current, ...change.ids]);
  return current.filter((id) => !change.ids.includes(id));
}

export function nextAttributeSnapshot(
  current: MediaAttributeSnapshot,
  request: OrganizeRequest,
): MediaAttributeSnapshot {
  return {
    categoryId:
      request.category.mode === "keep"
        ? current.categoryId
        : request.category.mode === "clear"
          ? null
          : request.category.categoryId,
    purposeIds: applyIdField(current.purposeIds, request.purposes),
    schoolIds: applyIdField(current.schoolIds, request.schools),
    termIds: applyIdField(current.termIds, request.terms),
    tagIds: applyIdField(current.tagIds, request.tags),
  };
}

export function snapshotEquals(
  left: MediaAttributeSnapshot,
  right: MediaAttributeSnapshot,
): boolean {
  return (
    left.categoryId === right.categoryId &&
    sameIdSet(left.purposeIds, right.purposeIds) &&
    sameIdSet(left.schoolIds, right.schoolIds) &&
    sameIdSet(left.termIds, right.termIds) &&
    sameIdSet(left.tagIds, right.tagIds)
  );
}

/**
 * 只有当前值仍等于当时写下的结果，才退回之前的值。
 * 之后又被改过的字段保持现状。
 */
export function undoSnapshot(
  current: MediaAttributeSnapshot,
  diff: Pick<MediaOrganizeDiff, "before" | "after">,
): { next: MediaAttributeSnapshot; conflicts: string[] } {
  const conflicts: string[] = [];
  const next: MediaAttributeSnapshot = { ...current };
  if (current.categoryId === diff.after.categoryId) {
    next.categoryId = diff.before.categoryId;
  } else if (current.categoryId !== diff.before.categoryId) {
    conflicts.push("分类");
  }
  const pairs: Array<[keyof Omit<MediaAttributeSnapshot, "categoryId">, string]> = [
    ["purposeIds", "用途"],
    ["schoolIds", "学校"],
    ["termIds", "学期"],
    ["tagIds", "标签"],
  ];
  for (const [key, label] of pairs) {
    if (sameIdSet(current[key], diff.after[key])) {
      next[key] = diff.before[key].slice();
    } else if (!sameIdSet(current[key], diff.before[key])) {
      conflicts.push(label);
    }
  }
  return { next, conflicts };
}

export function splitDeletableAssets(ids: string[], referencedIds: Set<string>) {
  return {
    deletable: ids.filter((id) => !referencedIds.has(id)),
    blocked: ids.filter((id) => referencedIds.has(id)),
  };
}

export function applyUploadBatch<T extends UploadItemDraft>(
  items: T[],
  patch: UploadBatchPatch,
): { items: T[]; updatedKeys: string[] } {
  const updatedKeys: string[] = [];
  const next = items.map((item) => {
    if (item.status === "uploading" || item.status === "done") return item;
    let changed = false;
    const copy = { ...item };
    if (patch.categoryId !== undefined && !item.categoryTouched) {
      copy.categoryId = patch.categoryId;
      changed = true;
    }
    if (patch.purposeIds && !item.purposesTouched) {
      copy.purposeIds = patch.purposeIds.slice();
      changed = true;
    }
    if (patch.schoolIds && !item.schoolsTouched) {
      copy.schoolIds = patch.schoolIds.slice();
      changed = true;
    }
    if (patch.termIds && !item.termsTouched) {
      copy.termIds = patch.termIds.slice();
      changed = true;
    }
    if (patch.tagIds && !item.tagsTouched) {
      copy.tagIds = patch.tagIds.slice();
      changed = true;
    }
    if (changed) updatedKeys.push(item.key);
    return copy;
  });
  return { items: next, updatedKeys };
}

export type MediaCategoryDto = {
  id: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
  depth: number;
  path: string;
  directCount: number;
  /** 本级加全部后代素材数，已去重（一个素材只有一个主分类）。 */
  treeCount: number;
};

export type MediaVocabularyDto = {
  id: string;
  kind: VocabularyKind;
  name: string;
  isGeneral: boolean;
  sortOrder: number;
};

export type MediaAssetDto = {
  id: string;
  name: string;
  description: string;
  type: string;
  fileUrl: string;
  fileName: string;
  mimeType: string;
  format: string;
  sizeBytes: number;
  durationSec: number;
  categoryId: string | null;
  category: { id: string; name: string; path: string } | null;
  createdAt: string;
  purposes: Array<{ id: string; name: string }>;
  schools: Array<{ id: string; name: string; isGeneral: boolean }>;
  terms: Array<{ id: string; name: string }>;
  tags: Array<{ id: string; name: string }>;
};

export function parseIdListInput(value: unknown): string[] {
  if (Array.isArray(value)) {
    return dedupePreserveOrder(
      value.filter((item): item is string => typeof item === "string").map((item) => item.trim()),
    );
  }
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parseIdListInput(parsed);
  } catch {
    // 逗号分隔
  }
  return dedupePreserveOrder(value.split(",").map((item) => item.trim()));
}

export function organizeFieldLabels(request: OrganizeRequest): string[] {
  const labels: string[] = [];
  if (request.category.mode !== "keep") labels.push("分类");
  if (request.purposes.mode !== "keep") labels.push("用途");
  if (request.schools.mode !== "keep") labels.push("学校");
  if (request.terms.mode !== "keep") labels.push("学期");
  if (request.tags.mode !== "keep") labels.push("标签");
  return labels;
}
