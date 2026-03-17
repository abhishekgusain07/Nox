"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useParams } from "next/navigation";

export default function RunDetailPage() {
  const params = useParams();
  const runId = params.id as string;
  const queryClient = useQueryClient();

  const { data: runData } = useQuery({
    queryKey: ["run", runId],
    queryFn: async () => {
      const res = await fetch(`/api/runs/${runId}`);
      return res.json();
    },
  });

  const { data: eventsData } = useQuery({
    queryKey: ["run-events", runId],
    queryFn: async () => {
      const res = await fetch(`/api/runs/${runId}/events`);
      return res.json();
    },
  });

  // SSE for real-time updates
  useEffect(() => {
    const source = new EventSource(`/api/runs/${runId}/stream`);
    source.addEventListener("update", () => {
      queryClient.invalidateQueries({ queryKey: ["run", runId] });
      queryClient.invalidateQueries({ queryKey: ["run-events", runId] });
    });
    return () => source.close();
  }, [runId, queryClient]);

  const run = runData;
  const events = eventsData?.events ?? [];

  if (!run) return <div className="text-gray-400">Loading...</div>;

  return (
    <div>
      <h2 className="text-2xl font-bold mb-4">Run {run.id?.slice(0, 8)}...</h2>

      <div className="grid grid-cols-2 gap-4 mb-6">
        <div className="bg-gray-900 rounded p-4">
          <h3 className="text-sm text-gray-500 mb-2">Status</h3>
          <span className="text-lg font-bold">{run.status}</span>
        </div>
        <div className="bg-gray-900 rounded p-4">
          <h3 className="text-sm text-gray-500 mb-2">Task</h3>
          <span className="font-mono">{run.task_id ?? run.taskId}</span>
        </div>
        <div className="bg-gray-900 rounded p-4">
          <h3 className="text-sm text-gray-500 mb-2">Queue</h3>
          <span>{run.queue_id ?? run.queueId}</span>
        </div>
        <div className="bg-gray-900 rounded p-4">
          <h3 className="text-sm text-gray-500 mb-2">Attempt</h3>
          <span>{run.attempt_number ?? run.attemptNumber ?? 0} / {run.max_attempts ?? run.maxAttempts ?? 3}</span>
        </div>
      </div>

      {run.payload && (
        <div className="bg-gray-900 rounded p-4 mb-4">
          <h3 className="text-sm text-gray-500 mb-2">Payload</h3>
          <pre className="text-xs text-gray-300 overflow-auto">{JSON.stringify(run.payload, null, 2)}</pre>
        </div>
      )}

      {run.output && (
        <div className="bg-gray-900 rounded p-4 mb-4">
          <h3 className="text-sm text-gray-500 mb-2">Output</h3>
          <pre className="text-xs text-green-300 overflow-auto">{JSON.stringify(run.output, null, 2)}</pre>
        </div>
      )}

      {run.error && (
        <div className="bg-gray-900 rounded p-4 mb-4 border border-red-800">
          <h3 className="text-sm text-red-400 mb-2">Error</h3>
          <pre className="text-xs text-red-300 overflow-auto">{JSON.stringify(run.error, null, 2)}</pre>
        </div>
      )}

      <h3 className="text-lg font-bold mt-6 mb-3">Event Timeline</h3>
      <div className="space-y-2">
        {events.map((event: any, i: number) => (
          <div key={event.id ?? i} className="flex items-start gap-3 bg-gray-900 rounded p-3">
            <div className="w-2 h-2 rounded-full bg-blue-500 mt-1.5 shrink-0" />
            <div className="flex-1">
              <div className="flex justify-between">
                <span className="text-sm font-medium">
                  {event.from_status ?? event.fromStatus} → {event.to_status ?? event.toStatus}
                </span>
                <span className="text-xs text-gray-500">
                  {new Date(event.created_at ?? event.createdAt).toLocaleTimeString()}
                </span>
              </div>
              {event.reason && <p className="text-xs text-gray-400 mt-1">{event.reason}</p>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
