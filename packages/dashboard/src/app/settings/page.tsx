"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useSession, signOut } from "../../lib/auth-client";
import { useProjectStore } from "../../lib/project-store";

const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL ?? "http://localhost:3000";

interface ApiKeyResponse {
  id: string;
  name: string;
  key?: string;
  keyPrefix: string;
  keyType: string;
  environment: string;
  lastUsedAt: string | null;
  createdAt: string;
}

export default function SettingsPage() {
  const { data: session } = useSession();
  const { currentProject } = useProjectStore();
  const queryClient = useQueryClient();
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyType, setNewKeyType] = useState<"client" | "server">("client");
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const { data: keysData } = useQuery({
    queryKey: ["project-keys", currentProject?.id],
    queryFn: async () => {
      if (!currentProject) return { keys: [] };
      const res = await fetch(`${SERVER_URL}/api/me/projects/${currentProject.id}/keys`, {
        credentials: "include",
      });
      return res.json() as Promise<{ keys: ApiKeyResponse[] }>;
    },
    enabled: !!currentProject,
  });

  const createKeyMutation = useMutation({
    mutationFn: async () => {
      if (!currentProject) throw new Error("No project selected");
      const res = await fetch(`${SERVER_URL}/api/me/projects/${currentProject.id}/keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name: newKeyName, keyType: newKeyType }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<ApiKeyResponse>;
    },
    onSuccess: (data) => {
      if (data.key) setCreatedKey(data.key);
      setNewKeyName("");
      queryClient.invalidateQueries({ queryKey: ["project-keys"] });
    },
  });

  const revokeKeyMutation = useMutation({
    mutationFn: async (keyId: string) => {
      if (!currentProject) throw new Error("No project selected");
      const res = await fetch(`${SERVER_URL}/api/me/projects/${currentProject.id}/keys/${keyId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["project-keys"] });
    },
  });

  const handleCopy = () => {
    if (createdKey) {
      navigator.clipboard.writeText(createdKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="max-w-2xl">
      <h2 className="text-2xl font-bold mb-6">Settings</h2>

      <div className="bg-gray-900 rounded p-4 mb-6 border border-gray-800">
        <h3 className="text-sm text-gray-400 mb-2">User</h3>
        <p className="text-white">{session?.user?.name ?? "—"}</p>
        <p className="text-gray-400 text-sm">{session?.user?.email ?? "—"}</p>
        <button onClick={() => signOut().then(() => { window.location.href = "/login"; })}
          className="mt-3 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 rounded text-sm text-gray-300">
          Sign out
        </button>
      </div>

      <div className="bg-gray-900 rounded p-4 mb-6 border border-gray-800">
        <h3 className="text-sm text-gray-400 mb-2">Current Project</h3>
        {currentProject ? (
          <div>
            <p className="text-white font-medium">{currentProject.name}</p>
            <p className="text-gray-400 text-xs font-mono">{currentProject.id}</p>
          </div>
        ) : (
          <p className="text-gray-500 text-sm">No project selected. <a href="/onboarding" className="text-blue-400 hover:underline">Create one</a></p>
        )}
      </div>

      <div className="bg-gray-900 rounded p-4 border border-gray-800">
        <h3 className="text-sm text-gray-400 mb-4">API Keys</h3>

        {createdKey && (
          <div className="bg-yellow-900/20 border border-yellow-800 rounded p-3 mb-4">
            <p className="text-xs text-yellow-300 mb-1">New key created (shown once):</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 bg-gray-800 rounded px-2 py-1 text-xs font-mono text-green-300 break-all">{createdKey}</code>
              <button onClick={handleCopy} className="px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded text-xs text-white">
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
          </div>
        )}

        <div className="flex gap-2 mb-4">
          <input type="text" value={newKeyName} onChange={(e) => setNewKeyName(e.target.value)}
            placeholder="Key name" className="flex-1 bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-white text-sm" />
          <select value={newKeyType} onChange={(e) => setNewKeyType(e.target.value as "client" | "server")}
            className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-white text-sm">
            <option value="client">Client</option>
            <option value="server">Server</option>
          </select>
          <button onClick={() => createKeyMutation.mutate()} disabled={!newKeyName || createKeyMutation.isPending}
            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 rounded text-sm text-white">
            Create
          </button>
        </div>

        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500 border-b border-gray-800">
              <th className="pb-2 pr-3">Name</th>
              <th className="pb-2 pr-3">Prefix</th>
              <th className="pb-2 pr-3">Type</th>
              <th className="pb-2 pr-3">Last Used</th>
              <th className="pb-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {(keysData?.keys ?? []).map((k) => (
              <tr key={k.id} className="border-b border-gray-800/50">
                <td className="py-2 pr-3">{k.name}</td>
                <td className="py-2 pr-3 font-mono text-xs text-gray-400">{k.keyPrefix}...</td>
                <td className="py-2 pr-3">
                  <span className={`px-2 py-0.5 rounded text-xs ${k.keyType === "server" ? "bg-purple-900 text-purple-300" : "bg-gray-800 text-gray-300"}`}>
                    {k.keyType}
                  </span>
                </td>
                <td className="py-2 pr-3 text-gray-400 text-xs">
                  {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : "Never"}
                </td>
                <td className="py-2">
                  <button onClick={() => revokeKeyMutation.mutate(k.id)}
                    className="text-red-400 hover:text-red-300 text-xs">Revoke</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
