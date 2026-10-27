import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Geist, Geist_Mono } from "next/font/google";
import { AppHeader } from "@/components/app-header";
import "./globals.css";

const geistSans = Geist({
  subsets: ["latin"],
  variable: "--font-geist-sans",
  display: "swap",
});

const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "PR Passport — pull request compliance checks",
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

export const viewport: Viewport = {
  themeColor: "#f7f8f6",
  colorScheme: "light",
};

const REPOSITORY_URL = "https://github.com/harshitsharmaaaa/pr-passport";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body className="min-h-screen bg-canvas font-sans text-ink antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-control focus:border focus:border-line focus:bg-surface focus:px-4 focus:py-2 focus:text-[13px] focus:font-medium focus:text-ink focus:shadow-sm"
        >
          Skip to content
        </a>
        <AppHeader repositoryUrl={REPOSITORY_URL} />
        <div id="main" tabIndex={-1} className="outline-none">
          {children}
        </div>
        <footer className="mt-16 border-t border-line">
          <div className="mx-auto flex w-full max-w-[76rem] flex-col gap-1.5 px-4 py-6 text-[12px] text-ink-subtle sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <p>PR Passport · MIT licensed · built for the Alan hackathon</p>
            <p>Read-only. No OAuth, no writes, no repository code executed.</p>
          </div>
        </footer>
      </body>
    </html>
  );
}
