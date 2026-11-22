"use client";

import { History } from "lucide-react";
import { useApiQuery } from "@/lib/client/hooks";
import { EmptyState, ErrorState, PageHeader, Panel, SkeletonRows, Badge } from "@/components/ui/primitives";
import { DataTable, type Column } from "@/components/ui/data-table";
import { fmtDate } from "@/lib/client/utils";

type Activity = { id: string; action: string; entityType: string; summary: string; createdAt: string };

export default function ActivityPage() {
  const data = useApiQuery<Activity[]>(["activity", 200], "/api/v1/activity?limit=200");
  const cols: Column<Activity>[] = [
    { key: "summary", header: "What happened", cell: (a) => a.summary, sortValue: (a) => a.summary },
    { key: "type", header: "Area", cell: (a) => <Badge>{a.entityType}</Badge>, sortValue: (a) => a.entityType },
    { key: "when", header: "When", cell: (a) => <span className="text-xs text-muted">{fmtDate(a.createdAt, true)}</span>, sortValue: (a) => a.createdAt },
  ];
  return (
    <div>
      <PageHeader title="Activity history" description="A record of what you and your automations did in this workspace." />
      <Panel className="pt-4">
        {data.isLoading ? <SkeletonRows /> : data.error ? <ErrorState error={data.error} /> : <DataTable rows={data.data ?? []} columns={cols} rowKey={(a) => a.id} searchable={(a) => a.summary} initialSort={{ key: "when", dir: "desc" }} empty={<EmptyState icon={History} title="No activity yet" />} />}
      </Panel>
    </div>
  );
}
