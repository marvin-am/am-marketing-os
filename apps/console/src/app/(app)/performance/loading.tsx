import { LoadingState, PageHeader } from '@am/ui';

export default function PerformanceLoading() {
  return (
    <div className="flex flex-col gap-8">
      <PageHeader title="Performance" description="Kennzahlen werden aus den Rollups gelesen …" />
      <LoadingState variant="tiles" rows={8} label="Performance-Kennzahlen werden geladen …" />
      <LoadingState variant="rows" rows={4} label="Verlauf und Aufschlüsselung werden geladen …" />
    </div>
  );
}
