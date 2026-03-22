"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useSession } from "../lib/auth-client";
import { useProjectStore } from "../lib/project-store";

const PUBLIC_PATHS = ["/login", "/signup", "/onboarding"];

export function AuthLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { data: session, isPending } = useSession();
  const { currentProject } = useProjectStore();

  // Public pages: no nav, no auth check
  if (PUBLIC_PATHS.includes(pathname)) {
    return <>{children}</>;
  }

  // Loading state
  if (isPending) {
    return (
      <div className="min-h-screen flex items-center justify-center text-gray-400">
        Loading...
      </div>
    );
  }

  const router = useRouter();

  // Not authenticated: redirect to login
  if (!session) {
    if (typeof window !== "undefined") {
      router.replace("/login");
    }
    return null;
  }

  // No project selected: redirect to onboarding
  if (!currentProject) {
    if (typeof window !== "undefined" && pathname !== "/onboarding") {
      router.replace("/onboarding");
    }
    if (pathname === "/onboarding") return <>{children}</>;
    return null;
  }

  const navItems = [
    { href: "/", label: "Runs" },
    { href: "/trigger", label: "+ Trigger", accent: true },
    { href: "/tasks", label: "Tasks" },
    { href: "/events", label: "Events" },
    { href: "/queues", label: "Queues" },
    { href: "/workers", label: "Workers" },
  ];

  return (
    <div className="flex min-h-screen">
      <nav className="w-56 bg-gray-900 border-r border-gray-800 p-4 flex flex-col gap-2">
        <h1 className="text-lg font-bold text-white mb-1">reload.dev</h1>
        <p className="text-xs text-gray-500 mb-4 truncate">{currentProject.name}</p>
        {navItems.map((item) => {
          const isActive = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`px-3 py-2 rounded transition-colors ${
                isActive
                  ? "bg-gray-800 text-white"
                  : item.accent
                    ? "hover:bg-gray-800 text-blue-400 hover:text-blue-300 font-medium"
                    : "hover:bg-gray-800 text-gray-300 hover:text-white"
              }`}
            >
              {item.label}
            </Link>
          );
        })}
        <div className="mt-auto pt-4 border-t border-gray-800">
          <Link href="/settings" className={`px-3 py-2 rounded hover:bg-gray-800 text-sm block ${pathname === "/settings" ? "bg-gray-800 text-white" : "text-gray-400 hover:text-white"}`}>
            Settings
          </Link>
          <p className="px-3 py-1 text-xs text-gray-600 truncate">{session.user?.email}</p>
        </div>
      </nav>
      <main className="flex-1 p-6">{children}</main>
    </div>
  );
}
