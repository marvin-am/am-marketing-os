import { LoadingState } from '@am/ui';

/** Route-level loading state: never a blank page while data is fetched. */
export default function HeuteLoading() {
  return (
    <div className="flex flex-col gap-6">
      <LoadingState label="Der Tagesüberblick wird geladen …" variant="tiles" rows={4} />
      <LoadingState label="Der Tagesüberblick wird geladen …" rows={5} />
    </div>
  );
}
