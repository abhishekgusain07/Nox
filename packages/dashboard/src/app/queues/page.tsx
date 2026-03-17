"use client";

import { useQuery } from "@tanstack/react-query";

export default function QueuesPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["queues"],
    queryFn: async () => {
      const res = await fetch("/api/queues");
      return res.json();
    },
  });

  if (isLoading) return <div className="text-gray-400">Loading...</div>;

  return (
    <div>
      <h2 className="text-2xl font-bold mb-4">Queues</h2>
      <div className="grid gap-4">
        {(data?.queues ?? []).map((queue: any) => (
          <div key={queue.id} className="bg-gray-900 rounded p-4">
            <div className="flex justify-between items-center">
              <h3 className="font-bold text-lg">{queue.id}</h3>
              <span className={`text-sm ${queue.paused ? "text-red-400" : "text-green-400"}`}>
                {queue.paused ? "Paused" : "Active"}
              </span>
            </div>
            <p className="text-gray-400 text-sm mt-1">Concurrency limit: {queue.concurrency_limit ?? queue.concurrencyLimit}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
