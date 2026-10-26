import Link from "next/link";
import { PassportMark } from "@/components/icons";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col items-center justify-center px-4 py-16 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-teal-300/30 bg-teal-300/10 text-teal-200">
        <PassportMark className="h-8 w-8" />
      </div>
      <p className="mt-6 text-[10px] font-semibold uppercase tracking-[0.35em] text-slate-500">
        404 - no stamp found
      </p>
      <h1 className="mt-3 text-3xl font-bold tracking-tight text-white">This page is not in the passport</h1>
      <p className="mt-3 max-w-md text-sm leading-relaxed text-slate-400">
        The page you are looking for does not exist. Head back home and analyze a public GitHub pull request.
      </p>
      <Link
        href="/"
        className="mt-8 inline-flex h-11 items-center rounded-xl bg-gradient-to-r from-teal-300 to-cyan-300 px-6 text-sm font-semibold text-slate-950 transition hover:from-teal-200 hover:to-cyan-200"
      >
        Back to PR Passport
      </Link>
    </main>
  );
}