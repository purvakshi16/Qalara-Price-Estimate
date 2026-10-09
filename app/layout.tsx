import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Market Price Estimator",
  description: "Estimate regional market selling prices from similar product sources.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
