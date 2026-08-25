import { LoadingState } from '@am/ui';

/** Route-level loading state: never a blank page while data is fetched. */
export default function EinstellungenLoading() {
  return (
    <div className="flex flex-col gap-6">
      <LoadingState label="Die Einstellungen werden geladen …" variant="rows" rows={4} />
      <LoadingState label="Die Einstellungen werden geladen …" rows={5} />
    </div>
  );
}
