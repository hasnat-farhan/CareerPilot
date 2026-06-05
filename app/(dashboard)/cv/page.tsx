"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  UploadCloud,
  FileText,
  Loader2,
  AlertCircle,
  CheckCircle2,
  RefreshCw,
  Trash2,
  Star,
  Pencil,
  Save,
  X,
  ScanLine,
  ChevronDown,
  ChevronUp,
  Check,
  ArrowLeft,
  ArrowRight,
  Eye,
  ListTree,
  ExternalLink,
} from "lucide-react";
import { clsx } from "clsx";

// ---------- types ----------

type CvStatus = "processing" | "ready" | "failed";

type CvSummary = {
  id: string;
  status: CvStatus;
  is_active: boolean;
  version: number;
  source: "upload" | "builder";
  name: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  chunk_count: number;
};

type ChunkRow = {
  id: string;
  section: string;
  section_label: string;
  ordinality: number;
  token_count: number;
  content: string;
  truncated: boolean;
};

type CvDetail = CvSummary & {
  file_url: string | null;
};

type SignedFile = {
  url: string;
  expiresIn: number;
  mime: string;
  path: string;
};

type UploadError = { error: string; code?: string };

// ---------- helpers ----------

function statusPill(status: CvStatus) {
  if (status === "ready")
    return "bg-emerald-50 text-emerald-700 ring-emerald-200";
  if (status === "processing")
    return "bg-amber-50 text-amber-700 ring-amber-200";
  return "bg-rose-50 text-rose-700 ring-rose-200";
}

function statusLabel(status: CvStatus) {
  if (status === "ready") return "Ready";
  if (status === "processing") return "Processing";
  return "Failed";
}

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  return `${Math.floor(h / 24)} d ago`;
}

function humanSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// 20 MB - must mirror the upload route + bucket cap.
const MAX_BYTES = 20 * 1024 * 1024;
const ACCEPT = ".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// Chunks per page in the Inspector. The API supports up to 500; we
// pick 25 so the prose container can lay out a long chunk without
// the page feeling endless.
const CHUNK_PAGE_SIZE = 25;

// ---------- main component ----------

export default function CVPage() {
  const [cvs, setCvs] = useState<CvSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CvDetail | null>(null);
  const [chunks, setChunks] = useState<ChunkRow[]>([]);
  const [chunkTotal, setChunkTotal] = useState(0);
  const [chunkOffset, setChunkOffset] = useState(0);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSuccess, setUploadSuccess] = useState<string | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [dropping, setDropping] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(async () => {
    setLoadingList(true);
    try {
      const res = await fetch("/api/cv", { cache: "no-store" });
      if (!res.ok) throw new Error("Failed to load CVs");
      const json = (await res.json()) as { cvs: CvSummary[] };
      setCvs(json.cvs ?? []);
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Auto-select the active CV on first load; fall back to most recent.
  useEffect(() => {
    if (selectedId || cvs.length === 0) return;
    const active = cvs.find((c) => c.is_active);
    setSelectedId((active ?? cvs[0]!).id);
  }, [cvs, selectedId]);

  // Pull detail + chunks when selection changes. We always load the
  // FIRST page of chunks up front; further pages are loaded by
  // `loadChunkPage` so the effect doesn't re-fetch on every click.
  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setChunks([]);
      setChunkTotal(0);
      setChunkOffset(0);
      return;
    }
    let cancelled = false;
    setLoadingDetail(true);
    setChunkOffset(0);
    (async () => {
      try {
        const url =
          `/api/cv/${selectedId}` +
          `?offset=0&limit=${CHUNK_PAGE_SIZE}&full=1`;
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error("Failed to load CV");
        const json = (await res.json()) as {
          cv: CvDetail;
          chunks: ChunkRow[];
          total: number;
        };
        if (cancelled) return;
        setDetail(json.cv);
        setChunks(json.chunks ?? []);
        setChunkTotal(json.total ?? (json.chunks?.length ?? 0));
      } catch (e) {
        if (!cancelled) {
          setUploadError(e instanceof Error ? e.message : "Failed to load");
        }
      } finally {
        if (!cancelled) setLoadingDetail(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  async function loadChunkPage(offset: number) {
    if (!selectedId) return;
    setLoadingDetail(true);
    try {
      const url =
        `/api/cv/${selectedId}` +
        `?offset=${offset}&limit=${CHUNK_PAGE_SIZE}&full=1`;
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error("Failed to load chunks");
      const json = (await res.json()) as {
        chunks: ChunkRow[];
        total: number;
      };
      setChunks(json.chunks ?? []);
      setChunkTotal(json.total ?? 0);
      setChunkOffset(offset);
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoadingDetail(false);
    }
  }

  function pickFile(file: File) {
    setUploadError(null);
    setUploadSuccess(null);
    if (file.size === 0) {
      setUploadError("File is empty.");
      return;
    }
    if (file.size > MAX_BYTES) {
      setUploadError(
        `File is too large (${humanSize(file.size)}). Max is ${humanSize(MAX_BYTES)}.`,
      );
      return;
    }
    const ext = file.name.toLowerCase().split(".").pop() ?? "";
    if (ext !== "pdf" && ext !== "docx") {
      setUploadError("Only PDF and DOCX files are supported.");
      return;
    }
    setPendingFile(file);
  }

  async function upload() {
    if (!pendingFile) return;
    setUploading(true);
    setUploadError(null);
    setUploadSuccess(null);
    try {
      const fd = new FormData();
      fd.append("file", pendingFile);
      const res = await fetch("/api/cv/upload", { method: "POST", body: fd });
      const data = (await res.json()) as UploadError & { cv?: CvSummary };
      if (!res.ok) {
        if (data.code === "needs_ocr") {
          setUploadError(
            "This PDF looks scanned and has no extractable text. " +
              "Please upload a text-based PDF or a DOCX.",
          );
        } else {
          setUploadError(data.error ?? "Upload failed");
        }
        return;
      }
      setUploadSuccess(
        data.cv?.name
          ? `Uploaded "${data.cv.name}". ${data.cv.is_active ? "Active." : "Saved."}`
          : "Uploaded.",
      );
      setPendingFile(null);
      await refresh();
      if (data.cv) setSelectedId(data.cv.id);
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : "Network error");
    } finally {
      setUploading(false);
    }
  }

  async function activate(id: string) {
    try {
      const res = await fetch(`/api/cv/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ is_active: true }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setUploadError(j.error ?? "Failed to activate");
        return;
      }
      await refresh();
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : "Failed to activate");
    }
  }

  async function rename(id: string, name: string) {
    try {
      const res = await fetch(`/api/cv/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setUploadError(j.error ?? "Failed to rename");
        return;
      }
      await refresh();
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : "Failed to rename");
    }
  }

  async function remove(id: string) {
    if (!confirm("Delete this CV and all its chunks? This cannot be undone.")) return;
    try {
      const res = await fetch(`/api/cv/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setUploadError(j.error ?? "Failed to delete");
        return;
      }
      // If we deleted the active one, clear selection so the effect
      // picks the next-most-recent automatically.
      if (selectedId === id) {
        setSelectedId(null);
        setDetail(null);
        setChunks([]);
        setChunkTotal(0);
        setChunkOffset(0);
      }
      await refresh();
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : "Failed to delete");
    }
  }

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      <div>
        <h1 className="flex items-center gap-2 font-heading text-2xl font-bold tracking-tight md:text-3xl">
          <FileText className="h-6 w-6 text-primary" />
          Your CV, decoded.
        </h1>
        <p className="mt-1 text-sm text-secondary-500">
          Upload a PDF or DOCX. We&apos;ll chunk, embed, and ground every assistant answer in it.
        </p>
      </div>

      {/* Upload card */}
      <UploadCard
        pending={pendingFile}
        uploading={uploading}
        dropping={dropping}
        onPick={pickFile}
        onUpload={upload}
        onCancel={() => setPendingFile(null)}
        onDragEnter={() => setDropping(true)}
        onDragLeave={() => setDropping(false)}
        onDrop={(e) => {
          setDropping(false);
          const f = e.dataTransfer.files?.[0];
          if (f) pickFile(f);
        }}
        inputRef={inputRef}
        error={uploadError}
        success={uploadSuccess}
        onDismissError={() => {
          setUploadError(null);
          setUploadSuccess(null);
        }}
      />

      {/* List + Inspector */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
        <div className="lg:col-span-2">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="font-heading text-sm font-semibold text-secondary">
              Your CVs
            </h2>
            <button
              onClick={() => void refresh()}
              disabled={loadingList}
              className="inline-flex items-center gap-1 rounded-md border border-secondary-200 bg-white px-2 py-1 text-xs font-medium text-secondary-600 hover:bg-secondary-50 disabled:opacity-50"
            >
              <RefreshCw className={clsx("h-3 w-3", loadingList && "animate-spin")} />
              Refresh
            </button>
          </div>

          {loadingList && cvs.length === 0 ? (
            <div className="rounded-2xl border border-secondary-100 bg-white p-5 text-sm text-secondary-500 shadow-card">
              <Loader2 className="mr-2 inline h-4 w-4 animate-spin" /> Loading...
            </div>
          ) : cvs.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-secondary-200 bg-white p-6 text-center text-sm text-secondary-500">
              <FileText className="mx-auto mb-2 h-6 w-6 text-secondary-300" />
              No CVs uploaded yet.
            </div>
          ) : (
            <ul className="space-y-2">
              {cvs.map((cv) => (
                <CvListItem
                  key={cv.id}
                  cv={cv}
                  selected={cv.id === selectedId}
                  onSelect={() => setSelectedId(cv.id)}
                  onActivate={() => void activate(cv.id)}
                  onRename={(name) => void rename(cv.id, name)}
                  onDelete={() => void remove(cv.id)}
                />
              ))}
            </ul>
          )}
        </div>

        <div className="lg:col-span-3">
          <Inspector
            loading={loadingDetail}
            detail={detail}
            chunks={chunks}
            chunkTotal={chunkTotal}
            chunkOffset={chunkOffset}
            chunkPageSize={CHUNK_PAGE_SIZE}
            onPage={(o) => void loadChunkPage(o)}
            onActivate={() => detail && void activate(detail.id)}
          />
        </div>
      </div>
    </div>
  );
}

// ---------- Upload card ----------

function UploadCard(props: {
  pending: File | null;
  uploading: boolean;
  dropping: boolean;
  onPick: (f: File) => void;
  onUpload: () => void;
  onCancel: () => void;
  onDragEnter: () => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  error: string | null;
  success: string | null;
  onDismissError: () => void;
}) {
  const {
    pending, uploading, dropping, onPick, onUpload, onCancel,
    onDragEnter, onDragLeave, onDrop, inputRef, error, success, onDismissError,
  } = props;

  return (
    <div className="rounded-2xl border-2 border-dashed border-primary-200 bg-primary-50/40 p-6 text-center">
      <div
        onDragEnter={(e) => { e.preventDefault(); onDragEnter(); }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={(e) => { e.preventDefault(); onDragLeave(); }}
        onDrop={(e) => { e.preventDefault(); onDrop(e); }}
        className={clsx(
          "rounded-xl border-2 border-dashed px-6 py-8 transition",
          dropping
            ? "border-primary bg-white"
            : "border-primary-200 bg-white/60",
        )}
      >
        <span className="mx-auto grid h-12 w-12 place-items-center rounded-xl bg-primary text-white">
          <UploadCloud className="h-5 w-5" />
        </span>
        <h2 className="font-heading mt-3 text-lg font-semibold">
          {pending ? "Ready to upload" : "Drop your CV to get started"}
        </h2>
        <p className="mt-1 text-sm text-secondary-500">
          {pending
            ? `${pending.name} - ${humanSize(pending.size)}`
            : "PDF or DOCX, up to 20MB. Multiple versions supported."}
        </p>

        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT}
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onPick(f);
              e.target.value = ""; // allow re-selecting the same file
            }}
          />
          {!pending ? (
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white shadow-card transition hover:bg-primary-600"
            >
              Choose file
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                disabled={uploading}
                className="inline-flex items-center gap-2 rounded-lg border border-secondary-200 bg-white px-4 py-2 text-sm font-semibold text-secondary-700 transition hover:bg-secondary-50 disabled:opacity-50"
              >
                <Pencil className="h-4 w-4" /> Change
              </button>
              <button
                type="button"
                onClick={onUpload}
                disabled={uploading}
                className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white shadow-card transition hover:bg-primary-600 disabled:opacity-50"
              >
                {uploading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> Uploading...
                  </>
                ) : (
                  <>
                    <Save className="h-4 w-4" /> Upload
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={onCancel}
                disabled={uploading}
                className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-secondary-600 hover:bg-secondary-50 disabled:opacity-50"
              >
                <X className="h-4 w-4" /> Cancel
              </button>
            </>
          )}
        </div>
      </div>

      {error && (
        <div
          className="mt-3 flex items-start justify-between gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-left text-sm text-rose-700"
          role="alert"
        >
          <span className="flex items-start gap-2">
            <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            {error}
          </span>
          <button
            onClick={onDismissError}
            className="rounded p-0.5 text-rose-500 hover:bg-rose-100"
            aria-label="Dismiss"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      {success && (
        <div
          className="mt-3 flex items-start justify-between gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-left text-sm text-emerald-700"
          role="status"
        >
          <span className="flex items-start gap-2">
            <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0" />
            {success}
          </span>
          <button
            onClick={onDismissError}
            className="rounded p-0.5 text-emerald-500 hover:bg-emerald-100"
            aria-label="Dismiss"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

// ---------- list item ----------

function CvListItem(props: {
  cv: CvSummary;
  selected: boolean;
  onSelect: () => void;
  onActivate: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
}) {
  const { cv, selected, onSelect, onActivate, onRename, onDelete } = props;
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(cv.name ?? "");

  useEffect(() => {
    setDraftName(cv.name ?? "");
  }, [cv.name]);

  function commitRename() {
    setEditing(false);
    const next = draftName.trim();
    if (next === (cv.name ?? "")) return;
    onRename(next);
  }

  return (
    <li>
      <div
        onClick={onSelect}
        className={clsx(
          "group cursor-pointer rounded-xl border bg-white p-4 shadow-card transition",
          selected
            ? "border-primary ring-1 ring-primary"
            : "border-secondary-100 hover:border-primary-200",
        )}
      >
        <div className="flex items-start gap-3">
          <span
            className={clsx(
              "grid h-9 w-9 flex-shrink-0 place-items-center rounded-lg",
              cv.is_active
                ? "bg-primary text-white"
                : "bg-secondary-50 text-secondary-500",
            )}
          >
            <FileText className="h-4 w-4" />
          </span>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              {editing ? (
                <input
                  autoFocus
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      commitRename();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      setEditing(false);
                      setDraftName(cv.name ?? "");
                    }
                  }}
                  onBlur={commitRename}
                  maxLength={200}
                  className="min-w-0 flex-1 rounded-md border border-secondary-200 bg-white px-2 py-1 text-sm font-semibold text-secondary-900 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                />
              ) : (
                <p
                  className="truncate text-sm font-semibold text-secondary-900"
                  title={cv.name ?? ""}
                >
                  {cv.name ?? "Untitled CV"}
                </p>
              )}
              <span
                className={clsx(
                  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ring-1",
                  statusPill(cv.status),
                )}
              >
                {cv.status === "processing" && (
                  <Loader2 className="h-3 w-3 animate-spin" />
                )}
                {cv.status === "ready" && <Check className="h-3 w-3" />}
                {cv.status === "failed" && <AlertCircle className="h-3 w-3" />}
                {statusLabel(cv.status)}
              </span>
              {cv.is_active && (
                <span className="inline-flex items-center gap-1 rounded-full bg-primary-50 px-2 py-0.5 text-[10px] font-semibold uppercase text-primary ring-1 ring-primary-200">
                  <Star className="h-3 w-3" /> Active
                </span>
              )}
            </div>

            <p className="mt-0.5 text-xs text-secondary-500">
              v{cv.version} - {cv.chunk_count} chunk{cv.chunk_count === 1 ? "" : "s"} -{" "}
              {timeAgo(cv.updated_at)}
            </p>

            {cv.status === "failed" && cv.error_message && (
              <p className="mt-1 line-clamp-2 text-xs text-rose-600">
                {cv.error_message}
              </p>
            )}
          </div>
        </div>

        {/* Action row - only show on selected to keep list scannable */}
        {selected && (
          <div
            className="mt-3 flex flex-wrap items-center gap-2 border-t border-secondary-100 pt-3"
            onClick={(e) => e.stopPropagation()}
          >
            {cv.status === "ready" && !cv.is_active && (
              <button
                onClick={onActivate}
                className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs font-semibold text-white hover:bg-primary-600"
              >
                <Star className="h-3 w-3" /> Set active
              </button>
            )}
            <button
              onClick={() => setEditing((s) => !s)}
              className="inline-flex items-center gap-1 rounded-md border border-secondary-200 bg-white px-2.5 py-1 text-xs font-medium text-secondary-700 hover:bg-secondary-50"
            >
              {editing ? (
                <>
                  <X className="h-3 w-3" /> Cancel
                </>
              ) : (
                <>
                  <Pencil className="h-3 w-3" /> Rename
                </>
              )}
            </button>
            <button
              onClick={onDelete}
              className="ml-auto inline-flex items-center gap-1 rounded-md border border-rose-200 bg-white px-2.5 py-1 text-xs font-medium text-rose-600 hover:bg-rose-50"
            >
              <Trash2 className="h-3 w-3" /> Delete
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

// ---------- inspector ----------

type InspectorTab = "chunks" | "source";

function Inspector(props: {
  loading: boolean;
  detail: CvDetail | null;
  chunks: ChunkRow[];
  chunkTotal: number;
  chunkOffset: number;
  chunkPageSize: number;
  onPage: (offset: number) => void;
  onActivate: () => void;
}) {
  const {
    loading,
    detail,
    chunks,
    chunkTotal,
    chunkOffset,
    chunkPageSize,
    onPage,
    onActivate,
  } = props;

  const [tab, setTab] = useState<InspectorTab>("chunks");

  // When the user picks a different CV, snap back to the chunks tab
  // so the page doesn't open onto a stale preview pane.
  useEffect(() => {
    setTab("chunks");
  }, [detail?.id]);

  if (loading && !detail) {
    return (
      <div className="rounded-2xl border border-secondary-100 bg-white p-6 text-sm text-secondary-500 shadow-card">
        <Loader2 className="mr-2 inline h-4 w-4 animate-spin" /> Loading...
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="rounded-2xl border border-dashed border-secondary-200 bg-white p-6 text-center text-sm text-secondary-500">
        Select a CV from the list to see its chunks.
      </div>
    );
  }

  const hasSource = !!detail.file_url;
  const pageStart = chunkTotal === 0 ? 0 : chunkOffset + 1;
  const pageEnd = Math.min(chunkOffset + chunks.length, chunkTotal);

  return (
    <div className="overflow-hidden rounded-2xl border border-secondary-100 bg-white shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-secondary-100 p-5">
        <div>
          <h2 className="font-heading text-base font-semibold text-secondary-900">
            {detail.name ?? "Untitled CV"}
          </h2>
          <p className="mt-0.5 text-xs text-secondary-500">
            v{detail.version} - {detail.chunk_count} chunk
            {detail.chunk_count === 1 ? "" : "s"} - uploaded{" "}
            {timeAgo(detail.created_at)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={clsx(
              "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1",
              statusPill(detail.status),
            )}
          >
            {detail.status === "processing" && (
              <Loader2 className="h-3 w-3 animate-spin" />
            )}
            {detail.status === "ready" && <Check className="h-3 w-3" />}
            {detail.status === "failed" && <AlertCircle className="h-3 w-3" />}
            {statusLabel(detail.status)}
          </span>
          {detail.is_active && (
            <span className="inline-flex items-center gap-1 rounded-full bg-primary-50 px-2.5 py-0.5 text-xs font-semibold text-primary ring-1 ring-primary-200">
              <Star className="h-3 w-3" /> Active
            </span>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div
        role="tablist"
        aria-label="Inspector view"
        className="flex items-center gap-1 border-b border-secondary-100 bg-secondary-50/40 px-3 py-2"
      >
        <TabButton
          active={tab === "chunks"}
          onClick={() => setTab("chunks")}
          icon={<ListTree className="h-3.5 w-3.5" />}
          label="Chunks"
          badge={detail.chunk_count}
        />
        <TabButton
          active={tab === "source"}
          onClick={() => setTab("source")}
          icon={<Eye className="h-3.5 w-3.5" />}
          label="Source"
          disabled={!hasSource}
        />
      </div>

      {detail.status === "failed" && (
        <div className="m-5 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          <ScanLine className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <div>
            <p className="font-medium">Ingestion failed</p>
            {detail.error_message && (
              <p className="mt-0.5 text-xs text-rose-600">{detail.error_message}</p>
            )}
            <button
              onClick={onActivate}
              disabled
              className="mt-2 inline-flex items-center gap-1 rounded-md border border-secondary-200 bg-white px-2 py-1 text-xs font-medium text-secondary-400"
              title="Fix the CV first"
            >
              <RefreshCw className="h-3 w-3" /> Re-ingest
            </button>
          </div>
        </div>
      )}

      {tab === "chunks" ? (
        <ChunkList
          chunks={chunks}
          total={chunkTotal}
          offset={chunkOffset}
          pageSize={chunkPageSize}
          onPage={onPage}
          loading={loading}
          pageStart={pageStart}
          pageEnd={pageEnd}
        />
      ) : (
        <SourcePreview cvId={detail.id} />
      )}
    </div>
  );
}

function TabButton(props: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  badge?: number;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={props.active}
      disabled={props.disabled}
      onClick={props.onClick}
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-semibold transition",
        props.active
          ? "bg-white text-primary shadow-card"
          : "text-secondary-600 hover:bg-white hover:text-secondary-900",
        props.disabled &&
          "cursor-not-allowed opacity-50 hover:bg-transparent hover:text-secondary-600",
      )}
    >
      {props.icon}
      {props.label}
      {typeof props.badge === "number" && (
        <span
          className={clsx(
            "ml-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
            props.active
              ? "bg-primary-50 text-primary"
              : "bg-secondary-100 text-secondary-600",
          )}
        >
          {props.badge}
        </span>
      )}
    </button>
  );
}

// ---------- chunk list (full-body, paginated) ----------

function ChunkList(props: {
  chunks: ChunkRow[];
  total: number;
  offset: number;
  pageSize: number;
  onPage: (offset: number) => void;
  loading: boolean;
  pageStart: number;
  pageEnd: number;
}) {
  const {
    chunks, total, offset, pageSize, onPage, loading, pageStart, pageEnd,
  } = props;
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");

  // Reset open state when the page window changes so we don't show
  // expanded bodies from the previous page.
  useEffect(() => {
    setOpen(new Set());
  }, [offset, chunks.length]);

  if (total === 0) {
    return (
      <p className="p-5 text-sm text-secondary-500">
        No chunks yet. They appear here as soon as ingestion finishes.
      </p>
    );
  }

  // Local filter. The server returns the full page; we just hide
  // rows that don't match. With ~25 chunks per page this is instant.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return chunks;
    return chunks.filter(
      (c) =>
        c.content.toLowerCase().includes(q) ||
        c.section_label.toLowerCase().includes(q) ||
        c.section.toLowerCase().includes(q),
    );
  }, [chunks, query]);

  function toggle(id: string) {
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  const hasPrev = offset > 0;
  const hasNext = offset + chunks.length < total;

  return (
    <div className="flex flex-col">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-secondary-100 px-5 py-3">
        <div className="flex items-center gap-2 text-xs text-secondary-500">
          <span className="font-semibold text-secondary-700">
            {pageStart}-{pageEnd}
          </span>
          <span>of {total}</span>
          {loading && <Loader2 className="h-3 w-3 animate-spin" />}
        </div>
        <div className="flex items-center gap-2">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter on this page"
            className="w-48 rounded-md border border-secondary-200 bg-white px-2 py-1 text-xs focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <button
            type="button"
            onClick={() => onPage(Math.max(0, offset - pageSize))}
            disabled={!hasPrev || loading}
            className="inline-flex items-center gap-1 rounded-md border border-secondary-200 bg-white px-2 py-1 text-xs font-medium text-secondary-700 hover:bg-secondary-50 disabled:opacity-50"
            aria-label="Previous page"
          >
            <ArrowLeft className="h-3 w-3" /> Prev
          </button>
          <button
            type="button"
            onClick={() => onPage(offset + pageSize)}
            disabled={!hasNext || loading}
            className="inline-flex items-center gap-1 rounded-md border border-secondary-200 bg-white px-2 py-1 text-xs font-medium text-secondary-700 hover:bg-secondary-50 disabled:opacity-50"
            aria-label="Next page"
          >
            Next <ArrowRight className="h-3 w-3" />
          </button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <p className="p-5 text-sm text-secondary-500">
          No chunks on this page match &quot;{query}&quot;.
        </p>
      ) : (
        <ul className="divide-y divide-secondary-100">
          {filtered.map((c) => {
            const isOpen = open.has(c.id);
            return (
              <li key={c.id} className="px-5 py-3">
                <button
                  onClick={() => toggle(c.id)}
                  className="flex w-full items-center justify-between gap-2 text-left"
                >
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-secondary-900">
                      <span className="inline-block rounded bg-primary-50 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-primary ring-1 ring-primary-100">
                        #{c.ordinality}
                      </span>
                      <span>{c.section_label || c.section}</span>
                    </p>
                    <p className="mt-0.5 text-[11px] text-secondary-500">
                      {c.token_count} tokens - {c.content.length} chars
                    </p>
                  </div>
                  {isOpen ? (
                    <ChevronUp className="h-4 w-4 flex-shrink-0 text-secondary-400" />
                  ) : (
                    <ChevronDown className="h-4 w-4 flex-shrink-0 text-secondary-400" />
                  )}
                </button>
                {isOpen && (
                  <div className="prose prose-sm prose-secondary mt-3 max-w-none rounded-lg border border-secondary-100 bg-secondary-50/40 p-4 text-secondary-800">
                    <ChunkContent content={c.content} truncated={c.truncated} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * Render chunk text inside a `prose` container. The chunker preserves
 * the original whitespace (`whitespace-pre-wrap`) and we add
 * `break-words` so long URLs or tokens don't blow out the layout.
 */
function ChunkContent({
  content,
  truncated,
}: {
  content: string;
  truncated: boolean;
}) {
  if (content.length === 0) {
    return <p className="italic text-secondary-500">(empty chunk)</p>;
  }
  return (
    <div className="whitespace-pre-wrap break-words font-sans text-[13px] leading-relaxed text-secondary-800">
      {content}
      {truncated && (
        <p className="mt-3 border-t border-secondary-200 pt-2 text-[11px] italic text-secondary-500">
          (Server returned a preview; reload to fetch the full body.)
        </p>
      )}
    </div>
  );
}

// ---------- source preview ----------

function SourcePreview({ cvId }: { cvId: string }) {
  const [signed, setSigned] = useState<SignedFile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSigned(null);
    (async () => {
      try {
        const res = await fetch(`/api/cv/${cvId}/file`, { cache: "no-store" });
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? "Failed to load source");
        }
        const json = (await res.json()) as SignedFile;
        if (cancelled) return;
        setSigned(json);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cvId]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-5 text-sm text-secondary-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Fetching source...
      </div>
    );
  }

  if (error || !signed) {
    return (
      <div className="m-5 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
        <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
        <span>{error ?? "Source unavailable."}</span>
      </div>
    );
  }

  const isPdf = signed.mime === "application/pdf";
  const isDocx =
    signed.mime ===
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-secondary-100 px-5 py-3 text-xs text-secondary-500">
        <span>
          {isPdf ? "PDF preview" : isDocx ? "DOCX preview" : "Source preview"}
          {" - link expires in "}
          {Math.max(1, Math.round(signed.expiresIn / 60))} min
        </span>
        <a
          href={signed.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 rounded-md border border-secondary-200 bg-white px-2 py-1 text-xs font-medium text-secondary-700 hover:bg-secondary-50"
        >
          Open in new tab <ExternalLink className="h-3 w-3" />
        </a>
      </div>

      {isPdf ? (
        <object
          data={signed.url}
          type="application/pdf"
          className="h-[70vh] w-full"
        >
          <div className="m-5 rounded-lg border border-secondary-200 bg-secondary-50/40 p-4 text-sm text-secondary-700">
            <p>
              Your browser can&apos;t render PDFs inline.{" "}
              <a
                href={signed.url}
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold text-primary underline"
              >
                Open the PDF
              </a>{" "}
              in a new tab.
            </p>
          </div>
        </object>
      ) : isDocx ? (
        <div className="m-5 rounded-lg border border-secondary-200 bg-secondary-50/40 p-4 text-sm text-secondary-700">
          <p>
            DOCX files can&apos;t be previewed inline.{" "}
            <a
              href={signed.url}
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-primary underline"
            >
              Download the DOCX
            </a>{" "}
            to open it in Word or your default editor.
          </p>
        </div>
      ) : (
        <div className="m-5 rounded-lg border border-secondary-200 bg-secondary-50/40 p-4 text-sm text-secondary-700">
          <p>
            Unsupported preview.{" "}
            <a
              href={signed.url}
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-primary underline"
            >
              Open the source file
            </a>
            .
          </p>
        </div>
      )}
    </div>
  );
}
