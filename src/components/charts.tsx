"use client";

import * as React from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { fmtNum } from "@/lib/client/utils";

export const SERIES_COLORS: Record<string, string> = { youtube: "#ff6b6b", tiktok: "#22d3ee", instagram: "#f06292", views: "#7c5cff", value: "#7c5cff" };
const tick = { fill: "#8d93ad", fontSize: 11 };

function ChartTooltip({ active, payload, label }: { active?: boolean; payload?: { name: string; value: number; color: string }[]; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border border-line bg-raised px-3 py-2 text-xs shadow-xl">
      <p className="mb-1 text-muted">{label}</p>
      {payload.map((p) => (
        <p key={p.name} className="flex items-center gap-2 tabular-nums">
          <span className="size-2 rounded-full" style={{ background: p.color }} />
          <span className="text-muted">{p.name}</span>
          <span className="ml-auto font-medium text-fg">{fmtNum(p.value)}</span>
        </p>
      ))}
    </div>
  );
}

export function SeriesChart({ data, keys, height = 260, xKey = "date" }: { data: Record<string, unknown>[]; keys: string[]; height?: number; xKey?: string }) {
  const label = (k: string) => ({ youtube: "YouTube", tiktok: "TikTok", instagram: "Instagram" })[k] ?? k;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
        <defs>
          {keys.map((k) => (
            <linearGradient key={k} id={`g-${k}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={SERIES_COLORS[k] ?? "#7c5cff"} stopOpacity={0.28} />
              <stop offset="100%" stopColor={SERIES_COLORS[k] ?? "#7c5cff"} stopOpacity={0} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid stroke="#222842" vertical={false} />
        <XAxis dataKey={xKey} tick={tick} tickLine={false} axisLine={false} tickFormatter={(v: string) => (v?.length === 10 ? v.slice(5) : v)} minTickGap={24} />
        <YAxis tick={tick} tickLine={false} axisLine={false} tickFormatter={(v: number) => fmtNum(v)} width={56} />
        <Tooltip content={<ChartTooltip />} cursor={{ stroke: "#2a3150" }} />
        {keys.length > 1 && <Legend wrapperStyle={{ fontSize: 12, color: "#8d93ad" }} formatter={label} />}
        {keys.map((k) => (
          <Area key={k} type="monotone" dataKey={k} name={label(k)} stroke={SERIES_COLORS[k] ?? "#7c5cff"} strokeWidth={2} fill={`url(#g-${k})`} stackId={undefined} dot={false} activeDot={{ r: 3 }} />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function BarsChart({ data, dataKey, xKey, height = 220, color = "#7c5cff", nameLabel }: { data: Record<string, unknown>[]; dataKey: string; xKey: string; height?: number; color?: string; nameLabel?: string }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
        <CartesianGrid stroke="#222842" vertical={false} />
        <XAxis dataKey={xKey} tick={tick} tickLine={false} axisLine={false} />
        <YAxis tick={tick} tickLine={false} axisLine={false} tickFormatter={(v: number) => fmtNum(v)} width={56} />
        <Tooltip content={<ChartTooltip />} cursor={{ fill: "#1e2540" }} />
        <Bar dataKey={dataKey} name={nameLabel ?? dataKey} fill={color} radius={[4, 4, 0, 0]} maxBarSize={44} />
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Time-range filter shared by analytics surfaces. */
export function RangePicker({ days, onChange }: { days: number; onChange: (d: number) => void }) {
  const [custom, setCustom] = React.useState(false);
  const presets = [7, 30, 90];
  return (
    <div className="flex items-center gap-1 rounded-md border border-line bg-ink-2 p-0.5" role="group" aria-label="Date range">
      {presets.map((d) => (
        <button key={d} onClick={() => { setCustom(false); onChange(d); }} aria-pressed={!custom && days === d} className={`rounded-sm px-2.5 py-1 text-xs font-medium transition-colors ${!custom && days === d ? "bg-raised text-fg" : "text-muted hover:text-fg"}`}>
          {d}d
        </button>
      ))}
      <label className={`flex items-center gap-1 rounded-sm px-2 py-0.5 text-xs ${custom ? "bg-raised text-fg" : "text-muted"}`}>
        Since
        <input
          type="date"
          aria-label="Custom range start date"
          max={new Date().toISOString().slice(0, 10)}
          className="bg-transparent text-xs text-fg outline-none [color-scheme:dark]"
          onChange={(e) => {
            if (!e.target.value) return;
            const d = Math.max(1, Math.min(365, Math.ceil((Date.now() - new Date(e.target.value).getTime()) / 86400000)));
            setCustom(true);
            onChange(d);
          }}
        />
      </label>
    </div>
  );
}
