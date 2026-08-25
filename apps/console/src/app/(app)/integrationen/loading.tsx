import { LoadingState } from '@am/ui';

/** Route-level loading state: never a blank page while data is fetched. */
export default function IntegrationenLoading() {
  return (
    <div className="flex flex-col gap-6">
      <LoadingState label="Die Anbieterprüfungen laufen …" variant="rows" rows={4} />
      <LoadingState label="Die Anbieterprüfungen laufen …" rows={5} />
    </div>
  );
}
