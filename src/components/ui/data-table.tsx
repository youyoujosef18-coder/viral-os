"use client";

import * as React from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, Search } from "lucide-react";
import { cn } from "@/lib/client/utils";
import { Button, Input } from "./primitives";

export type Column<T> = {
  key: string;
  header: React.ReactNode;
  cell: (row: T) => React.ReactNode;
  /** Value used for sorting; omit to make the column unsortable. */
  sortValue?: (row: T) => string | number | null | undefined;
  className?: string;
  align?: "left" | "right";
};

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  searchable,
  searchPlaceholder = "Filter…",
  pageSize = 20,
  initialSort,
  empty,
  toolbar,
  onRowClick,
  dense,
}: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (r: T) => string;
  searchable?: (r: T) => string;
  searchPlaceholder?: string;
  pageSize?: number;
  initialSort?: { key: string; dir: "asc" | "desc" };
  empty?: React.ReactNode;
  toolbar?: React.ReactNode;
  onRowClick?: (r: T) => void;
  dense?: boolean;
}) {
  const [q, setQ] = React.useState("");
  const [sort, setSort] = React.useState(initialSort ?? null);
  const [page, setPage] = React.useState(1);

  const filtered = React.useMemo(() => {
    const needle = q.trim().toLowerCase();
    let out = needle && searchable ? rows.filter((r) => searchable(r).toLowerCase().includes(needle)) : rows;
    if (sort) {
      const col = columns.find((c) => c.key === sort.key);
      if (col?.sortValue) {
        const sv = col.sortValue;
        out = [...out].sort((a, b) => {
          const va = sv(a), vb = sv(b);
          if (va === vb) return 0;
          if (va === null || va === undefined) return 1;
          if (vb === null || vb === undefined) return -1;
          const r = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb));
          return sort.dir === "asc" ? r : -r;
        });
      }
    }
    return out;
  }, [rows, q, sort, columns, searchable]);

  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const current = Math.min(page, pages);
  const slice = filtered.slice((current - 1) * pageSize, current * pageSize);

  const toggle = (key: string) => setSort((s) => (s?.key === key ? (s.dir === "desc" ? { key, dir: "asc" } : null) : { key, dir: "desc" }));

  return (
    <div>
      {(searchable || toolbar) && (
        <div className="flex flex-wrap items-center gap-2 px-5 pb-3">
          {searchable && (
            <div className="relative w-full max-w-xs">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-faint" />
              <Input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder={searchPlaceholder} className="pl-8" aria-label="Filter rows" />
            </div>
          )}
          {toolbar}
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-[13.5px]">
          <thead>
            <tr className="border-y border-line-soft text-left text-[12px] text-muted">
              {columns.map((c) => (
                <th key={c.key} scope="col" className={cn("px-5 py-2 font-medium", c.align === "right" && "text-right", c.className)} aria-sort={sort?.key === c.key ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}>
                  {c.sortValue ? (
                    <button type="button" onClick={() => toggle(c.key)} className={cn("inline-flex items-center gap-1 hover:text-fg", c.align === "right" && "flex-row-reverse")}>
                      {c.header}
                      {sort?.key === c.key ? sort.dir === "asc" ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" /> : <ArrowUpDown className="size-3 opacity-40" />}
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {slice.map((r) => (
              <tr
                key={rowKey(r)}
                onClick={onRowClick ? () => onRowClick(r) : undefined}
                onKeyDown={onRowClick ? (e) => { if (e.key === "Enter") onRowClick(r); } : undefined}
                tabIndex={onRowClick ? 0 : undefined}
                className={cn("border-b border-line-soft/70 last:border-0", onRowClick && "cursor-pointer hover:bg-raised/50 focus-visible:bg-raised/60")}
              >
                {columns.map((c) => (
                  <td key={c.key} className={cn("px-5 align-middle", dense ? "py-2" : "py-3", c.align === "right" && "text-right tabular-nums", c.className)}>
                    {c.cell(r)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && (empty ?? <p className="px-5 py-10 text-center text-sm text-muted">{q ? `Nothing matches “${q}”.` : "No rows yet."}</p>)}
      </div>
      {pages > 1 && (
        <div className="flex items-center justify-between border-t border-line-soft px-5 py-2.5 text-xs text-muted">
          <span className="tabular-nums">
            {(current - 1) * pageSize + 1}–{Math.min(current * pageSize, filtered.length)} of {filtered.length}
          </span>
          <div className="flex gap-1">
            <Button size="icon" variant="ghost" className="size-7" onClick={() => setPage(current - 1)} disabled={current === 1} aria-label="Previous page">
              <ChevronLeft />
            </Button>
            <Button size="icon" variant="ghost" className="size-7" onClick={() => setPage(current + 1)} disabled={current === pages} aria-label="Next page">
              <ChevronRight />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
