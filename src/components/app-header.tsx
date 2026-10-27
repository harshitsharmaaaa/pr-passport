import Link from "next/link";
import { ArrowUpRightIcon, GithubIcon, PassportMark } from "./icons";

interface AppHeaderProps {
  repositoryUrl: string;
}

export function AppHeader({ repositoryUrl }: AppHeaderProps) {
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-surface">
      <div className="mx-auto flex h-14 w-full max-w-[76rem] items-center justify-between gap-4 px-4 sm:px-6">
        <Link
          href="/"
          className="flex min-w-0 items-center gap-2.5 rounded-control"
          aria-label="PR Passport home"
        >
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-control bg-brand text-white">
            <PassportMark className="h-[17px] w-[17px]" />
          </span>
          <span className="truncate text-[14.5px] font-semibold tracking-[-0.01em] text-ink">
            PR Passport
          </span>
          <span className="hidden border-l border-line pl-2.5 text-[12px] text-ink-subtle sm:inline">
            Contribution compliance
          </span>
        </Link>

        <nav aria-label="Primary" className="flex shrink-0 items-center gap-1">
          <Link
            href="/#how-it-works"
            className="hidden rounded-control px-2.5 py-1.5 text-[13px] text-ink-secondary transition-colors hover:bg-hover hover:text-ink sm:inline-flex"
          >
            How it works
          </Link>
          <a
            href={repositoryUrl}
            target="_blank"
            rel="noreferrer noopener"
            aria-label="PR Passport repository on GitHub (opens in a new tab)"
            className="inline-flex items-center gap-1.5 rounded-control px-2.5 py-1.5 text-[13px] text-ink-secondary transition-colors hover:bg-hover hover:text-ink"
          >
            <GithubIcon className="h-4 w-4" />
            <span className="hidden sm:inline">GitHub</span>
            <ArrowUpRightIcon className="h-3 w-3 text-ink-subtle" />
          </a>
        </nav>
      </div>
    </header>
  );
}
