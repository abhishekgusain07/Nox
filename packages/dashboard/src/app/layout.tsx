import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";
import { AuthLayout } from "./auth-layout";

export const metadata: Metadata = {
  title: "reload.dev Dashboard",
  description: "Task queue monitoring dashboard",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-gray-950 text-gray-100 min-h-screen">
        <Providers>
          <AuthLayout>{children}</AuthLayout>
        </Providers>
      </body>
    </html>
  );
}
