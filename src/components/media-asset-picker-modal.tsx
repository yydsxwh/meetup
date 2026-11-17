"use client";

import { useEffect } from "react";
import type { MediaKind } from "@andyyyds/shared/media";
import type { MediaAssetDto } from "@andyyyds/shared/media-library";
import { MediaLibraryBrowser } from "@/components/media-library-browser";

export type PickerMediaAsset = {
  id: string;
  name: string;
  fileUrl: string;
  durationSec: number;
  type?: string;
  categoryId?: string | null;
  category?: { id: string; name: string; path?: string } | null;
  fileName?: string;
  description?: string;
};

type Props = {
  open: boolean;
  selectedId?: string | null;
  initialAssets?: PickerMediaAsset[];
  onClose: () => void;
  onSelect: (asset: PickerMediaAsset) => void;
  onClear?: () => void;
  mediaKind?: MediaKind | "all";
  title?: string;
  description?: string;
};

export function MediaAssetPickerModal({
  open,
  selectedId,
  onClose,
  onSelect,
  onClear,
  mediaKind = "all",
  title = "从素材中心选择",
  description = "选择一个素材。关闭选择器不会删除刚刚上传的文件。",
}: Props) {
  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="media-picker-title"
    >
      <div className="flex h-[100dvh] w-full flex-col bg-[var(--bg)] sm:h-[min(92vh,920px)] sm:max-w-6xl sm:rounded-[28px] sm:border sm:border-[var(--line)]">
        <div className="flex items-start justify-between gap-3 border-b border-[var(--line)] px-4 py-3">
          <div className="min-w-0">
            <h2 id="media-picker-title" className="break-words text-lg font-semibold">{title}</h2>
            <p className="mt-1 text-xs text-[var(--muted)]">{description}</p>
          </div>
          <button type="button" className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-full border border-[var(--line)] px-3" onClick={onClose}>
            关闭
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          <MediaLibraryBrowser
            mode="single"
            fill
            allowUpload
            mediaKind={mediaKind}
            selectedIds={selectedId ? [selectedId] : []}
            onPick={(asset: MediaAssetDto) => onSelect(asset)}
          />
        </div>
        <div className="flex justify-between gap-2 border-t border-[var(--line)] px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <button type="button" className="btn btn-secondary min-h-11" disabled={!selectedId || !onClear} onClick={onClear}>
            清除绑定
          </button>
          <button type="button" className="btn btn-secondary min-h-11" onClick={onClose}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}
