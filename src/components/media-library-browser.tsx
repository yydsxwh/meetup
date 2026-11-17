"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  MEDIA_KIND_LABEL,
  MEDIA_KINDS,
  MEDIA_UPLOAD_ACCEPT,
  formatBytes,
  isMediaKind,
  type MediaKind,
} from "@andyyyds/shared/media";
import {
  MEDIA_FORMAT_LABEL,
  MEDIA_FORMATS,
  MEDIA_PAGE_SIZE_DEFAULT,
  UNCATEGORIZED_LABEL,
  applyUploadBatch,
  buildMediaListSearch,
  moveSelectedId,
  organizeFieldLabels,
  rangeSelectIds,
  selectPageIds,
  sortCategorySiblings,
  toggleSelectedId,
  unselectPageIds,
  type CategoryNode,
  type IdFieldChange,
  type MediaAssetDto,
  type MediaCategoryDto,
  type MediaListQuery,
  type MediaVocabularyDto,
  type OrganizeRequest,
  type UploadItemDraft,
} from "@andyyyds/shared/media-library";
import { saveExternalMedia, uploadMediaFile } from "@/components/media-upload-client";

type Mode = "single" | "multi" | "manage";

type QueueItem = UploadItemDraft & {
  file?: File;
  error?: string;
  asset?: MediaAssetDto;
  percent: number;
};

type Props = {
  mode: Mode;
  mediaKind?: MediaKind | "all";
  selectedIds?: string[];
  onSelectedIdsChange?: (ids: string[]) => void;
  onPick?: (asset: MediaAssetDto) => void;
  onSeen?: (assets: MediaAssetDto[]) => void;
  onConfirm?: (ids: string[]) => void;
  onCompose?: (ids: string[]) => void;
  allowUpload?: boolean;
  allowOrganize?: boolean;
  allowSiteScope?: boolean;
  canDelete?: boolean;
  canCreateSellable?: boolean;
  confirmLabel?: string;
  fill?: boolean;
};

const hit =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl px-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand)]";

function newId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `up_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function formatDuration(sec: number) {
  if (!sec || sec < 0) return "";
  const minutes = Math.floor(sec / 60);
  const seconds = Math.floor(sec % 60);
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function asNodes(categories: MediaCategoryDto[]): CategoryNode[] {
  return categories.map((category) => ({
    id: category.id,
    name: category.name,
    parentId: category.parentId,
    sortOrder: category.sortOrder,
    ownerId: "self",
  }));
}

export function MediaLibraryBrowser({
  mode,
  mediaKind = "all",
  selectedIds,
  onSelectedIdsChange,
  onPick,
  onSeen,
  onConfirm,
  onCompose,
  allowUpload = false,
  allowOrganize = false,
  allowSiteScope = false,
  canDelete = false,
  canCreateSellable = false,
  confirmLabel = "确认素材并继续",
  fill = false,
}: Props) {
  const [internalSelected, setInternalSelected] = useState<string[]>([]);
  const selected = selectedIds ?? internalSelected;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [categories, setCategories] = useState<MediaCategoryDto[]>([]);
  const [summary, setSummary] = useState({ all: 0, uncategorized: 0 });
  const [vocabulary, setVocabulary] = useState<MediaVocabularyDto[]>([]);
  const [assets, setAssets] = useState<MediaAssetDto[]>([]);
  const [known, setKnown] = useState<Record<string, MediaAssetDto>>({});
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [view, setView] = useState<MediaListQuery["view"]>(mediaKind === "all" ? "all" : "all");
  const [categoryId, setCategoryId] = useState<string | undefined>();
  const [includeDescendants, setIncludeDescendants] = useState(true);
  const [kind, setKind] = useState<MediaKind | "">(mediaKind !== "all" ? mediaKind : "");
  const [format, setFormat] = useState<MediaListQuery["format"]>();
  const [purposeIds, setPurposeIds] = useState<string[]>([]);
  const [schoolIds, setSchoolIds] = useState<string[]>([]);
  const [termIds, setTermIds] = useState<string[]>([]);
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [sort, setSort] = useState<MediaListQuery["sort"]>("recent");
  const [qInput, setQInput] = useState("");
  const [q, setQ] = useState("");
  const [siteScope, setSiteScope] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const [categorySheet, setCategorySheet] = useState(false);
  const [filterSheet, setFilterSheet] = useState(false);
  const [selectedSheet, setSelectedSheet] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [organizeOpen, setOrganizeOpen] = useState(false);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [batchDescription, setBatchDescription] = useState("");
  const [externalUrl, setExternalUrl] = useState("");
  const [newCategoryName, setNewCategoryName] = useState("");
  const [newCategoryParent, setNewCategoryParent] = useState("");
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const requestRef = useRef(0);
  const selectedRequestRef = useRef(0);

  function setSelected(next: string[] | ((prev: string[]) => string[])) {
    const resolved = typeof next === "function" ? next(selectedRef.current) : next;
    selectedRef.current = resolved;
    if (selectedIds === undefined) setInternalSelected(resolved);
    onSelectedIdsChange?.(resolved);
  }

  function remember(nextAssets: MediaAssetDto[]) {
    if (nextAssets.length === 0) return;
    setKnown((prev) => {
      const copy = { ...prev };
      for (const asset of nextAssets) copy[asset.id] = asset;
      return copy;
    });
    onSeen?.(nextAssets);
  }

  const filterKey = [
    view,
    categoryId || "",
    includeDescendants ? "1" : "0",
    kind,
    format || "",
    purposeIds.join(","),
    schoolIds.join(","),
    termIds.join(","),
    tagIds.join(","),
    q,
    sort,
    mediaKind,
    siteScope ? "all" : "own",
  ].join("|");
  const filterKeyRef = useRef(filterKey);

  useEffect(() => {
    const timer = window.setTimeout(() => setQ(qInput.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [qInput]);

  useEffect(() => {
    if (filterKeyRef.current === filterKey) return;
    filterKeyRef.current = filterKey;
    setPage(1);
  }, [filterKey]);

  async function loadCatalog() {
    const [categoryRes, vocabRes] = await Promise.all([
      fetch("/api/studio/media-categories"),
      fetch("/api/studio/media-vocabulary"),
    ]);
    const categoryData = await categoryRes.json().catch(() => ({}));
    const vocabData = await vocabRes.json().catch(() => ({}));
    if (categoryRes.ok) {
      setCategories(categoryData.categories || []);
      setSummary(categoryData.summary || { all: 0, uncategorized: 0 });
    }
    if (vocabRes.ok) setVocabulary(vocabData.items || []);
  }

  useEffect(() => {
    void loadCatalog();
  }, []);

  useEffect(() => {
    const token = ++requestRef.current;
    const query: MediaListQuery = {
      ids: [],
      view,
      categoryId,
      includeDescendants,
      type: kind || undefined,
      format,
      purposeIds,
      schoolIds,
      termIds,
      tagIds,
      q,
      sort: view === "recent" ? "recent" : sort,
      page,
      pageSize: MEDIA_PAGE_SIZE_DEFAULT,
    };
    const params = buildMediaListSearch(query);
    if (siteScope) params.set("scope", "all");
    setLoading(true);
    fetch(`/api/studio/media?${params.toString()}`)
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "加载素材失败");
        return data as { assets: MediaAssetDto[]; total: number; page: number };
      })
      .then((data) => {
        if (token !== requestRef.current) return;
        setAssets(data.assets || []);
        setTotal(data.total || 0);
        setPage(data.page || 1);
        remember(data.assets || []);
      })
      .catch((error: Error) => {
        if (token !== requestRef.current) return;
        setMessage(error.message || "加载失败");
      })
      .finally(() => {
        if (token === requestRef.current) setLoading(false);
      });
    // remember 只写入缓存，不作为重新请求的条件。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, page]);

  useEffect(() => {
    const missing = selected.filter((id) => !known[id]);
    if (missing.length === 0) return;
    const token = ++selectedRequestRef.current;
    const selectedParams = new URLSearchParams({ ids: missing.join(",") });
    if (siteScope) selectedParams.set("scope", "all");
    fetch(`/api/studio/media?${selectedParams.toString()}`)
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "加载已选素材失败");
        return (data.assets || []) as MediaAssetDto[];
      })
      .then((rows) => {
        if (token !== selectedRequestRef.current) return;
        remember(rows);
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected.join("|"), siteScope]);

  const pageIds = assets.map((asset) => asset.id);
  const pageAllSelected = pageIds.length > 0 && pageIds.every((id) => selected.includes(id));
  const activeCategory = categories.find((category) => category.id === categoryId);
  const uploadCategoryId = view === "category" ? categoryId || null : null;
  const nodes = useMemo(() => asNodes(categories), [categories]);

  function chooseView(next: MediaListQuery["view"], id?: string) {
    setView(next);
    setCategoryId(next === "category" ? id : undefined);
    setCategorySheet(false);
    if (next === "recent") setSort("recent");
  }

  function clearFilters() {
    setQInput("");
    setQ("");
    setKind(mediaKind !== "all" ? mediaKind : "");
    setFormat(undefined);
    setPurposeIds([]);
    setSchoolIds([]);
    setTermIds([]);
    setTagIds([]);
    setSort("recent");
    setIncludeDescendants(true);
    setFilterSheet(false);
  }

  function onAssetClick(asset: MediaAssetDto, event: React.MouseEvent) {
    if (mode === "single") {
      onPick?.(asset);
      return;
    }
    const ordered = pageIds;
    if (event.shiftKey && anchorId) {
      setSelected(rangeSelectIds(selectedRef.current, ordered, anchorId, asset.id, event.ctrlKey || event.metaKey));
    } else {
      setSelected(toggleSelectedId(selectedRef.current, asset.id));
      setAnchorId(asset.id);
    }
  }

  async function createCategory() {
    const name = newCategoryName.trim();
    if (!name) return;
    const res = await fetch("/api/studio/media-categories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, parentId: newCategoryParent || null }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setMessage(data.error || "创建分类失败");
      return;
    }
    setNewCategoryName("");
    await loadCatalog();
    if (data.category?.id) chooseView("category", data.category.id);
  }

  async function renameCategory(category: MediaCategoryDto) {
    const name = window.prompt("分类名称", category.name)?.trim();
    if (!name || name === category.name) return;
    const res = await fetch(`/api/studio/media-categories/${category.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setMessage(data.error || "重命名失败");
      return;
    }
    await loadCatalog();
  }

  async function moveCategory(category: MediaCategoryDto, parentId: string) {
    const res = await fetch(`/api/studio/media-categories/${category.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parentId: parentId || null }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) setMessage(data.error || "移动分类失败");
    await loadCatalog();
  }

  async function reorder(category: MediaCategoryDto, direction: "up" | "down") {
    const res = await fetch(`/api/studio/media-categories/${category.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ direction }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) setMessage(data.error || "调整顺序失败");
    await loadCatalog();
  }

  async function removeCategory(category: MediaCategoryDto) {
    const first = await fetch(`/api/studio/media-categories/${category.id}`, { method: "DELETE" });
    const data = await first.json().catch(() => ({}));
    if (first.ok) {
      if (categoryId === category.id) chooseView("all");
      await loadCatalog();
      setMessage("已删除空分类");
      return;
    }
    if (data.code === "CATEGORY_HAS_CHILDREN") {
      setMessage("请先移走子分类");
      return;
    }
    if (data.code !== "CATEGORY_NONEMPTY") {
      setMessage(data.error || "删除失败");
      return;
    }
    const destination = window.prompt(
      `「${category.name}」里有 ${data.assetCount} 个素材。输入 uncategorized 表示改为待整理，或粘贴目标分类 ID。取消则不删除。`,
      "uncategorized",
    );
    if (!destination) return;
    const second = await fetch(
      `/api/studio/media-categories/${category.id}?destination=${encodeURIComponent(destination.trim())}`,
      { method: "DELETE" },
    );
    const again = await second.json().catch(() => ({}));
    if (!second.ok) {
      setMessage(again.error || "删除失败");
      return;
    }
    if (categoryId === category.id) chooseView("all");
    await loadCatalog();
    setMessage(`已删除分类，${again.assetCount || 0} 个素材已保留`);
  }

  async function enableTemplate() {
    const previewRes = await fetch("/api/studio/media-categories/template", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: false }),
    });
    const preview = await previewRes.json().catch(() => ({}));
    if (!previewRes.ok) {
      setMessage(preview.error || "无法预览目录");
      return;
    }
    const creating = (preview.plan || []).filter(
      (item: { action: string }) => item.action === "create",
    );
    if (creating.length === 0) {
      setMessage("推荐目录都已经有了，没有移动现有素材");
      return;
    }
    const lines = creating
      .map((item: { parentName: string | null; name: string }) =>
        item.parentName ? `${item.parentName} / ${item.name}` : item.name,
      )
      .join("\n");
    if (!window.confirm(`将新建这些文件夹，不移动、不重命名现有素材：\n${lines}`)) return;
    const applyRes = await fetch("/api/studio/media-categories/template", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    });
    const applied = await applyRes.json().catch(() => ({}));
    if (!applyRes.ok) {
      setMessage(applied.error || "创建目录失败");
      return;
    }
    await loadCatalog();
    setMessage(`已新建 ${applied.created?.length || 0} 个文件夹`);
  }

  function patchQueue(patch: Parameters<typeof applyUploadBatch>[1]) {
    setQueue((prev) => {
      const result = applyUploadBatch(prev, patch);
      if (result.updatedKeys.length > 0) {
        setMessage(`已更新 ${result.updatedKeys.length} 个未单独改过的文件`);
      }
      return result.items as QueueItem[];
    });
  }

  function addFiles(files: File[]) {
    const items: QueueItem[] = files.map((file) => ({
      key: newId(),
      file,
      displayName: (file.name.replace(/\.[^.]+$/, "") || file.name).slice(0, 200),
      displayNameTouched: false,
      categoryId: uploadCategoryId,
      categoryTouched: false,
      purposeIds: [],
      purposesTouched: false,
      schoolIds: [],
      schoolsTouched: false,
      termIds: [],
      termsTouched: false,
      tagIds: [],
      tagsTouched: false,
      uploadSessionId: newId(),
      status: "queued",
      percent: 0,
    }));
    setQueue((prev) => [...prev, ...items]);
    setUploadOpen(true);
  }

  async function runQueue() {
    if (uploading) return;
    setUploading(true);
    for (const item of queueRef.current) {
      if (!item.file || (item.status !== "queued" && item.status !== "error")) continue;
      const current = queueRef.current.find((row) => row.key === item.key) || item;
      const snapshot = {
        file: current.file as File,
        name: current.displayName,
        description: batchDescription,
        categoryId: current.categoryId,
        uploadSessionId: current.uploadSessionId,
        purposeIds: current.purposeIds,
        schoolIds: current.schoolIds,
        termIds: current.termIds,
        tagIds: current.tagIds,
      };
      setQueue((prev) =>
        prev.map((row) => (row.key === item.key ? { ...row, status: "uploading", error: "" } : row)),
      );
      const result = await uploadMediaFile({
        ...snapshot,
        onProgress: (loaded, totalBytes) => {
          const percent = totalBytes > 0 ? Math.min(100, Math.round((loaded / totalBytes) * 100)) : 0;
          setQueue((prev) => prev.map((row) => (row.key === item.key ? { ...row, percent } : row)));
        },
      });
      setQueue((prev) =>
        prev.map((row) =>
          row.key === item.key
            ? {
                ...row,
                status: result.ok ? "done" : "error",
                error: result.error,
                asset: result.asset,
                percent: result.ok ? 100 : row.percent,
              }
            : row,
        ),
      );
      if (result.asset) remember([result.asset]);
    }
    setUploading(false);
    await loadCatalog();
    setPage(1);
    requestRef.current += 1;
    const query: MediaListQuery = {
      ids: [],
      view,
      categoryId,
      includeDescendants,
      type: kind || undefined,
      format,
      purposeIds,
      schoolIds,
      termIds,
      tagIds,
      q,
      sort: view === "recent" ? "recent" : sort,
      page: 1,
      pageSize: MEDIA_PAGE_SIZE_DEFAULT,
    };
    const refreshed = await fetch(`/api/studio/media?${buildMediaListSearch(query).toString()}`);
    const data = await refreshed.json().catch(() => ({}));
    if (refreshed.ok) {
      setAssets(data.assets || []);
      setTotal(data.total || 0);
      remember(data.assets || []);
    }
  }

  async function saveExternal() {
    const name = window.prompt("外链素材的显示名称")?.trim();
    if (!name || !externalUrl.trim()) return;
    const result = await saveExternalMedia({
      name,
      description: batchDescription,
      categoryId: uploadCategoryId,
      externalUrl: externalUrl.trim(),
      uploadSessionId: newId(),
      purposeIds: [],
      schoolIds: [],
      termIds: [],
      tagIds: [],
    });
    if (!result.ok || !result.asset) {
      setMessage(result.error || "外链保存失败");
      return;
    }
    remember([result.asset]);
    setExternalUrl("");
    setMessage("外链已入库。上传不会自动发布商品。");
    setPage(1);
  }

  async function removeSelectedAssets() {
    if (!canDelete || selected.length === 0) return;
    if (!window.confirm(`删除已选的 ${selected.length} 个素材？被课程引用的会保留，文件不会因为改分类而删除。`)) {
      return;
    }
    const res = await fetch("/api/studio/media", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: selected }),
    });
    const data = await res.json().catch(() => ({}));
    const deleted: string[] = data.deletedIds || [];
    setSelected((prev) => prev.filter((id) => !deleted.includes(id)));
    setMessage(
      data.error ||
        `已删除 ${deleted.length} 个${data.blocked?.length ? `，${data.blocked.length} 个因被课程使用未删除` : ""}`,
    );
    setPage(1);
    await loadCatalog();
  }

  const pages = Math.max(1, Math.ceil(total / MEDIA_PAGE_SIZE_DEFAULT));
  const showSelected = mode !== "single";

  return (
    <div className={`${fill ? "flex h-full min-h-0 flex-col" : "space-y-4"} ${showSelected ? "pb-28 lg:pb-0" : ""}`}>
      <div className="flex flex-wrap gap-2 lg:hidden">
        <button type="button" className={`${hit} border border-[var(--line)]`} onClick={() => setCategorySheet(true)}>
          分类
        </button>
        <button type="button" className={`${hit} border border-[var(--line)]`} onClick={() => setFilterSheet(true)}>
          筛选
        </button>
        {allowUpload ? (
          <button type="button" className={`${hit} border border-[var(--line)]`} onClick={() => setUploadOpen(true)}>
            上传到当前分类
          </button>
        ) : null}
      </div>

      <div className={fill ? "grid min-h-0 flex-1 gap-4 lg:grid-cols-[220px_minmax(0,1fr)_280px]" : "grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)_280px]"}>
        <CategoryPanel
          open={categorySheet}
          categories={categories}
          nodes={nodes}
          summary={summary}
          view={view}
          categoryId={categoryId}
          includeDescendants={includeDescendants}
          newCategoryName={newCategoryName}
          newCategoryParent={newCategoryParent}
          canDelete={canDelete}
          onClose={() => setCategorySheet(false)}
          onChoose={chooseView}
          onIncludeDescendants={setIncludeDescendants}
          onName={setNewCategoryName}
          onParent={setNewCategoryParent}
          onCreate={() => void createCategory()}
          onRename={(category) => void renameCategory(category)}
          onMove={(category, parentId) => void moveCategory(category, parentId)}
          onReorder={(category, direction) => void reorder(category, direction)}
          onDelete={(category) => void removeCategory(category)}
          onTemplate={() => void enableTemplate()}
        />

        <section className="min-w-0 space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              className="field min-h-11 flex-1"
              value={qInput}
              onChange={(event) => setQInput(event.target.value)}
              placeholder="搜索名称、原文件名、备注、标签"
              aria-label="搜索素材"
            />
            <button type="button" className={`${hit} border border-[var(--line)]`} onClick={clearFilters}>
              清除筛选
            </button>
          </div>
          {allowSiteScope ? (
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-5 w-5"
                checked={siteScope}
                onChange={(event) => setSiteScope(event.target.checked)}
              />
              全站素材（含老师上传的视频、讲义和图片）
            </label>
          ) : null}
          <FilterBar
            open={filterSheet}
            kind={kind}
            format={format}
            sort={sort}
            lockKind={mediaKind !== "all"}
            vocabulary={vocabulary}
            purposeIds={purposeIds}
            schoolIds={schoolIds}
            termIds={termIds}
            tagIds={tagIds}
            onClose={() => setFilterSheet(false)}
            onKind={setKind}
            onFormat={setFormat}
            onSort={setSort}
            onPurpose={setPurposeIds}
            onSchool={setSchoolIds}
            onTerm={setTermIds}
            onTag={setTagIds}
            onVocabulary={() => void loadCatalog()}
          />
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <button
              type="button"
              className={`${hit} border border-[var(--line)]`}
              onClick={() =>
                setSelected(
                  pageAllSelected
                    ? unselectPageIds(selectedRef.current, pageIds)
                    : selectPageIds(selectedRef.current, pageIds),
                )
              }
              disabled={mode === "single" || pageIds.length === 0}
            >
              {pageAllSelected ? `取消本页 ${pageIds.length} 项` : `选中本页 ${pageIds.length} 项`}
            </button>
            <span className="text-[var(--muted)]">
              共 {total} 项 · 第 {page}/{pages} 页
              {view === "category" && includeDescendants ? " · 含子分类" : ""}
            </span>
            {allowUpload ? (
              <button type="button" className={`${hit} hidden border border-[var(--line)] lg:inline-flex`} onClick={() => setUploadOpen(true)}>
                上传到{activeCategory ? activeCategory.path : UNCATEGORIZED_LABEL}
              </button>
            ) : null}
          </div>
          <details className="text-sm text-[var(--muted)]">
            <summary className={`${hit} cursor-pointer`}>选择帮助</summary>
            <p className="px-1 pb-2">
              点勾选就能选中或取消。Shift 可按范围追加，Ctrl 同样是加减。上移、下移不依赖拖拽。预览和展开名称不会改变勾选。
            </p>
          </details>
          <div className={fill ? "min-h-0 flex-1 space-y-2 overflow-y-auto pr-1" : "space-y-2"}>
            {loading ? <p className="py-8 text-center text-sm text-[var(--muted)]">加载中…</p> : null}
            {!loading && assets.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-[var(--line)] px-4 py-8 text-center text-sm text-[var(--muted)]">
                没有符合条件的素材
              </p>
            ) : null}
            {assets.map((asset) => {
              const checked = selected.includes(asset.id);
              const media = isMediaKind(asset.type) ? asset.type : "OTHER";
              return (
                <div
                  key={asset.id}
                  className={`flex items-start gap-2 rounded-2xl border px-3 py-2 ${
                    checked ? "border-[var(--brand)] bg-[var(--brand-soft)]" : "border-[var(--line)]"
                  }`}
                >
                  {mode === "single" ? (
                    <button type="button" className={`${hit} shrink-0`} onClick={() => onPick?.(asset)}>
                      选择
                    </button>
                  ) : (
                    <label className={`${hit} shrink-0`}>
                      <input
                        type="checkbox"
                        className="h-5 w-5"
                        checked={checked}
                        onChange={() => undefined}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          onAssetClick(asset, event);
                        }}
                        aria-label={`选择 ${asset.name}`}
                      />
                    </label>
                  )}
                  <div className="min-w-0 flex-1">
                    <button
                      type="button"
                      className="block max-w-full break-words text-left font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--brand)]"
                      onClick={() => setExpanded((prev) => ({ ...prev, [asset.id]: !prev[asset.id] }))}
                    >
                      <span className={expanded[asset.id] ? "" : "line-clamp-2"}>{asset.name}</span>
                    </button>
                    <p className="mt-1 text-xs text-[var(--muted)]">
                      {asset.category?.path || UNCATEGORIZED_LABEL}
                      {` · ${MEDIA_KIND_LABEL[media]}`}
                      {asset.format ? ` · ${MEDIA_FORMAT_LABEL[asset.format as keyof typeof MEDIA_FORMAT_LABEL] || asset.format}` : ""}
                      {asset.purposes.length > 0 ? ` · ${asset.purposes.map((item) => item.name).join("、")}` : ""}
                      {` · ${formatBytes(asset.sizeBytes || 0)}`}
                      {asset.durationSec ? ` · ${formatDuration(asset.durationSec)}` : ""}
                    </p>
                  </div>
                  {mode === "manage" ? (
                    <a
                      className={`${hit} shrink-0 border border-[var(--line)]`}
                      href={`/api/studio/media/${asset.id}/original`}
                      onClick={(event) => event.stopPropagation()}
                    >
                      下载原件
                    </a>
                  ) : null}
                  <a
                    className={`${hit} shrink-0 border border-[var(--line)]`}
                    href={`/api/studio/media/${asset.id}/play`}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(event) => event.stopPropagation()}
                  >
                    预览
                  </a>
                </div>
              );
            })}
          </div>
          <div className="flex gap-2">
            <button type="button" className={`${hit} border border-[var(--line)]`} disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>
              上一页
            </button>
            <button type="button" className={`${hit} border border-[var(--line)]`} disabled={page >= pages} onClick={() => setPage((value) => value + 1)}>
              下一页
            </button>
          </div>
          {message ? <p className="text-sm text-[var(--muted)]">{message}</p> : null}
        </section>

        {showSelected ? (
          <SelectedPanel
            open={selectedSheet}
            selected={selected}
            known={known}
            onClose={() => setSelectedSheet(false)}
            onMove={(id, direction) => setSelected(moveSelectedId(selectedRef.current, id, direction))}
            onRemove={(id) => setSelected(toggleSelectedId(selectedRef.current, id))}
            onClear={() => {
              if (selected.length === 0) return;
              if (window.confirm(`清空已选的 ${selected.length} 项？素材本身不会删除。`)) setSelected([]);
            }}
          />
        ) : (
          <div className="hidden lg:block" />
        )}
      </div>

      {allowUpload && uploadOpen ? (
        <UploadPanel
          categories={categories}
          queue={queue}
          uploading={uploading}
          description={batchDescription}
          externalUrl={externalUrl}
          targetLabel={activeCategory && view === "category" ? activeCategory.path : UNCATEGORIZED_LABEL}
          vocabulary={vocabulary}
          onVocabulary={() => void loadCatalog()}
          onDescription={setBatchDescription}
          onExternalUrl={setExternalUrl}
          onAddFiles={addFiles}
          onPatch={patchQueue}
          onQueue={setQueue}
          onStart={() => void runQueue()}
          onExternal={() => void saveExternal()}
          onClose={() => setUploadOpen(false)}
          onUse={(asset) => {
            if (mode === "single") onPick?.(asset);
            else setSelected(selectPageIds(selectedRef.current, [asset.id]));
          }}
        />
      ) : null}

      {allowOrganize && organizeOpen ? (
        <OrganizePanel
          categories={categories}
          vocabulary={vocabulary}
          count={selected.length}
          assetIds={selected}
          onVocabulary={() => void loadCatalog()}
          onClose={() => setOrganizeOpen(false)}
          onDone={(text) => {
            setMessage(text);
            setOrganizeOpen(false);
            setPage(1);
            void loadCatalog();
          }}
        />
      ) : null}

      {showSelected ? (
        <div className="fixed inset-x-0 bottom-0 z-30 flex flex-wrap items-center gap-2 border-t border-[var(--line)] bg-[var(--bg)] px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] lg:static lg:z-auto lg:border-0 lg:bg-transparent lg:px-0">
          <button type="button" className={`${hit} border border-[var(--line)] lg:hidden`} onClick={() => setSelectedSheet(true)}>
            已选 {selected.length} 项 / 查看已选
          </button>
          <span className="hidden text-sm lg:inline">已选 {selected.length} 项</span>
          {mode === "multi" && onConfirm ? (
            <button type="button" className="btn btn-accent min-h-11" disabled={selected.length === 0} onClick={() => onConfirm(selected)}>
              {confirmLabel}
            </button>
          ) : null}
          {mode === "manage" && allowOrganize ? (
            <button type="button" className="btn btn-secondary min-h-11" disabled={selected.length === 0} onClick={() => setOrganizeOpen(true)}>
              整理已选
            </button>
          ) : null}
          {mode === "manage" && canDelete ? (
            <button type="button" className="btn btn-secondary min-h-11" disabled={selected.length === 0} onClick={() => void removeSelectedAssets()}>
              删除已选
            </button>
          ) : null}
          {mode === "manage" && canCreateSellable && onCompose ? (
            <button type="button" className="btn btn-accent min-h-11" disabled={selected.length === 0} onClick={() => onCompose(selected)}>
              用已选创建课程/资料
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function CategoryPanel(props: {
  open: boolean;
  categories: MediaCategoryDto[];
  nodes: CategoryNode[];
  summary: { all: number; uncategorized: number };
  view: MediaListQuery["view"];
  categoryId?: string;
  includeDescendants: boolean;
  newCategoryName: string;
  newCategoryParent: string;
  canDelete: boolean;
  onClose: () => void;
  onChoose: (view: MediaListQuery["view"], id?: string) => void;
  onIncludeDescendants: (value: boolean) => void;
  onName: (value: string) => void;
  onParent: (value: string) => void;
  onCreate: () => void;
  onRename: (category: MediaCategoryDto) => void;
  onMove: (category: MediaCategoryDto, parentId: string) => void;
  onReorder: (category: MediaCategoryDto, direction: "up" | "down") => void;
  onDelete: (category: MediaCategoryDto) => void;
  onTemplate: () => void;
}) {
  const roots = sortCategorySiblings(props.nodes.filter((node) => !node.parentId));
  return (
    <aside className={`${props.open ? "fixed inset-0 z-40 overflow-y-auto bg-[var(--bg)] p-4" : "hidden"} lg:static lg:block lg:overflow-visible lg:bg-transparent lg:p-0`}>
      <div className="mb-3 flex items-center justify-between lg:hidden">
        <h2 className="font-semibold">分类</h2>
        <button type="button" className={hit} onClick={props.onClose}>关闭</button>
      </div>
      <div className="space-y-1">
        <ViewButton active={props.view === "all"} onClick={() => props.onChoose("all")}>
          全部素材 ({props.summary.all})
        </ViewButton>
        <ViewButton active={props.view === "recent"} onClick={() => props.onChoose("recent")}>
          最近上传
        </ViewButton>
        <ViewButton active={props.view === "uncategorized"} onClick={() => props.onChoose("uncategorized")}>
          {UNCATEGORIZED_LABEL} ({props.summary.uncategorized})
        </ViewButton>
        <CategoryBranch
          nodes={roots}
          categories={props.categories}
          all={props.nodes}
          activeId={props.view === "category" ? props.categoryId : undefined}
          canDelete={props.canDelete}
          onChoose={(id) => props.onChoose("category", id)}
          onRename={props.onRename}
          onMove={props.onMove}
          onReorder={props.onReorder}
          onDelete={props.onDelete}
        />
      </div>
      {props.view === "category" ? (
        <label className="mt-3 flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" checked={props.includeDescendants} onChange={(event) => props.onIncludeDescendants(event.target.checked)} />
          包含子分类
        </label>
      ) : null}
      <div className="mt-4 space-y-2">
        <input className="field min-h-11" value={props.newCategoryName} onChange={(event) => props.onName(event.target.value)} placeholder="新分类名称" />
        <select className="field min-h-11" value={props.newCategoryParent} onChange={(event) => props.onParent(event.target.value)} aria-label="父分类">
          <option value="">根目录</option>
          {props.categories.map((category) => (
            <option key={category.id} value={category.id}>{category.path}</option>
          ))}
        </select>
        <button type="button" className="btn btn-secondary min-h-11 w-full" onClick={props.onCreate}>新建分类</button>
        <button type="button" className="btn btn-secondary min-h-11 w-full" onClick={props.onTemplate}>查看推荐目录</button>
      </div>
    </aside>
  );
}

function ViewButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" className={`${hit} w-full justify-start ${active ? "bg-[var(--brand)] text-white" : "border border-[var(--line)]"}`} onClick={onClick}>
      {children}
    </button>
  );
}

function CategoryBranch(props: {
  nodes: CategoryNode[];
  categories: MediaCategoryDto[];
  all: CategoryNode[];
  activeId?: string;
  canDelete: boolean;
  onChoose: (id: string) => void;
  onRename: (category: MediaCategoryDto) => void;
  onMove: (category: MediaCategoryDto, parentId: string) => void;
  onReorder: (category: MediaCategoryDto, direction: "up" | "down") => void;
  onDelete: (category: MediaCategoryDto) => void;
}) {
  return (
    <ul className="space-y-1">
      {props.nodes.map((node) => {
        const category = props.categories.find((item) => item.id === node.id);
        if (!category) return null;
        const children = sortCategorySiblings(props.all.filter((item) => item.parentId === node.id));
        return (
          <li key={node.id}>
            <div className="flex items-center gap-1">
              <button
                type="button"
                className={`${hit} min-w-0 flex-1 justify-start ${props.activeId === node.id ? "bg-[var(--brand)] text-white" : "border border-[var(--line)]"}`}
                onClick={() => props.onChoose(node.id)}
              >
                <span className="truncate">{category.name}</span>
                <span className="ml-1 text-xs opacity-80">{category.treeCount}</span>
              </button>
              <details>
                <summary className={`${hit} cursor-pointer border border-[var(--line)]`} aria-label={`调整 ${category.name}`}>⋯</summary>
                <div className="mt-1 space-y-1 rounded-xl border border-[var(--line)] p-2">
                  <button type="button" className="btn btn-secondary min-h-11 w-full" onClick={() => props.onRename(category)}>改名</button>
                  <button type="button" className="btn btn-secondary min-h-11 w-full" onClick={() => props.onReorder(category, "up")}>上移</button>
                  <button type="button" className="btn btn-secondary min-h-11 w-full" onClick={() => props.onReorder(category, "down")}>下移</button>
                  <select className="field min-h-11" defaultValue={category.parentId || ""} aria-label={`移动 ${category.name}`} onChange={(event) => props.onMove(category, event.target.value)}>
                    <option value="">移到根目录</option>
                    {props.categories.filter((item) => item.id !== category.id).map((item) => (
                      <option key={item.id} value={item.id}>{item.path}</option>
                    ))}
                  </select>
                  {props.canDelete ? (
                    <button type="button" className="btn btn-secondary min-h-11 w-full" onClick={() => props.onDelete(category)}>删除</button>
                  ) : null}
                </div>
              </details>
            </div>
            {children.length > 0 ? (
              <div className="ml-3 border-l border-[var(--line)] pl-2">
                <CategoryBranch {...props} nodes={children} />
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function FilterBar(props: {
  open: boolean;
  kind: MediaKind | "";
  format?: MediaListQuery["format"];
  sort: MediaListQuery["sort"];
  lockKind: boolean;
  vocabulary: MediaVocabularyDto[];
  purposeIds: string[];
  schoolIds: string[];
  termIds: string[];
  tagIds: string[];
  onClose: () => void;
  onKind: (value: MediaKind | "") => void;
  onFormat: (value: MediaListQuery["format"] | undefined) => void;
  onSort: (value: MediaListQuery["sort"]) => void;
  onPurpose: (ids: string[]) => void;
  onSchool: (ids: string[]) => void;
  onTerm: (ids: string[]) => void;
          onTag: (ids: string[]) => void;
  onVocabulary: () => void;
}) {
  const panel = (
    <div className="grid gap-2 sm:grid-cols-2">
      <select className="field min-h-11" value={props.kind} disabled={props.lockKind} aria-label="文件类型" onChange={(event) => props.onKind(event.target.value as MediaKind | "")}>
        <option value="">全部类型</option>
        {MEDIA_KINDS.map((item) => (
          <option key={item} value={item}>{MEDIA_KIND_LABEL[item]}</option>
        ))}
      </select>
      <select className="field min-h-11" value={props.format || ""} aria-label="格式" onChange={(event) => props.onFormat((event.target.value || undefined) as MediaListQuery["format"] | undefined)}>
        <option value="">全部格式</option>
        {MEDIA_FORMATS.map((item) => (
          <option key={item} value={item}>{MEDIA_FORMAT_LABEL[item]}</option>
        ))}
      </select>
      <select className="field min-h-11" value={props.sort} aria-label="排序" onChange={(event) => props.onSort(event.target.value === "name" ? "name" : "recent")}>
        <option value="recent">最近上传</option>
        <option value="name">名称</option>
      </select>
      <VocabSelect label="用途" kind="PURPOSE" items={props.vocabulary} selected={props.purposeIds} onChange={props.onPurpose} />
      <VocabSelect label="学校" kind="SCHOOL" items={props.vocabulary} selected={props.schoolIds} onChange={props.onSchool} />
      <VocabSelect label="学期" kind="TERM" items={props.vocabulary} selected={props.termIds} onChange={props.onTerm} />
      <VocabSelect label="标签" kind="TAG" items={props.vocabulary} selected={props.tagIds} onChange={props.onTag} />
      <VocabularyCreator onCreated={props.onVocabulary} />
    </div>
  );
  return (
    <>
      <div className="hidden lg:block">{panel}</div>
      {props.open ? (
        <div className="fixed inset-0 z-40 overflow-y-auto bg-[var(--bg)] p-4 lg:hidden">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-semibold">筛选</h2>
            <button type="button" className={hit} onClick={props.onClose}>关闭</button>
          </div>
          {panel}
        </div>
      ) : null}
    </>
  );
}

function VocabSelect(props: {
  label: string;
  kind: MediaVocabularyDto["kind"];
  items: MediaVocabularyDto[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const options = props.items.filter((item) => item.kind === props.kind);
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-[var(--muted)]">{props.label}（可多选，满足其一即可）</span>
      <select
        multiple
        className="field min-h-24 w-full"
        value={props.selected}
        aria-label={props.label}
        onChange={(event) =>
          props.onChange(Array.from(event.target.selectedOptions).map((option) => option.value))
        }
      >
        {options.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
            {item.isGeneral ? "（通用）" : ""}
          </option>
        ))}
      </select>
    </label>
  );
}

function SelectedPanel(props: {
  open: boolean;
  selected: string[];
  known: Record<string, MediaAssetDto>;
  onClose: () => void;
  onMove: (id: string, direction: -1 | 1) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
}) {
  const body = (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">已选 {props.selected.length} 项</h2>
        <button type="button" className="btn btn-secondary min-h-11" onClick={props.onClear}>清空已选</button>
      </div>
      <p className="text-xs text-[var(--muted)]">这里保留不符合当前筛选的已选项。清空已选不会清除筛选，也不会删除素材。</p>
      <ol className="max-h-[50vh] space-y-2 overflow-y-auto lg:max-h-[calc(100vh-12rem)]">
        {props.selected.map((id, index) => {
          const asset = props.known[id];
          return (
            <li key={id} className="rounded-xl border border-[var(--line)] p-2 text-sm">
              <p className="break-words font-medium">{index + 1}. {asset?.name || "素材已失效"}</p>
              <p className="text-xs text-[var(--muted)]">{asset?.category?.path || (asset ? UNCATEGORIZED_LABEL : id)}</p>
              <div className="mt-1 flex flex-wrap gap-1">
                <button type="button" className={`${hit} border border-[var(--line)]`} onClick={() => props.onMove(id, -1)}>上移</button>
                <button type="button" className={`${hit} border border-[var(--line)]`} onClick={() => props.onMove(id, 1)}>下移</button>
                <button type="button" className={`${hit} border border-[var(--line)]`} onClick={() => props.onRemove(id)}>移除</button>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
  return (
    <>
      <aside className="hidden lg:block">{body}</aside>
      {props.open ? (
        <div className="fixed inset-0 z-40 overflow-y-auto bg-[var(--bg)] p-4 lg:hidden">
          <button type="button" className={`${hit} mb-3 border border-[var(--line)]`} onClick={props.onClose}>关闭</button>
          {body}
        </div>
      ) : null}
    </>
  );
}

function UploadPanel(props: {
  categories: MediaCategoryDto[];
  queue: QueueItem[];
  uploading: boolean;
  description: string;
  externalUrl: string;
  targetLabel: string;
  vocabulary: MediaVocabularyDto[];
  onVocabulary: () => void;
  onDescription: (value: string) => void;
  onExternalUrl: (value: string) => void;
  onAddFiles: (files: File[]) => void;
  onPatch: (patch: {
    categoryId?: string | null;
    purposeIds?: string[];
    schoolIds?: string[];
    termIds?: string[];
    tagIds?: string[];
  }) => void;
  onQueue: (items: QueueItem[]) => void;
  onStart: () => void;
  onExternal: () => void;
  onClose: () => void;
  onUse: (asset: MediaAssetDto) => void;
}) {
  return (
    <section className="space-y-3 rounded-[28px] border border-[var(--line)] p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold">上传到 {props.targetLabel}</h2>
        <button type="button" className={hit} onClick={props.onClose}>收起</button>
      </div>
      <p className="text-xs text-[var(--muted)]">
        从「全部素材」或「最近上传」进入时，默认归到待整理。改批次分类不会覆盖你已经单独改过的文件，也不会改正在上传的文件。
      </p>
      <label className="block text-sm">
        本批次分类
        <select
          className="field mt-1 min-h-11"
          defaultValue=""
          onChange={(event) => props.onPatch({ categoryId: event.target.value || null })}
        >
          <option value="">{UNCATEGORIZED_LABEL}</option>
          {props.categories.map((category) => (
            <option key={category.id} value={category.id}>{category.path}</option>
          ))}
        </select>
      </label>
      <textarea className="field min-h-20" value={props.description} onChange={(event) => props.onDescription(event.target.value)} placeholder="本批次备注，可留空" />
      <BatchVocab label="本批次用途" kind="PURPOSE" items={props.vocabulary} onChange={(ids) => props.onPatch({ purposeIds: ids })} />
      <BatchVocab label="本批次学校" kind="SCHOOL" items={props.vocabulary} onChange={(ids) => props.onPatch({ schoolIds: ids })} />
      <BatchVocab label="本批次学期" kind="TERM" items={props.vocabulary} onChange={(ids) => props.onPatch({ termIds: ids })} />
      <BatchVocab label="本批次标签" kind="TAG" items={props.vocabulary} onChange={(ids) => props.onPatch({ tagIds: ids })} />
      <VocabularyCreator onCreated={props.onVocabulary} />
      <input className="field min-h-11" type="file" multiple accept={MEDIA_UPLOAD_ACCEPT} onChange={(event) => props.onAddFiles(Array.from(event.target.files || []))} />
      <ul className="space-y-2">
        {props.queue.map((item) => (
          <li key={item.key} className="rounded-xl border border-[var(--line)] p-2 text-sm">
            <p className="break-words">{item.file?.name || item.displayName} · {item.status === "uploading" ? `${item.percent}%` : item.status === "done" ? "已入库" : item.status === "error" ? item.error || "失败" : "等待"}</p>
            <input
              className="field mt-1 min-h-11"
              value={item.displayName}
              aria-label="显示名称"
              onChange={(event) =>
                props.onQueue(
                  props.queue.map((row) =>
                    row.key === item.key
                      ? { ...row, displayName: event.target.value, displayNameTouched: true }
                      : row,
                  ),
                )
              }
            />
            <select
              className="field mt-1 min-h-11"
              value={item.categoryId || ""}
              aria-label="这个文件的分类"
              onChange={(event) =>
                props.onQueue(
                  props.queue.map((row) =>
                    row.key === item.key
                      ? { ...row, categoryId: event.target.value || null, categoryTouched: true }
                      : row,
                  ),
                )
              }
            >
              <option value="">{UNCATEGORIZED_LABEL}</option>
              {props.categories.map((category) => (
                <option key={category.id} value={category.id}>{category.path}</option>
              ))}
            </select>
            <select
              multiple
              className="field mt-1 min-h-20 w-full"
              aria-label="这个文件的用途"
              value={item.purposeIds}
              onChange={(event) => {
                const ids = Array.from(event.target.selectedOptions).map((option) => option.value);
                props.onQueue(
                  props.queue.map((row) =>
                    row.key === item.key ? { ...row, purposeIds: ids, purposesTouched: true } : row,
                  ),
                );
              }}
            >
              {props.vocabulary.filter((option) => option.kind === "PURPOSE").map((option) => (
                <option key={option.id} value={option.id}>{option.name}</option>
              ))}
            </select>
            {item.asset && item.status === "done" ? (
              <button type="button" className="btn btn-secondary mt-1 min-h-11" onClick={() => props.onUse(item.asset as MediaAssetDto)}>
                加入本次选择
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      <button type="button" className="btn btn-primary min-h-11" disabled={props.uploading || props.queue.length === 0} onClick={props.onStart}>
        {props.uploading ? "上传中…" : "开始上传"}
      </button>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input className="field min-h-11 flex-1" value={props.externalUrl} onChange={(event) => props.onExternalUrl(event.target.value)} placeholder="或保存一个 http/https 外链" />
        <button type="button" className="btn btn-secondary min-h-11" onClick={props.onExternal}>保存外链</button>
      </div>
    </section>
  );
}

function OrganizePanel(props: {
  categories: MediaCategoryDto[];
  vocabulary: MediaVocabularyDto[];
  count: number;
  assetIds: string[];
  onVocabulary: () => void;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [categoryMode, setCategoryMode] = useState<"keep" | "set" | "clear">("keep");
  const [categoryId, setCategoryId] = useState("");
  const [purposeMode, setPurposeMode] = useState<IdFieldChange["mode"]>("keep");
  const [purposeIds, setPurposeIds] = useState<string[]>([]);
  const [schoolMode, setSchoolMode] = useState<IdFieldChange["mode"]>("keep");
  const [schoolIds, setSchoolIds] = useState<string[]>([]);
  const [termMode, setTermMode] = useState<IdFieldChange["mode"]>("keep");
  const [termIds, setTermIds] = useState<string[]>([]);
  const [tagMode, setTagMode] = useState<IdFieldChange["mode"]>("keep");
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [logId, setLogId] = useState("");

  function idChange(mode: IdFieldChange["mode"], ids: string[]): IdFieldChange {
    if (mode === "keep" || mode === "clear") return { mode };
    return { mode, ids };
  }

  async function submit() {
    const request: OrganizeRequest = {
      assetIds: props.assetIds,
      category:
        categoryMode === "set"
          ? { mode: "set", categoryId }
          : categoryMode === "clear"
            ? { mode: "clear" }
            : { mode: "keep" },
      purposes: idChange(purposeMode, purposeIds),
      schools: idChange(schoolMode, schoolIds),
      terms: idChange(termMode, termIds),
      tags: idChange(tagMode, tagIds),
    };
    const labels = organizeFieldLabels(request);
    if (labels.length === 0) {
      props.onDone("没有要修改的字段");
      return;
    }
    if (!window.confirm(`将修改 ${props.count} 个素材的${labels.join("、")}。这只改分类和属性，不改文件，也不改已上架课程的章节。`)) {
      return;
    }
    setBusy(true);
    const res = await fetch("/api/studio/media/organize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      props.onDone(data.error || "整理失败");
      return;
    }
    setLogId(data.logId || "");
    const failed = (data.failed || []).length;
    props.onDone(`已更新 ${data.updated || 0} 个${failed ? `，失败 ${failed} 个` : ""}。可撤销这次整理。`);
  }

  async function undo() {
    if (!logId) return;
    const res = await fetch("/api/studio/media/organize/undo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ logId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      props.onDone(data.error || "撤销失败");
      return;
    }
    const conflictCount = (data.conflicts || []).length;
    props.onDone(`已恢复 ${data.restored || 0} 处${conflictCount ? `，${conflictCount} 处因为之后又改过而未覆盖` : ""}`);
  }

  return (
    <section className="space-y-3 rounded-[28px] border border-[var(--line)] p-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">整理 {props.count} 个素材</h2>
        <button type="button" className={hit} onClick={props.onClose}>关闭</button>
      </div>
      <p className="text-xs text-[var(--muted)]">空着的字段保持「不修改」，不会把其他素材的原有内容清掉。</p>
      <ModeSelect label="分类" value={categoryMode} options={["keep", "set", "clear"]} onChange={setCategoryMode} />
      {categoryMode === "set" ? (
        <select className="field min-h-11" value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
          <option value="">请选择分类</option>
          {props.categories.map((category) => (
            <option key={category.id} value={category.id}>{category.path}</option>
          ))}
        </select>
      ) : null}
      <IdMode label="用途" kind="PURPOSE" mode={purposeMode} ids={purposeIds} items={props.vocabulary} onMode={setPurposeMode} onIds={setPurposeIds} />
      <IdMode label="学校" kind="SCHOOL" mode={schoolMode} ids={schoolIds} items={props.vocabulary} onMode={setSchoolMode} onIds={setSchoolIds} />
      <IdMode label="学期" kind="TERM" mode={termMode} ids={termIds} items={props.vocabulary} onMode={setTermMode} onIds={setTermIds} />
      <IdMode label="标签" kind="TAG" mode={tagMode} ids={tagIds} items={props.vocabulary} onMode={setTagMode} onIds={setTagIds} allowAddRemove />
      <VocabularyCreator onCreated={props.onVocabulary} />
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-primary min-h-11" disabled={busy || props.count === 0} onClick={() => void submit()}>
          提交整理
        </button>
        {logId ? (
          <button type="button" className="btn btn-secondary min-h-11" onClick={() => void undo()}>撤销这次整理</button>
        ) : null}
      </div>
    </section>
  );
}

function ModeSelect<T extends string>(props: {
  label: string;
  value: T;
  options: T[];
  onChange: (value: T) => void;
}) {
  const text: Record<string, string> = {
    keep: "不修改",
    set: "设置为",
    clear: "清空",
    add: "增加",
    remove: "移除",
  };
  return (
    <label className="block text-sm">
      {props.label}
      <select className="field mt-1 min-h-11" value={props.value} onChange={(event) => props.onChange(event.target.value as T)}>
        {props.options.map((option) => (
          <option key={option} value={option}>{text[option] || option}</option>
        ))}
      </select>
    </label>
  );
}

function IdMode(props: {
  label: string;
  kind: MediaVocabularyDto["kind"];
  mode: IdFieldChange["mode"];
  ids: string[];
  items: MediaVocabularyDto[];
  allowAddRemove?: boolean;
  onMode: (mode: IdFieldChange["mode"]) => void;
  onIds: (ids: string[]) => void;
}) {
  const options = props.allowAddRemove
    ? (["keep", "set", "add", "remove", "clear"] as IdFieldChange["mode"][])
    : (["keep", "set", "clear"] as IdFieldChange["mode"][]);
  return (
    <div>
      <ModeSelect label={props.label} value={props.mode} options={options} onChange={props.onMode} />
      {props.mode !== "keep" && props.mode !== "clear" ? (
        <select
          multiple
          className="field mt-1 min-h-24 w-full"
          value={props.ids}
          onChange={(event) => props.onIds(Array.from(event.target.selectedOptions).map((option) => option.value))}
        >
          {props.items.filter((item) => item.kind === props.kind).map((item) => (
            <option key={item.id} value={item.id}>{item.name}</option>
          ))}
        </select>
      ) : null}
    </div>
  );
}

function BatchVocab(props: {
  label: string;
  kind: MediaVocabularyDto["kind"];
  items: MediaVocabularyDto[];
  onChange: (ids: string[]) => void;
}) {
  return (
    <label className="block text-sm">
      {props.label}
      <select
        multiple
        className="field mt-1 min-h-24 w-full"
        aria-label={props.label}
        onChange={(event) =>
          props.onChange(Array.from(event.target.selectedOptions).map((option) => option.value))
        }
      >
        {props.items.filter((item) => item.kind === props.kind).map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
            {item.isGeneral ? "（通用）" : ""}
          </option>
        ))}
      </select>
    </label>
  );
}

function VocabularyCreator({ onCreated }: { onCreated: () => void }) {
  const [kind, setKind] = useState<MediaVocabularyDto["kind"]>("TAG");
  const [name, setName] = useState("");
  const [isGeneral, setIsGeneral] = useState(false);
  const [error, setError] = useState("");

  async function create() {
    const trimmed = name.trim();
    if (!trimmed) return;
    const res = await fetch("/api/studio/media-vocabulary", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind,
        name: trimmed,
        isGeneral: kind === "SCHOOL" && isGeneral,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.error || "添加失败");
      return;
    }
    setName("");
    setError("");
    onCreated();
  }

  return (
    <div className="space-y-2 rounded-xl border border-dashed border-[var(--line)] p-3">
      <p className="text-sm font-medium">新建用途、学校、学期或标签</p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <select
          className="field min-h-11 sm:w-32"
          value={kind}
          aria-label="选项类型"
          onChange={(event) => setKind(event.target.value as MediaVocabularyDto["kind"])}
        >
          <option value="PURPOSE">用途</option>
          <option value="SCHOOL">学校</option>
          <option value="TERM">学期</option>
          <option value="TAG">标签</option>
        </select>
        <input className="field min-h-11 flex-1" value={name} onChange={(event) => setName(event.target.value)} placeholder="名称" />
        <button type="button" className="btn btn-secondary min-h-11" onClick={() => void create()}>添加</button>
      </div>
      {kind === "SCHOOL" ? (
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" checked={isGeneral} onChange={(event) => setIsGeneral(event.target.checked)} />
          这是明确的「通用」，不是留空
        </label>
      ) : null}
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
    </div>
  );
}
