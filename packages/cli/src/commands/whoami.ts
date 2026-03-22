import { getApiKey, getServerUrl } from "../utils/config.js";

interface WhoamiResponse {
  user: { id: string; email: string; name: string };
}

interface ProjectsResponse {
  projects: Array<{ id: string; name: string; slug: string }>;
}

export async function whoamiCommand(): Promise<void> {
  const apiKey = getApiKey();
  const serverUrl = getServerUrl();

  // Try to get user info via session (if API key is a session token)
  // Otherwise, just verify the key works by calling a simple endpoint
  console.log("Checking API key...\n");

  const res = await fetch(`${serverUrl}/api/tasks`, {
    headers: { "Authorization": `Bearer ${apiKey}` },
  });

  if (!res.ok) {
    if (res.status === 401) {
      console.error("Error: Invalid API key.");
    } else {
      console.error(`Error: Server returned ${res.status}`);
    }
    process.exit(1);
  }

  const data = await res.json() as { tasks: Array<{ id: string; queueId: string }> };

  console.log("Authenticated successfully!");
  console.log(`  Server: ${serverUrl}`);
  console.log(`  Key prefix: ${apiKey.slice(0, 14)}...`);
  console.log(`  Tasks registered: ${data.tasks.length}`);

  if (data.tasks.length > 0) {
    for (const task of data.tasks) {
      console.log(`    - ${task.id} (queue: ${task.queueId})`);
    }
  }
}
