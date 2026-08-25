'use client';

import { LogOut, ShieldAlert, User } from 'lucide-react';
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  TooltipContent,
  TooltipRoot,
  TooltipTrigger,
} from '@am/ui';
import type { FeatureFlags, Role } from '@am/domain';
import { ROLE_LABELS_DE } from '@/lib/permissions';

export interface TopbarProps {
  displayName: string;
  email: string;
  roles: Role[];
  flags: FeatureFlags;
  demoAuth: boolean;
  signOutHref: string;
}

/**
 * The safety state of the deployment is shown permanently, not buried in a
 * settings page. Someone looking at this screen must never be unsure whether an
 * action they take can reach the real ad account.
 */
export function Topbar({
  displayName,
  email,
  roles,
  flags,
  demoAuth,
  signOutHref,
}: TopbarProps) {
  const writesOn = flags.externalWritesEnabled;

  return (
    <header className="flex h-14 items-center justify-between gap-4 border-b border-border bg-surface px-4">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold tracking-tight">
          A&amp;M <span className="text-brand">Marketing OS</span>
        </span>

        {flags.demoMode ? (
          <TooltipRoot>
            <TooltipTrigger asChild>
              <Badge tone="warning" size="sm">
                Demo-Modus
              </Badge>
            </TooltipTrigger>
            <TooltipContent>
              Alle Provider laufen gegen deterministische Fixtures. Es besteht keine
              Verbindung zu Meta, HubSpot oder OpenAI.
            </TooltipContent>
          </TooltipRoot>
        ) : null}
      </div>

      <div className="flex items-center gap-3">
        <TooltipRoot>
          <TooltipTrigger asChild>
            <Badge tone={writesOn ? 'destructive' : 'neutral'} size="sm">
              {writesOn ? 'Externe Schreibzugriffe AKTIV' : 'Externe Schreibzugriffe aus'}
            </Badge>
          </TooltipTrigger>
          <TooltipContent>
            {writesOn
              ? 'Aktionen können echte Änderungen an Meta und HubSpot auslösen.'
              : 'Jede externe Aktion wird als Dry-Run angezeigt und nicht ausgeführt.'}
          </TooltipContent>
        </TooltipRoot>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" aria-label="Konto und Rollen">
              <User aria-hidden />
              <span className="max-w-40 truncate">{displayName}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-72">
            <DropdownMenuLabel>
              <span className="block truncate font-medium">{displayName}</span>
              <span className="block truncate text-xs font-normal text-muted-foreground">
                {email}
              </span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <div className="px-2 py-1.5">
              <p className="pb-1 text-xs font-medium text-muted-foreground">Rollen</p>
              <div className="flex flex-wrap gap-1">
                {roles.map((role) => (
                  <Badge key={role} tone="neutral" size="sm">
                    {ROLE_LABELS_DE[role]}
                  </Badge>
                ))}
              </div>
            </div>
            {demoAuth ? (
              <>
                <DropdownMenuSeparator />
                <div className="flex gap-2 px-2 py-1.5 text-xs text-muted-foreground">
                  <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  <span>
                    Demo-Anmeldung ohne Supabase-Projekt. Rollen sind frei wählbar und dienen
                    nur der Abnahme.
                  </span>
                </div>
              </>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <a href={signOutHref}>
                <LogOut aria-hidden />
                Abmelden
              </a>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
