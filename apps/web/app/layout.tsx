import type { ReactNode } from "react";

export const metadata = {
  title: "AgentLedger",
  description: "Evaluation and governance for AI agents",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
