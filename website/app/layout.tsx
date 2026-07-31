import type { Metadata } from "next";
import { Space_Grotesk, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const grotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-grotesk",
  weight: ["400", "500", "600", "700"],
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  weight: ["400", "500", "700"],
});

export const metadata: Metadata = {
  title: "Meterbility — The debugger for AI agents",
  description:
    "Capture every agent run, inspect every decision, pause and inject live, fork from any step, diff the trajectories. Open-source observability for Claude Code, Codex, Cursor, and custom agents.",
  metadataBase: new URL("https://meterbility.com"),
  openGraph: {
    title: "Meterbility — The debugger for AI agents",
    description:
      "Capture, inspect, probe, fork, diff. Open-source agent observability.",
    url: "https://meterbility.com",
    siteName: "Meterbility",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${grotesk.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
