"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

export default function TasksPage() {
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [newTaskId, setNewTaskId] = useState("");
  const [newQueueId, setNewQueueId] = useState("default");
  const [newMaxAttempts, setNewMaxAttempts] = useState(3);

  const { data, isLoading } = useQuery({
    queryKey: ["tasks"],
    queryFn: () => fetch("/api/tasks").then((r) => r.json()),
  });

  const registerMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: newTaskId,
          queueId: newQueueId,
          retryConfig: { maxAttempts: newMaxAttempts },
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      setShowForm(false);
      setNewTaskId("");
      setNewQueueId("default");
      setNewMaxAttempts(3);
    },
  });

  const tasks = data?.tasks ?? [];

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-2xl font-bold">Tasks</h2>
        <button
          onClick={() => setShowForm(!showForm)}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded text-sm font-medium transition-colors"
        >
          {showForm ? "Cancel" : "+ Register Task"}
        </button>
      </div>

      {showForm && (
        <div className="bg-gray-900 rounded p-4 mb-6 border border-gray-800 space-y-3">
          <div>
            <label className="block text-sm text-gray-400 mb-1">Task ID</label>
            <input
              type="text"
              value={newTaskId}
              onChange={(e) => setNewTaskId(e.target.value)}
              placeholder="e.g. deliver-webhook"
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">Queue ID</label>
            <input
              type="text"
              value={newQueueId}
              onChange={(e) => setNewQueueId(e.target.value)}
              placeholder="default"
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">Max Attempts</label>
            <input
              type="number"
              value={newMaxAttempts}
              onChange={(e) => setNewMaxAttempts(parseInt(e.target.value) || 3)}
              min={1}
              max={100}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm"
            />
          </div>
          {registerMutation.isError && (
            <p className="text-red-400 text-sm">Error: {registerMutation.error.message}</p>
          )}
          <button
            onClick={() => registerMutation.mutate()}
            disabled={!newTaskId || registerMutation.isPending}
            className="px-4 py-2 bg-green-600 hover:bg-green-700 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded text-sm font-medium transition-colors"
          >
            {registerMutation.isPending ? "Registering..." : "Register"}
          </button>
        </div>
      )}

      {isLoading ? (
        <div className="text-gray-400">Loading...</div>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500 border-b border-gray-800">
              <th className="pb-2 pr-4">Task ID</th>
              <th className="pb-2 pr-4">Queue</th>
              <th className="pb-2 pr-4">Retry Config</th>
              <th className="pb-2 pr-4">Created</th>
              <th className="pb-2 pr-4">Actions</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((t: any) => {
              const retryConfig = t.retry_config ?? t.retryConfig;
              return (
                <tr key={t.id} className="border-b border-gray-800/50 hover:bg-gray-900/50">
                  <td className="py-3 pr-4 font-mono font-medium">{t.id}</td>
                  <td className="py-3 pr-4">
                    <span className="px-2 py-1 bg-gray-800 rounded text-xs">
                      {t.queue_id ?? t.queueId}
                    </span>
                  </td>
                  <td className="py-3 pr-4 text-xs text-gray-400">
                    {retryConfig ? (
                      <span>
                        {retryConfig.maxAttempts ?? retryConfig.max_attempts ?? "?"} attempts
                        {retryConfig.factor ? `, ${retryConfig.factor}x backoff` : ""}
                      </span>
                    ) : (
                      "default"
                    )}
                  </td>
                  <td className="py-3 pr-4 text-gray-400 text-xs">
                    {new Date(t.created_at ?? t.createdAt).toLocaleString()}
                  </td>
                  <td className="py-3 pr-4">
                    <a
                      href={`/trigger?taskId=${t.id}`}
                      className="text-blue-400 hover:underline text-xs font-medium"
                    >
                      Trigger
                    </a>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {tasks.length === 0 && !isLoading && (
        <div className="text-center py-12">
          <p className="text-gray-500 text-sm">
            No tasks registered. Start the worker or register tasks manually above.
          </p>
        </div>
      )}
    </div>
  );
}
