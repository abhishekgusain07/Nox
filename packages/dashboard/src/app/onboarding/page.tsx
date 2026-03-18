"use client";

import { useState } from "react";
import { useSession } from "../../lib/auth-client";
import { useProjectStore } from "../../lib/project-store";

const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL ?? "http://localhost:3000";

interface ProjectResponse {
  project: { id: string; name: string; slug: string };
  apiKey: { key: string; keyPrefix: string; keyType: string; environment: string };
}

export default function OnboardingPage() {
  const { data: session, isPending } = useSession();
  const [projectName, setProjectName] = useState("My Project");
  const [slug, setSlug] = useState("my-project");
  const [result, setResult] = useState<ProjectResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  if (isPending) return <div className="min-h-screen bg-gray-950 flex items-center justify-center text-gray-400">Loading...</div>;
  if (!session) {
    if (typeof window !== "undefined") window.location.href = "/login";
    return null;
  }

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await fetch(`${SERVER_URL}/api/me/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name: projectName, slug }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }

      const data = await res.json() as ProjectResponse;
      // Save project + API key to Zustand store so auth-layout knows we have a project
      useProjectStore.getState().setCurrentProject(
        { id: data.project.id, name: data.project.name, slug: data.project.slug },
        data.apiKey.key,
      );
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create project");
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = () => {
    if (result?.apiKey.key) {
      navigator.clipboard.writeText(result.apiKey.key);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  if (result) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="w-full max-w-lg">
          <div className="bg-gray-900 rounded-lg p-6 border border-gray-800 space-y-6">
            <div>
              <h2 className="text-xl font-bold text-white">Project created!</h2>
              <p className="text-gray-400 text-sm mt-1">Your project <strong>{result.project.name}</strong> is ready.</p>
            </div>

            <div className="bg-yellow-900/20 border border-yellow-800 rounded p-4">
              <h3 className="text-sm font-medium text-yellow-300 mb-2">Your API Key (shown once)</h3>
              <div className="flex items-center gap-2">
                <code className="flex-1 bg-gray-800 rounded px-3 py-2 text-sm font-mono text-green-300 break-all">
                  {result.apiKey.key}
                </code>
                <button
                  onClick={handleCopy}
                  className="px-3 py-2 bg-gray-700 hover:bg-gray-600 rounded text-sm text-white whitespace-nowrap"
                >
                  {copied ? "Copied!" : "Copy"}
                </button>
              </div>
              <p className="text-xs text-yellow-400 mt-2">
                Save this key now. You will not be able to see it again.
              </p>
            </div>

            <div className="bg-gray-800 rounded p-4 space-y-3">
              <h3 className="text-sm font-medium text-gray-300">Quick Start</h3>
              <div>
                <p className="text-xs text-gray-500 mb-1">1. Set your API key:</p>
                <code className="block bg-gray-900 rounded px-3 py-2 text-xs font-mono text-gray-300">
                  export RELOAD_API_KEY=&quot;{result.apiKey.key}&quot;
                </code>
              </div>
              <div>
                <p className="text-xs text-gray-500 mb-1">2. Start the worker:</p>
                <code className="block bg-gray-900 rounded px-3 py-2 text-xs font-mono text-gray-300">
                  RELOAD_API_KEY=$RELOAD_API_KEY pnpm worker
                </code>
              </div>
            </div>

            <a
              href="/"
              className="block w-full text-center bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 rounded transition-colors text-sm"
            >
              Go to Dashboard
            </a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center">
      <div className="w-full max-w-sm">
        <form onSubmit={handleCreate} className="bg-gray-900 rounded-lg p-6 border border-gray-800 space-y-4">
          <div>
            <h2 className="text-lg font-semibold text-white">Create your first project</h2>
            <p className="text-sm text-gray-400 mt-1">A project groups your tasks, runs, and API keys.</p>
          </div>

          {error && (
            <div className="bg-red-900/30 border border-red-800 rounded p-3 text-red-300 text-sm">{error}</div>
          )}

          <div>
            <label className="block text-sm text-gray-400 mb-1">Project Name</label>
            <input type="text" value={projectName} onChange={(e) => setProjectName(e.target.value)} required
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm" />
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1">Slug (URL-friendly)</label>
            <input type="text" value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))} required
              pattern="^[a-z0-9-]+$"
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm" />
          </div>

          <button type="submit" disabled={loading}
            className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500 text-white font-medium py-2.5 rounded transition-colors text-sm">
            {loading ? "Creating..." : "Create Project"}
          </button>
        </form>
      </div>
    </div>
  );
}
