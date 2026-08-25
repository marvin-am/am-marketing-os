'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { Button } from '@am/ui';
import { Eye, EyeOff } from 'lucide-react';
import type { CampaignHeaderView } from '@/server/campaign-port';
import { CampaignHeader } from './campaign-header';

export const PREVIEW_PARAM = 'vorschau';

/**
 * The persistent header plus the preview switch.
 *
 * Preview is a reading mode over the same data, not a different dataset, so it
 * lives in the URL and the banner says plainly that nothing on screen is
 * delivered. Every tab keeps the mode because the parameter travels with the
 * link.
 */
export function CampaignRoomHeader({ header }: { header: CampaignHeaderView }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const preview = params?.get(PREVIEW_PARAM) === '1';

  const target = new URLSearchParams(params?.toString() ?? '');
  if (preview) target.delete(PREVIEW_PARAM);
  else target.set(PREVIEW_PARAM, '1');
  const query = target.toString();
  const href = query === '' ? (pathname ?? '#') : `${pathname ?? ''}?${query}`;

  return (
    <CampaignHeader
      header={preview ? { ...header, reality: 'PREVIEW' } : header}
      actions={
        <Button asChild variant="secondary" size="sm">
          <Link href={href}>
            {preview ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
            {preview ? 'Vorschau verlassen' : 'Als Vorschau ansehen'}
          </Link>
        </Button>
      }
    />
  );
}
