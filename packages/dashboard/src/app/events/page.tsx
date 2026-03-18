"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

const STATUS_COLORS: Record<string, string> = {
  PENDING: "text-gray-400",
  QUEUED: "text-blue-400",
  DELAYED: "text-yellow-400",
  EXECUTING: "text-purple-400",
  SUSPENDED: "text-orange-400",
  COMPLETED: "text-green-400",
  FAILED: "text-red-400",
  CANCELLED: "text-gray-500",
  EXPIRED: "text-gray-500",
};

export default function EventsPage() {
  const queryClient = useQueryClient();
  const [taskFilter, setTaskFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["events", taskFilter, typeFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (taskFilter) params.set("taskId", taskFilter);
      if (typeFilter) params.set("eventType", typeFilter);
      params.set("limit", "100");
      const res = await fetch(`/api/events?${params}`);
      return res.json();
    },
  });

  // SSE for real-time updates
  useEffect(() => {
    const source = new EventSource("/api/stream");
    source.addEventListener("update", () => {
      queryClient.invalidateQueries({ queryKey: ["events"] });
    });
    return () => source.close();
  }, [queryClient]);

  const events = data?.events ?? [];

  const eventTypes = [
    "run.pending",
    "run.queued",
    "run.delayed",
    "run.executing",
    "run.suspended",
    "run.completed",
    "run.failed",
    "run.cancelled",
    "run.expired",
  ];

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">Events</h2>

      <div className="flex gap-3 mb-4 flex-wrap">
        <input
          type="text"
          value={taskFilter}
          onChange={(e) => setTaskFilter(e.target.value)}
          placeholder="Filter by task ID..."
          className="bg-gray-900 border border-gray-700 rounded px-3 py-1.5 text-white text-sm w-48"
        />
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="bg-gray-900 border border-gray-700 rounded px-3 py-1.5 text-white text-sm"
        >
          <option value="">All event types</option>
          {eventTypes.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        {(taskFilter || typeFilter) && (
          <button
            onClick={() => {
              setTaskFilter("");
              setTypeFilter("");
            }}
            className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 rounded text-sm text-gray-400"
          >
            Clear filters
          </button>
        )}
      </div>

      {isLoading ? (
        <div className="text-gray-400">Loading...</div>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500 border-b border-gray-800">
              <th className="pb-2 pr-4">Time</th>
              <th className="pb-2 pr-4">Run</th>
              <th className="pb-2 pr-4">Task</th>
              <th className="pb-2 pr-4">Event</th>
              <th className="pb-2 pr-4">Transition</th>
              <th className="pb-2 pr-4">Attempt</th>
              <th className="pb-2 pr-4">Reason</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e: any) => (
              <tr
                key={e.id}
                className="border-b border-gray-800/50 hover:bg-gray-900/50"
              >
                <td className="py-2 pr-4 text-gray-400 text-xs whitespace-nowrap">
                  {new Date(e.createdAt ?? e.created_at).toLocaleString()}
                </td>
                <td className="py-2 pr-4">
                  <a
                    href={`/runs/${e.runId ?? e.run_id}`}
                    className="text-blue-400 hover:underline font-mono text-xs"
                  >
                    {(e.runId ?? e.run_id)?.slice(0, 8)}...
                  </a>
                </td>
                <td className="py-2 pr-4 font-mono text-xs">
                  {e.taskId ?? e.task_id}
                </td>
                <td className="py-2 pr-4">
                  <span className="px-2 py-0.5 bg-gray-800 rounded text-xs font-mono">
                    {e.eventType ?? e.event_type}
                  </span>
                </td>
                <td className="py-2 pr-4 text-xs">
                  <span className={STATUS_COLORS[e.fromStatus ?? e.from_status] ?? "text-gray-400"}>
                    {e.fromStatus ?? e.from_status ?? "—"}
                  </span>
                  <span className="text-gray-600 mx-1">-&gt;</span>
                  <span className={`font-medium ${STATUS_COLORS[e.toStatus ?? e.to_status] ?? "text-white"}`}>
                    {e.toStatus ?? e.to_status}
                  </span>
                </td>
                <td className="py-2 pr-4 text-xs text-gray-400">
                  {e.attempt ?? "—"}
                </td>
                <td className="py-2 pr-4 text-xs text-gray-400 max-w-xs truncate">
                  {e.reason ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {events.length === 0 && !isLoading && (
        <div className="text-center py-12">
          <p className="text-gray-500 text-sm">
            No events yet. Trigger a task to see events here.
          </p>
        </div>
      )}
    </div>
  );
}
