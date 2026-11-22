"use client";

import { useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorText } from "./api";

export type Profile = { id: string; email: string; displayName: string | null; timezone: string; niche: string | null; defaultLanguage: string; dashboardLayout: string[] | null; preferences: Record<string, unknown> };
export type Connection = { id: string; platform: string; accountName: string | null; accountHandle: string | null; avatarUrl: string | null; status: string; lastSyncedAt: string | null; lastError: string | null; tokenExpiresAt: string | null; scopes: string[] };
export type MediaAsset = { id: string; kind: "video" | "image" | "audio" | "document"; filename: string; mimeType: string; sizeBytes: number; width: number | null; height: number | null; folder: string; tags: string[]; createdAt: string };

export const useApiQuery = <T,>(key: QueryKey, url: string | null, opts: { refetchInterval?: number | false } = {}) =>
  useQuery<T>({ queryKey: key, queryFn: () => api.get<T>(url!), enabled: !!url, refetchInterval: opts.refetchInterval });

export const useMe = () => useApiQuery<Profile>(["me"], "/api/v1/me");
export const useConnections = () => useApiQuery<Connection[]>(["connections"], "/api/v1/connections");

/** Mutation with toast feedback and cache invalidation. */
export function useAction<TVars, TRes = unknown>(fn: (v: TVars) => Promise<TRes>, opts: { success?: string | ((r: TRes) => string); invalidate?: QueryKey[]; onSuccess?: (r: TRes, v: TVars) => void; silentError?: boolean } = {}) {
  const qc = useQueryClient();
  return useMutation<TRes, Error, TVars>({
    mutationFn: fn,
    onSuccess: (r, v) => {
      if (opts.success) toast.success(typeof opts.success === "function" ? opts.success(r) : opts.success);
      opts.invalidate?.forEach((k) => qc.invalidateQueries({ queryKey: k }));
      opts.onSuccess?.(r, v);
    },
    onError: (err) => {
      if (!opts.silentError) toast.error(errorText(err));
    },
  });
}
