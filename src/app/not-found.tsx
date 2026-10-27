import Link from "next/link";
import { PassportMark } from "@/components/icons";
import { buttonClass } from "@/components/ui";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-[calc(100vh-14rem)] w-full max-w-[76rem] flex-col items-center justify-center px-4 py-16 text-center">
      <span className="grid h-10 w-10 place-items-center rounded-control border border-line bg-surface text-ink-subtle">
        <PassportMark className="h-5 w-5" />
      </span>
      <p className="mt-5 font-mono text-[12px] text-ink-subtle">404</p>
      <h1 className="mt-1 text-[24px] font-semibold tracking-[-0.01em] text-ink">Page not found</h1>
      <p className="mt-2 max-w-sm text-[13.5px] leading-6 text-ink-secondary">
        This page does not exist. Return home to check a public GitHub pull request against its repository&apos;s own
        guidelines.
      </p>
      <Link href="/" className={`${buttonClass("primary")} mt-6`}>
        Back to PR Passport
      </Link>
    </main>
  );
}
