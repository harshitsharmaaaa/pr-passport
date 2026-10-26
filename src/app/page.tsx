import { Analyzer } from "@/components/analyzer";
import { DEMO_SUMMARIES } from "@/lib/demo/fixtures";

interface PageProps {
  searchParams: Promise<{ url?: string | string[]; demo?: string | string[] }>;
}

function first(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

export default async function Page({ searchParams }: PageProps) {
  const params = await searchParams;
  const initialUrl = (first(params.url) ?? "").slice(0, 512);
  const autoRunDemo = first(params.demo) === "1";

  return (
    <Analyzer
      initialUrl={initialUrl}
      autoRunDemo={autoRunDemo}
      demoScenarios={DEMO_SUMMARIES}
    />
  );
}