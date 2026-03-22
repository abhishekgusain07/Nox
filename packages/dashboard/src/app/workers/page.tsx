"use client";

import { useQuery } from "@tanstack/react-query";

export default function WorkersPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["workers"],
    queryFn: async () => {
      const res = await fetch("/api/workers");
      return res.json();
    },
  });

  if (isLoading) return <div className="text-gray-400">Loading...</div>;

  return (
    <div>
      <h2 className="text-2xl font-bold mb-4">Workers</h2>
      <div className="grid gap-4">
        {(data?.workers ?? []).map((worker: any) => (
          <div key={worker.id} className="bg-gray-900 rounded p-4">
            <div className="flex justify-between items-center">
              <h3 className="font-mono font-bold">{worker.id}</h3>
              <span className={`px-2 py-1 rounded text-xs ${worker.status === "online" ? "bg-green-600" : "bg-gray-600"}`}>
                {worker.status}
              </span>
            </div>
            <p className="text-gray-400 text-sm mt-1">
              Tasks: {(worker.task_types ?? worker.taskTypes ?? []).join(", ")}
            </p>
            <p className="text-gray-400 text-sm">
              Last heartbeat: {new Date(worker.last_heartbeat ?? worker.lastHeartbeat).toLocaleString()}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
