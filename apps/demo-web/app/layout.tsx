import type { ReactNode } from "react";

export const metadata = {
  title: "RivoKit — marketplace demo",
  description: "Etalase Host yang mengintegrasikan RivoKit",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  );
}
