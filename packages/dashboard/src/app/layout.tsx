import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "reload.dev Dashboard",
  description: "Task queue monitoring dashboard",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-gray-950 text-gray-100 min-h-screen">
        <Providers>
          <div className="flex min-h-screen">
            <nav className="w-56 bg-gray-900 border-r border-gray-800 p-4 flex flex-col gap-2">
              <h1 className="text-lg font-bold text-white mb-4">reload.dev</h1>
              <a href="/" className="px-3 py-2 rounded hover:bg-gray-800 text-gray-300 hover:text-white">Runs</a>
              <a href="/trigger" className="px-3 py-2 rounded hover:bg-gray-800 text-blue-400 hover:text-blue-300 font-medium">+ Trigger</a>
              <a href="/queues" className="px-3 py-2 rounded hover:bg-gray-800 text-gray-300 hover:text-white">Queues</a>
              <a href="/workers" className="px-3 py-2 rounded hover:bg-gray-800 text-gray-300 hover:text-white">Workers</a>
            </nav>
            <main className="flex-1 p-6">{children}</main>
          </div>
        </Providers>
      </body>
    </html>
  );
}
