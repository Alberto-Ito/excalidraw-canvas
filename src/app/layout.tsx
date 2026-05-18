import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "@excalidraw/excalidraw/index.css";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Excalidraw Canvas MVP",
  description: "Collaborative-ready fullscreen Excalidraw whiteboard MVP",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geistSans.variable} h-full`}>
      <body className="h-full">{children}</body>
    </html>
  );
}
