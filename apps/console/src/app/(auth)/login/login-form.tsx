'use client';

import { useActionState, useState } from 'react';
import { Info } from 'lucide-react';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  FormFieldRow,
  Input,
  Label,
} from '@am/ui';
import { ROLES, type Role } from '@am/domain';
import { ROLE_DESCRIPTIONS_DE, ROLE_LABELS_DE } from '@/lib/permissions';
import { type LoginFormState, signInDemo, signInWithGoogle, signInWithMagicLink } from './actions';

const EMPTY: LoginFormState = {};

export interface LoginFormProps {
  demo: boolean;
  supabase: boolean;
  allowlistHint: string | null;
}

export function LoginForm({ demo, allowlistHint }: LoginFormProps) {
  if (demo) return <DemoLogin />;
  return <SupabaseLogin allowlistHint={allowlistHint} />;
}

/* -------------------------------------------------------------------------- */
/* Demo                                                                        */
/* -------------------------------------------------------------------------- */

const DEFAULT_DEMO_ROLES: Role[] = ['MARKETING_OPERATOR', 'MARKETING_LEAD'];

function DemoLogin() {
  const [state, action, pending] = useActionState(signInDemo, EMPTY);
  const [roles, setRoles] = useState<Role[]>(DEFAULT_DEMO_ROLES);

  const toggle = (role: Role, checked: boolean) => {
    setRoles((current) =>
      checked ? [...new Set([...current, role])] : current.filter((r) => r !== role),
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Demo-Anmeldung</CardTitle>
        <CardDescription>
          Es ist kein Supabase-Projekt verbunden. Wählen Sie eine Rolle, um den vollständigen
          Ablauf gegen Fixture-Daten durchzuspielen.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Alert tone="info" className="mb-5">
          <Info aria-hidden />
          <AlertTitle>Dies ist keine echte Authentifizierung.</AlertTitle>
          <AlertDescription>
            Rollen sind frei wählbar und dienen ausschließlich der Abnahme. Sobald Supabase Auth
            konfiguriert ist, entfällt dieser Weg automatisch.
          </AlertDescription>
        </Alert>

        <form action={action} className="flex flex-col gap-5">
          <FormFieldRow
            label="E-Mail-Adresse"
            id="demo-email"
            error={state.error && !state.error.includes('Rolle') ? state.error : undefined}
          >
            <Input
              name="email"
              type="email"
              autoComplete="email"
              required
              defaultValue="operator@am-beratung.de"
              placeholder="vorname.nachname@am-beratung.de"
            />
          </FormFieldRow>

          <fieldset className="flex flex-col gap-2">
            <legend className="pb-1 text-sm font-medium">Rollen</legend>
            {state.error?.includes('Rolle') ? (
              <p role="alert" className="pb-1 text-sm text-destructive">
                {state.error}
              </p>
            ) : null}
            <div className="grid gap-2">
              {ROLES.map((role) => (
                <label
                  key={role}
                  htmlFor={`role-${role}`}
                  className="flex min-h-11 cursor-pointer items-start gap-3 rounded-md border border-border px-3 py-2.5 hover:bg-surface-sunken"
                >
                  <Checkbox
                    id={`role-${role}`}
                    name="roles"
                    value={role}
                    checked={roles.includes(role)}
                    onCheckedChange={(checked) => toggle(role, checked === true)}
                    className="mt-0.5"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{ROLE_LABELS_DE[role]}</span>
                    <span className="block text-xs text-muted-foreground">
                      {ROLE_DESCRIPTIONS_DE[role]}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <Button type="submit" loading={pending} block>
            Anmelden
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Supabase                                                                    */
/* -------------------------------------------------------------------------- */

function SupabaseLogin({ allowlistHint }: { allowlistHint: string | null }) {
  const [state, action, pending] = useActionState(signInWithMagicLink, EMPTY);
  const [googleState, googleAction, googlePending] = useActionState(
    async () => signInWithGoogle(),
    EMPTY,
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Anmelden</CardTitle>
        <CardDescription>
          {allowlistHint
            ? `Zugelassen sind: ${allowlistHint}`
            : 'Der Zugang ist auf freigegebene Adressen beschränkt.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <form action={googleAction}>
          <Button type="submit" variant="secondary" block loading={googlePending}>
            Mit Google anmelden
          </Button>
        </form>
        {googleState.error ? (
          <p role="alert" className="text-sm text-destructive">
            {googleState.error}
          </p>
        ) : null}

        <div className="flex items-center gap-3">
          <span className="h-px flex-1 bg-border" />
          <span className="text-xs text-muted-foreground">oder</span>
          <span className="h-px flex-1 bg-border" />
        </div>

        <form action={action} className="flex flex-col gap-4">
          <FormFieldRow label="E-Mail-Adresse" id="email" error={state.error}>
            <Input
              name="email"
              type="email"
              autoComplete="email"
              required
              placeholder="vorname.nachname@am-beratung.de"
            />
          </FormFieldRow>
          {state.notice ? (
            <p role="status" className="text-sm text-success">
              {state.notice}
            </p>
          ) : null}
          <Button type="submit" block loading={pending}>
            Anmeldelink senden
          </Button>
        </form>

        <Label className="text-xs font-normal text-muted-foreground">
          Der Link ist einmalig gültig und läuft nach kurzer Zeit ab.
        </Label>
      </CardContent>
    </Card>
  );
}
