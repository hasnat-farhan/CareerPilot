"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  UploadCloud,
  FileText,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Trash2,
  RefreshCw,
  Check,
} from "lucide-react";

interface UploadResult {
  cv_id: string;
  chunks: number;
}

interface CvRow {
  id: string;
  name: string | null;
  status: "processing" | "ready" | "failed" | string;
  created_at: string;
  is_active: boolean;
  version: number;
}

interface CvChunkRow {
  id: string;
  section: string;
  section_label: string;
  breadcrumb?: string;
  content: string;
  ordinality: number;
  token_count: number;
}

function timeAgo(dateStr: string): string {
  const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} mins ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} hours ago`;
  return `${Math.floor(diff / 86400)} days ago`;
}

export default function CVPage() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  // Dynamic list state
  const [cvList, setCvList] = useState<CvRow[]>([]);
  const [loadingCvs, setLoadingCvs] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [activatingId, setActivatingId] = useState<string | null>(null);

  // Selected CV + chunks
  const [selectedCv, setSelectedCv] = useState<CvRow | null>(null);
  const [chunks, setChunks] = useState<CvChunkRow[]>([]);
  const [loadingChunks, setLoadingChunks] = useState(false);
  const [activeTab, setActiveTab] = useState<"chunks" | "source">("chunks");
  const [chunkCountById, setChunkCountById] = useState<Record<string, number>>({});
  const [expandedChunkIds, setExpandedChunkIds] = useState<Set<string>>(new Set());

  const fetchCvList = useCallback(async () => {
    setLoadingCvs(true);
    try {
      const res = await fetch("/api/cv/list", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { cvs: CvRow[] };
      setCvList(data.cvs ?? []);
    } catch (err) {
      // Non-fatal: leave list as-is. The upload zone still works.
      // eslint-disable-next-line no-console
      console.error("Failed to load CV list", err);
    } finally {
      setLoadingCvs(false);
    }
  }, []);

  const fetchChunks = useCallback(async (cvId: string) => {
    setLoadingChunks(true);
    try {
      const res = await fetch(`/api/cv/${cvId}/chunks`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { chunks: CvChunkRow[] };
      setChunks(data.chunks ?? []);
      setChunkCountById((prev) => ({
        ...prev,
        [cvId]: (data.chunks ?? []).length,
      }));
    } catch (err) {
      setChunks([]);
      // eslint-disable-next-line no-console
      console.error("Failed to load chunks", err);
    } finally {
      setLoadingChunks(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
    void fetchCvList();
  }, [fetchCvList]);

  // Load chunks when selection changes
  useEffect(() => {
    if (!selectedCv) {
      setChunks([]);
      return;
    }
    void fetchChunks(selectedCv.id);
  }, [selectedCv, fetchChunks]);

  async function uploadFile(file: File) {
    setUploading(true);
    setError(null);
    setResult(null);
    setFileName(file.name);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch("/api/cv/upload", {
        method: "POST",
        body: formData,
      });

      const data = (await res.json()) as { cv_id?: string; chunks?: number; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Upload failed");

      const newResult = { cv_id: data.cv_id ?? "", chunks: data.chunks ?? 0 };
      setResult(newResult);

      // Refresh the list and select the just-uploaded CV.
      await fetchCvList();
      if (newResult.cv_id) {
        // Wait one tick for the list to populate, then find and select.
        // The fetch above already set cvList, so we can match immediately.
        setCvList((prev) => {
          const found = prev.find((c) => c.id === newResult.cv_id);
          if (found) setSelectedCv(found);
          return prev;
        });
        setChunkCountById((prev) => ({
          ...prev,
          [newResult.cv_id]: newResult.chunks,
        }));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) {
      void uploadFile(file);
    }
    // Reset the input so selecting the same file again re-triggers onChange.
    event.target.value = "";
  }

  function handleClick() {
    fileInputRef.current?.click();
  }

  function handleDragOver(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    if (!isDragging) setIsDragging(true);
  }

  function handleDragLeave(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
  }

  function handleDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file) {
      void uploadFile(file);
    }
  }

  async function handleDelete(cv: CvRow, event: React.MouseEvent) {
    event.stopPropagation();
    if (deletingId) return;
    if (!window.confirm(`Delete ${cv.name ?? "this CV"}? This cannot be undone.`)) {
      return;
    }
    setDeletingId(cv.id);
    try {
      const res = await fetch(`/api/cv/${cv.id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      // If the deleted CV was selected, clear the selection.
      if (selectedCv?.id === cv.id) {
        setSelectedCv(null);
        setChunks([]);
      }
      setChunkCountById((prev) => {
        const next = { ...prev };
        delete next[cv.id];
        return next;
      });
      await fetchCvList();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setDeletingId(null);
    }
  }

  function handleSelectCv(cv: CvRow) {
    setSelectedCv(cv);
    setActiveTab("chunks");
  }

  async function handleActivate(cv: CvRow, event: React.MouseEvent) {
    event.stopPropagation();
    if (activatingId) return;
    if (cv.is_active) return; // already active; no-op
    setActivatingId(cv.id);
    setError(null);
    try {
      const res = await fetch(`/api/cv/${cv.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: true }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      await fetchCvList();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to activate CV",
      );
    } finally {
      setActivatingId(null);
    }
  }

  function toggleChunkExpanded(chunkId: string) {
    setExpandedChunkIds((prev) => {
      const next = new Set(prev);
      if (next.has(chunkId)) next.delete(chunkId);
      else next.add(chunkId);
      return next;
    });
  }

  function getStatusBadge(status: string) {
    const s = (status ?? "").toLowerCase();
    if (s === "ready") {
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">
          <CheckCircle2 className="h-3 w-3" />
          READY
        </span>
      );
    }
    if (s === "processing") {
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-yellow-100 px-2 py-0.5 text-xs font-medium text-yellow-700">
          <Loader2 className="h-3 w-3 animate-spin" />
          PROCESSING
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
        <AlertCircle className="h-3 w-3" />
        FAILED
      </span>
    );
  }

  return (
    <div className="container-wide space-y-8 py-10 md:py-14">
      <div>
        <h1 className="font-heading text-2xl font-bold tracking-tight md:text-3xl">
          Your CV, decoded.
        </h1>
        <p className="mt-1 text-sm text-secondary-500">
          Upload a PDF or DOCX. We&apos;ll chunk, embed, and ground every
          assistant answer in it.
        </p>
      </div>

      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={
          isDragging
            ? "rounded-2xl border-2 border-dashed border-primary bg-primary-50/60 p-10 text-center transition-colors"
            : "rounded-2xl border-2 border-dashed border-primary-200 bg-primary-50/40 p-10 text-center transition-colors"
        }
      >
        <span className="mx-auto grid h-12 w-12 place-items-center rounded-xl bg-primary text-white">
          {uploading ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : (
            <UploadCloud className="h-5 w-5" />
          )}
        </span>
        <h2 className="font-heading mt-4 text-lg font-semibold">
          {uploading ? "Uploading..." : "Drop your CV to get started"}
        </h2>
        <p className="mt-1 text-sm text-secondary-500">
          PDF or DOCX, up to 10MB. Multiple versions supported.
        </p>
        <button
          type="button"
          onClick={handleClick}
          disabled={uploading}
          className="mt-4 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white shadow-card transition hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {uploading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Uploading...
            </>
          ) : (
            "Choose file"
          )}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.docx"
          onChange={handleFileChange}
          className="hidden"
        />
      </div>

      {result && !error && (
        <div
          role="status"
          className="flex items-start gap-3 rounded-2xl border border-green-200 bg-green-50 p-4 text-sm text-green-800"
        >
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-green-600" />
          <div>
            <p className="font-semibold">CV uploaded successfully</p>
            <p className="text-green-700">
              CV uploaded successfully &mdash; {result.chunks} chunks indexed
            </p>
          </div>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800"
        >
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-600" />
          <div>
            <p className="font-semibold">Upload failed</p>
            <p className="text-red-700">{error}</p>
          </div>
        </div>
      )}

      {/* Two-column management area */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Left: CV list */}
        <div className="rounded-2xl border border-secondary-100 bg-white p-5 shadow-card">
          <div className="flex items-center justify-between">
            <h2 className="font-heading text-lg font-semibold">Your CVs</h2>
            <button
              type="button"
              onClick={() => void fetchCvList()}
              disabled={loadingCvs}
              className="inline-flex items-center gap-1.5 rounded-lg border border-secondary-200 bg-white px-2.5 py-1 text-xs font-medium text-secondary-700 transition hover:bg-secondary-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${loadingCvs ? "animate-spin" : ""}`}
              />
              Refresh
            </button>
          </div>

          <div className="mt-4 space-y-3">
            {loadingCvs && cvList.length === 0 ? (
              <div className="flex items-center gap-2 text-sm text-secondary-500">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading your CVs...
              </div>
            ) : cvList.length === 0 ? (
              <p className="text-sm text-secondary-500">
                No CVs uploaded yet. Your parsed chunks will appear here.
              </p>
            ) : (
              cvList.map((cv) => {
                const isSelected = selectedCv?.id === cv.id;
                const count = chunkCountById[cv.id];
                return (
                  <div
                    key={cv.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => handleSelectCv(cv)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        handleSelectCv(cv);
                      }
                    }}
                    className={`flex items-center gap-3 rounded-xl border p-3 text-left transition cursor-pointer ${
                      isSelected
                        ? "border-primary bg-primary-50/40"
                        : "border-secondary-100 bg-white hover:border-secondary-200 hover:bg-secondary-50/40"
                    }`}
                  >
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-secondary-50 text-secondary">
                      <FileText className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-sm font-semibold text-secondary-900">
                          {cv.name ?? "Untitled CV"}
                        </p>
                        {getStatusBadge(cv.status)}
                        {cv.is_active ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
                            <Check className="h-3 w-3" />
                            ACTIVE
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-0.5 text-xs text-secondary-500">
                        v{cv.version ?? 1}
                        {typeof count === "number" ? ` · ${count} chunks` : ""} ·
                        uploaded {timeAgo(cv.created_at)}
                      </p>
                    </div>
                    {cv.is_active ? (
                      <span
                        aria-disabled
                        className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-primary bg-primary-50 px-2 py-1 text-xs font-medium text-primary-700"
                      >
                        <Check className="h-3.5 w-3.5" />
                        In use
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={(e) => void handleActivate(cv, e)}
                        disabled={activatingId === cv.id}
                        className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-primary bg-white px-2 py-1 text-xs font-medium text-primary-700 transition hover:bg-primary-50 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {activatingId === cv.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Check className="h-3.5 w-3.5" />
                        )}
                        Activate
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={(e) => void handleDelete(cv, e)}
                      disabled={deletingId === cv.id}
                      className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-red-200 bg-red-50 px-2 py-1 text-xs font-medium text-red-700 transition hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {deletingId === cv.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="h-3.5 w-3.5" />
                      )}
                      Delete
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Right: chunk viewer */}
        <div className="rounded-2xl border border-secondary-100 bg-white p-5 shadow-card">
          {selectedCv ? (
            <div className="space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="truncate font-heading text-lg font-semibold">
                    {selectedCv.name ?? "Untitled CV"}
                  </h2>
                  <div className="mt-1 flex items-center gap-2">
                    {getStatusBadge(selectedCv.status)}
                    <span className="text-xs text-secondary-500">
                      uploaded {timeAgo(selectedCv.created_at)}
                    </span>
                  </div>
                </div>
              </div>

              <div className="flex gap-1 rounded-lg border border-secondary-100 bg-secondary-50/40 p-1">
                <button
                  type="button"
                  onClick={() => setActiveTab("chunks")}
                  className={`flex-1 rounded-md px-3 py-1.5 text-xs font-semibold transition ${
                    activeTab === "chunks"
                      ? "bg-white text-secondary-900 shadow-sm"
                      : "text-secondary-500 hover:text-secondary-700"
                  }`}
                >
                  Chunks
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab("source")}
                  className={`flex-1 rounded-md px-3 py-1.5 text-xs font-semibold transition ${
                    activeTab === "source"
                      ? "bg-white text-secondary-900 shadow-sm"
                      : "text-secondary-500 hover:text-secondary-700"
                  }`}
                >
                  Source
                </button>
              </div>

              {loadingChunks ? (
                <div className="flex items-center gap-2 text-sm text-secondary-500">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading chunks...
                </div>
              ) : activeTab === "chunks" ? (
                chunks.length === 0 ? (
                  <p className="text-sm text-secondary-500">
                    No chunks yet. They appear here as soon as ingestion finishes.
                  </p>
                ) : (
                  <div className="space-y-3">
                    {chunks.map((chunk) => {
                      const expanded = expandedChunkIds.has(chunk.id);
                      const truncated =
                        chunk.content.length > 300 && !expanded
                          ? chunk.content.slice(0, 300).trimEnd() + "…"
                          : chunk.content;
                      // Prefer the chunker-produced `section_label`
                      // (e.g. "Education > RV College of Engineering
                      // (2020-2024) (1/2)"). If the DB row is from
                      // before the chunker upgrade, fall back to the
                      // raw `section` enum so the UI never renders a
                      // blank label.
                      const label = chunk.section_label || chunk.section;
                      return (
                        <div
                          key={chunk.id}
                          className="rounded-xl border border-secondary-100 bg-secondary-50/30 p-3"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex min-w-0 items-center gap-2">
                              <span className="shrink-0 rounded-full bg-primary-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary-700">
                                {chunk.section}
                              </span>
                              <span className="truncate text-xs font-medium text-secondary-700">
                                {label}
                              </span>
                            </div>
                            <span className="shrink-0 text-[10px] text-secondary-400">
                              {chunk.token_count} tokens
                            </span>
                          </div>
                          <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-secondary-800">
                            {truncated}
                          </p>
                          {chunk.content.length > 300 ? (
                            <button
                              type="button"
                              onClick={() => toggleChunkExpanded(chunk.id)}
                              className="mt-1 text-xs font-semibold text-primary hover:underline"
                            >
                              {expanded ? "Show less" : "Show more"}
                            </button>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                )
              ) : (
                <pre className="max-h-[480px] overflow-auto whitespace-pre-wrap rounded-xl border border-secondary-100 bg-secondary-50/30 p-3 text-xs leading-relaxed text-secondary-800">
                  {chunks.length === 0
                    ? "No source text yet."
                    : chunks.map((c) => c.content).join("\n\n")}
                </pre>
              )}
            </div>
          ) : (
            <div className="flex h-full min-h-[200px] flex-col items-center justify-center text-center">
              <span className="grid h-10 w-10 place-items-center rounded-lg bg-secondary-50 text-secondary">
                <FileText className="h-5 w-5" />
              </span>
              <p className="mt-3 text-sm font-semibold text-secondary-700">
                Select a CV to view its chunks
              </p>
              <p className="mt-1 text-xs text-secondary-500">
                Click any CV on the left to inspect its parsed sections.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
