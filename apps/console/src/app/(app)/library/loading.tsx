import { LoadingState } from '@am/ui';

/** Route-level loading state: never a blank page while data is fetched. */
export default function LibraryLoading() {
  return (
    <div className="flex flex-col gap-6">
      <LoadingState label="Die Library wird geladen …" variant="rows" rows={4} />
      <LoadingState label="Die Library wird geladen …" rows={5} />
    </div>
  );
}
