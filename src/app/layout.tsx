import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "PR Passport — contribution compliance for public pull requests",
  description:
    "Check a public GitHub pull request against its repository's own contribution guidelines. Deterministic checks, evidence-grounded model findings, and an Alan-ready remediation brief.",
  applicationName: "PR Passport",
  authors: [{ name: "PR Passport contributors" }],
  keywords: [
    "GitHub",
    "pull request",
    "contribution guidelines",
    "open source",
    "code review",
    "Alan",
  ],
  openGraph: {
    title: "PR Passport",
    description:
      "PASS, FAIL, or NEEDS HUMAN REVIEW for any public GitHub pull request — with the rule source and evidence for every finding.",
    type: "website",
  },
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans antialiased">
        <div className="grid-overlay" aria-hidden="true" />
        <div className="relative z-10">{children}</div>
      </body>
    </html>
  );
}