import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Reaction GIF Lab",
  description: "Upload an image, generate a short fal video reaction, and turn it into a GIF."
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
