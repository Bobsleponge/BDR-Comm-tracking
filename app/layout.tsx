import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "BDR Commission Tracking",
  description: "Commission tracking system for BDR representatives",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}





