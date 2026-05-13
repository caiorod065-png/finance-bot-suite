import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Iara Autopilot",
  description: "Self-improving quality loop for Iara WhatsApp assistant",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body style={{ fontFamily: "ui-sans-serif, system-ui", margin: 0, padding: 0 }}>{children}</body>
    </html>
  );
}
