"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";

export default function TriggerPage() {
  const queryClient = useQueryClient();

  // Fetch registered tasks
  const { data: tasksData } = useQuery({
    queryKey: ["tasks"],
    queryFn: () => fetch("/api/tasks").then((r) => r.json()),
  });

  // Form state
  const [taskId, setTaskId] = useState("");
  const [payloadStr, setPayloadStr] = useState("{}");
  const [delaySeconds, setDelaySeconds] = useState(0);
  const [priority, setPriority] = useState(0);
  const [maxAttempts, setMaxAttempts] = useState(3);
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [concurrencyKey, setConcurrencyKey] = useState("");
  const [result, setResult] = useState<{ runId?: string; error?: string } | null>(null);

  // Pre-select task from URL query params (e.g. /trigger?taskId=deliver-webhook)
  const searchParams = useSearchParams();
  useEffect(() => {
    const preselect = searchParams.get("taskId");
    if (preselect) {
      setTaskId(preselect);
      const presets: Record<string, string> = {
        "site-health-check": '{"url": "https://httpbin.org/get", "expectedStatus": 200, "timeoutMs": 10000}',
        "deliver-webhook": '{"targetUrl": "https://httpbin.org/post", "event": "user.signup", "data": {"userId": "usr_123", "email": "jane@example.com"}, "secret": "whsec_test123"}',
        "scrape-metadata": '{"url": "https://github.com"}',
        "generate-report": '{"datasetSize": 10000, "reportName": "Q1 Sales Analysis", "filters": {"minValue": 20, "maxValue": 80}}',
        "process-image": '{"imageUrl": "https://picsum.photos/800/600", "operations": ["thumbnail", "grayscale", "hash", "metadata"]}',
      };
      if (presets[preselect]) {
        setPayloadStr(presets[preselect]!);
      }
    }
  }, [searchParams]);

  // Trigger mutation
  const triggerMutation = useMutation({
    mutationFn: async () => {
      let payload: unknown;
      try {
        payload = JSON.parse(payloadStr);
      } catch {
        throw new Error("Invalid JSON payload");
      }

      const options: Record<string, unknown> = {};
      if (priority > 0) options.priority = priority;
      if (maxAttempts !== 3) options.maxAttempts = maxAttempts;
      if (idempotencyKey) options.idempotencyKey = idempotencyKey;
      if (concurrencyKey) options.concurrencyKey = concurrencyKey;

      if (delaySeconds > 0) {
        const scheduledFor = new Date(Date.now() + delaySeconds * 1000).toISOString();
        options.scheduledFor = scheduledFor;
      }

      const res = await fetch("/api/trigger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskId,
          payload,
          options: Object.keys(options).length > 0 ? options : undefined,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }

      return res.json();
    },
    onSuccess: (data) => {
      setResult({ runId: data.runId });
      queryClient.invalidateQueries({ queryKey: ["runs"] });
    },
    onError: (err: Error) => {
      setResult({ error: err.message });
    },
  });

  const tasks = tasksData?.tasks ?? [];

  // Preset payloads for known tasks
  const presets: Record<string, string> = {
    "site-health-check": '{"url": "https://httpbin.org/get", "expectedStatus": 200, "timeoutMs": 10000}',
    "deliver-webhook": '{"targetUrl": "https://httpbin.org/post", "event": "user.signup", "data": {"userId": "usr_123", "email": "jane@example.com"}, "secret": "whsec_test123"}',
    "scrape-metadata": '{"url": "https://github.com"}',
    "generate-report": '{"datasetSize": 10000, "reportName": "Q1 Sales Analysis", "filters": {"minValue": 20, "maxValue": 80}}',
    "process-image": '{"imageUrl": "https://picsum.photos/800/600", "operations": ["thumbnail", "grayscale", "hash", "metadata"]}',
  };

  return (
    <div className="max-w-2xl">
      <h2 className="text-2xl font-bold mb-6">Trigger Task</h2>

      <div className="space-y-4">
        {/* Task Selection */}
        <div>
          <label className="block text-sm text-gray-400 mb-1">Task</label>
          {tasks.length > 0 ? (
            <select
              value={taskId}
              onChange={(e) => {
                setTaskId(e.target.value);
                if (presets[e.target.value]) {
                  setPayloadStr(presets[e.target.value]!);
                }
              }}
              className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-white"
            >
              <option value="">Select a task...</option>
              {tasks.map((t: any) => (
                <option key={t.id} value={t.id}>
                  {t.id} (queue: {t.queue_id ?? t.queueId})
                </option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={taskId}
              onChange={(e) => setTaskId(e.target.value)}
              placeholder="hello-world"
              className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-white"
            />
          )}
        </div>

        {/* Payload */}
        <div>
          <label className="block text-sm text-gray-400 mb-1">Payload (JSON)</label>
          <textarea
            value={payloadStr}
            onChange={(e) => setPayloadStr(e.target.value)}
            rows={5}
            className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-white font-mono text-sm"
            placeholder='{"key": "value"}'
          />
        </div>

        {/* Delay */}
        <div>
          <label className="block text-sm text-gray-400 mb-1">
            Delay (seconds) — 0 = execute immediately
          </label>
          <input
            type="number"
            value={delaySeconds}
            onChange={(e) => setDelaySeconds(parseInt(e.target.value) || 0)}
            min={0}
            max={86400}
            className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-white"
          />
          {delaySeconds > 0 && (
            <p className="text-xs text-yellow-400 mt-1">
              Run will be DELAYED and execute after {delaySeconds}s (at{" "}
              {new Date(Date.now() + delaySeconds * 1000).toLocaleTimeString()})
            </p>
          )}
        </div>

        {/* Advanced Options (collapsible) */}
        <details className="bg-gray-900 rounded p-4 border border-gray-800">
          <summary className="text-sm text-gray-400 cursor-pointer">Advanced Options</summary>
          <div className="mt-3 space-y-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Priority (0-100, higher = first)</label>
              <input
                type="number"
                value={priority}
                onChange={(e) => setPriority(parseInt(e.target.value) || 0)}
                min={0}
                max={100}
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Max Attempts</label>
              <input
                type="number"
                value={maxAttempts}
                onChange={(e) => setMaxAttempts(parseInt(e.target.value) || 3)}
                min={1}
                max={100}
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Idempotency Key (optional)</label>
              <input
                type="text"
                value={idempotencyKey}
                onChange={(e) => setIdempotencyKey(e.target.value)}
                placeholder="unique-key-123"
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Concurrency Key (optional)</label>
              <input
                type="text"
                value={concurrencyKey}
                onChange={(e) => setConcurrencyKey(e.target.value)}
                placeholder="user-123"
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm"
              />
            </div>
          </div>
        </details>

        {/* Trigger Button */}
        <button
          onClick={() => triggerMutation.mutate()}
          disabled={!taskId || triggerMutation.isPending}
          className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500 text-white font-medium py-3 rounded transition-colors"
        >
          {triggerMutation.isPending
            ? "Triggering..."
            : delaySeconds > 0
              ? `Trigger with ${delaySeconds}s delay`
              : "Trigger Now"}
        </button>

        {/* Result */}
        {result && (
          <div
            className={`rounded p-4 ${result.error ? "bg-red-900/30 border border-red-800" : "bg-green-900/30 border border-green-800"}`}
          >
            {result.error ? (
              <p className="text-red-300 text-sm">Error: {result.error}</p>
            ) : (
              <div>
                <p className="text-green-300 text-sm">
                  Run created successfully!
                </p>
                <a
                  href={`/runs/${result.runId}`}
                  className="text-blue-400 hover:underline text-sm font-mono mt-1 block"
                >
                  {result.runId} →
                </a>
              </div>
            )}
          </div>
        )}

        {/* Quick triggers */}
        <div className="border-t border-gray-800 pt-4 mt-4">
          <h3 className="text-sm text-gray-400 mb-3">Quick Trigger</h3>
          <div className="flex gap-2 flex-wrap">
            {tasks.map((t: any) => (
              <button
                key={t.id}
                onClick={() => {
                  setTaskId(t.id);
                  setPayloadStr(presets[t.id] ?? "{}");
                  setDelaySeconds(0);
                  setTimeout(() => triggerMutation.mutate(), 100);
                }}
                className="px-3 py-2 bg-gray-800 hover:bg-gray-700 rounded text-sm text-gray-300"
              >
                {t.id}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
