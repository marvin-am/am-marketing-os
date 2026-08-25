import type { MediaAspect, MediaRef } from '@am/funnel-schema';

/**
 * Spec media, rendered with the box reserved before the bytes arrive.
 *
 * A creative is swapped days after a page is published, and the one thing that
 * must not change when it is, is the layout. Every asset therefore carries
 * explicit `width`/`height` attributes plus a CSS `aspect-ratio` derived from
 * the spec's declared aspect, so a late-loading — or missing — image cannot push
 * the headline down after first paint. Cumulative layout shift on an ad landing
 * page is paid for directly in lost leads.
 *
 * A plain `<img>` rather than `next/image`: the asset path is a first-party
 * storage path, the intrinsic ratio is already known from the spec, and the
 * optimiser's runtime is bytes on the critical path of a mobile ad click for no
 * benefit here.
 */

const ASPECT_DIMENSIONS: Readonly<Record<MediaAspect, { width: number; height: number }>> = {
  '1:1': { width: 1200, height: 1200 },
  '4:5': { width: 960, height: 1200 },
  '16:9': { width: 1280, height: 720 },
  '9:16': { width: 720, height: 1280 },
  '3:2': { width: 1200, height: 800 },
};

export interface SpecMediaProps {
  media: MediaRef | null;
  /** The hero image is the LCP element; everything below the fold is lazy. */
  priority?: boolean;
  className?: string;
}

export function SpecMedia({ media, priority = false, className }: SpecMediaProps) {
  if (!media) return null;
  const { width, height } = ASPECT_DIMENSIONS[media.aspect];
  const ratio = media.aspect.replace(':', ' / ');

  if (media.kind === 'VIDEO') {
    return (
      <video
        className={className}
        src={media.assetPath}
        width={width}
        height={height}
        style={{ aspectRatio: ratio, width: '100%', height: 'auto' }}
        controls
        playsInline
        preload="metadata"
        aria-label={media.alt}
      />
    );
  }

  /* The spec already declares the intrinsic ratio, so the box is reserved by
     width/height plus `aspect-ratio` — the layout guarantee `next/image` is
     partly there to provide. What it would add is an optimizer round-trip in
     front of the LCP element of a mobile ad click, for a first-party asset path
     that is ours to serve at the right size in the first place. */
  return (
    // eslint-disable-next-line @next/next/no-img-element -- see the note above: fixed dimensions, first-party path, LCP element
    <img
      className={className}
      src={media.assetPath}
      alt={media.alt}
      width={width}
      height={height}
      style={{ aspectRatio: ratio, width: '100%', height: 'auto' }}
      loading={priority ? 'eager' : 'lazy'}
      fetchPriority={priority ? 'high' : 'auto'}
      decoding={priority ? 'sync' : 'async'}
    />
  );
}
