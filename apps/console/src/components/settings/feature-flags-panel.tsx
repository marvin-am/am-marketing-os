'use client';

import { Alert, AlertDescription, AlertTitle, Badge, Section, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@am/ui';
import type { FeatureFlagView } from '@/server/ops-port';

/**
 * Feature flags, read-only on purpose.
 *
 * The safety rails are environment-controlled: a switch in the console would
 * mean an operator could enable external writes on a running deployment without
 * a deploy, a review or an audit trail. The panel therefore shows the effective
 * value, the variable that sets it and what it actually gates — and offers no
 * control at all.
 */
export function FeatureFlagsPanel({ flags }: { flags: readonly FeatureFlagView[] }) {
  const master = flags.find((flag) => flag.key === 'externalWritesEnabled');

  return (
    <Section
      id="feature-flags"
      heading="Feature-Flags"
      description="Nur Anzeige. Diese Schalter werden über Umgebungsvariablen gesetzt und lassen sich hier bewusst nicht ändern."
    >
      <div className="flex flex-col gap-4">
        <Alert tone={master?.value ? 'warning' : 'info'}>
          <AlertTitle>
            {master?.value
              ? 'Externe Schreibzugriffe sind aktiviert.'
              : 'Externe Schreibzugriffe sind deaktiviert.'}
          </AlertTitle>
          <AlertDescription>
            {master?.value
              ? 'Aktionen können echte Objekte bei Meta und HubSpot verändern. Jede davon läuft weiterhin über eine Bestätigung mit Vorschau.'
              : 'Jeder Schreibversuch endet als Dry-Run und zeigt genau, was gesendet worden wäre. Das ist der sichere Standard.'}{' '}
            Geändert wird das ausschließlich über die Umgebung der Deployment-Konfiguration, nicht
            in der Konsole.
          </AlertDescription>
        </Alert>

        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Schalter</TableHead>
                <TableHead>Wert</TableHead>
                <TableHead>Umgebungsvariable</TableHead>
                <TableHead>Wirkung</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {flags.map((flag) => (
                <TableRow key={flag.key} data-feature-flag={flag.key}>
                  <TableCell className="font-medium">{flag.labelDe}</TableCell>
                  <TableCell>
                    <Badge tone={flag.value ? 'warning' : 'neutral'} size="sm">
                      {flag.value ? 'aktiv' : 'inaktiv'}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{flag.envVar}</TableCell>
                  <TableCell className="text-sm leading-relaxed text-muted-foreground">
                    {flag.explanationDe}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </Section>
  );
}
