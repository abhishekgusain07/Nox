"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

const STATUS_COLORS: Record<string, string> = {
  PENDING: "bg-gray-500",
  QUEUED: "bg-blue-500",
  DELAYED: "bg-yellow-500",
  EXECUTING: "bg-purple-500",
  SUSPENDED: "bg-orange-500",
  COMPLETED: "bg-green-500",
  FAILED: "bg-red-500",
  CANCELLED: "bg-gray-600",
  EXPIRED: "bg-gray-400",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`px-2 py-1 rounded text-xs font-medium text-white ${STATUS_COLORS[status] ?? "bg-gray-500"}`}>
      {status}
    </span>
  );
}

export default function RunsPage() {
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["runs", statusFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (statusFilter !== "ALL") params.set("status", statusFilter);
      params.set("limit", "100");
      const res = await fetch(`/api/runs?${params}`);
      return res.json();
    },
  });

  // SSE for real-time updates
  useEffect(() => {
    const source = new EventSource("/api/stream");
    source.addEventListener("update", () => {
      queryClient.invalidateQueries({ queryKey: ["runs"] });
    });
    return () => source.close();
  }, [queryClient]);

  const statuses = ["ALL", "PENDING", "QUEUED", "DELAYED", "EXECUTING", "SUSPENDED", "COMPLETED", "FAILED", "CANCELLED", "EXPIRED"];

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-2xl font-bold">Runs</h2>
        <a
          href="/trigger"
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded text-sm font-medium transition-colors"
        >
          + Trigger Task
        </a>
      </div>

      <div className="flex gap-2 mb-4 flex-wrap">
        {statuses.map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`px-3 py-1 rounded text-sm ${statusFilter === s ? "bg-blue-600 text-white" : "bg-gray-800 text-gray-400 hover:bg-gray-700"}`}
          >
            {s}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="text-gray-400">Loading...</div>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500 border-b border-gray-800">
              <th className="pb-2 pr-4">ID</th>
              <th className="pb-2 pr-4">Task</th>
              <th className="pb-2 pr-4">Queue</th>
              <th className="pb-2 pr-4">Status</th>
              <th className="pb-2 pr-4">Attempt</th>
              <th className="pb-2 pr-4">Created</th>
            </tr>
          </thead>
          <tbody>
            {(data?.runs ?? []).map((run: any) => (
              <tr key={run.id} className="border-b border-gray-800/50 hover:bg-gray-900/50">
                <td className="py-2 pr-4">
                  <a href={`/runs/${run.id}`} className="text-blue-400 hover:underline font-mono text-xs">
                    {run.id.slice(0, 8)}...
                  </a>
                </td>
                <td className="py-2 pr-4 font-mono">{run.task_id ?? run.taskId}</td>
                <td className="py-2 pr-4">{run.queue_id ?? run.queueId}</td>
                <td className="py-2 pr-4"><StatusBadge status={run.status} /></td>
                <td className="py-2 pr-4">{run.attempt_number ?? run.attemptNumber ?? 0}</td>
                <td className="py-2 pr-4 text-gray-400 text-xs">
                  {new Date(run.created_at ?? run.createdAt).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
