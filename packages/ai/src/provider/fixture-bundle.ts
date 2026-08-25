import { aiContextBundleSchema, type AiContextBundle } from '@am/domain';

/**
 * A realistic, approved `AiContextBundle` for demo mode and for tests.
 *
 * It describes A&M's own account: consulting for German trade businesses with
 * ten to fifty employees. The evidence set is deliberately mixed — one approved
 * fact, one unapproved item and one case study cleared for advertising — so
 * that `buildContext` is exercised on the filtering it is supposed to do rather
 * than on a uniformly happy input.
 *
 * It contains no personal data: the testimonial carries a role and a company,
 * never a name, because `buildContext` drops author names anyway.
 */
export function fixtureContextBundle(): AiContextBundle {
  return aiContextBundleSchema.parse({
    brand: {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'A&M Beratung',
      positioning:
        'A&M begleitet inhabergeführte Handwerks- und Bauunternehmen mit zehn bis fünfzig Mitarbeitenden bei Mitarbeitergewinnung und Ablauforganisation. Kein Employer Branding, sondern Ablaufberatung, die im Betriebsalltag standhält.',
      toneOfVoice:
        'Nüchtern, kollegial und in der Sie-Form. Kurze Hauptsätze, Handwerksvokabular statt Beratersprache, keine Superlative, keine Ausrufezeichen und keine Versprechen ohne Beleg.',
      avoidTerms: ['günstig', 'billig', 'garantiert', 'revolutionär', 'Fachkräftemangel'],
      preferredTerms: ['Betrieb', 'Kolonne', 'Ablauf', 'Potenzialanalyse', 'Erstkontakt'],
      logoAssetPath: null,
    },
    audiences: [
      {
        id: '22222222-2222-4222-8222-222222222222',
        name: 'Inhaber Handwerk 10–50 Mitarbeitende',
        description:
          'Inhaberinnen, Inhaber und Betriebsleitungen von Elektro-, Sanitär-, Dach- und Ausbaubetrieben in Deutschland. Sie entscheiden selbst, lesen mobil und meist abends, und sind gegenüber Personalanbietern vorbelastet.',
        companySize: '10–50 Mitarbeitende',
        industries: ['Elektro', 'Sanitär und Heizung', 'Dach', 'Ausbau und Trockenbau'],
        roles: ['Inhaberin', 'Inhaber', 'Betriebsleitung', 'Meisterin', 'Meister'],
        painPoints: [
          'Termine verschieben sich, weil Kolonnen unterbesetzt ausrücken',
          'Bewerbungen brechen vor dem Lebenslauf-Upload ab',
          'Vermittlungsprovisionen belasten die Kalkulation dauerhaft',
        ],
        buyingTriggers: [
          'Ein erfahrener Mitarbeiter kündigt',
          'Ein Großauftrag steht an, die Mannschaft reicht nicht',
        ],
        objections: [
          'Wir haben schon alles probiert',
          'Wir können nicht mehr Lohn zahlen',
          'Dafür haben wir im Tagesgeschäft keine Zeit',
        ],
      },
    ],
    services: [
      {
        id: '33333333-3333-4333-8333-333333333333',
        name: 'Ablaufberatung Mitarbeitergewinnung',
        description:
          'Aufbau eines eigenen Bewerbungswegs im Betrieb: Erstkontakt, Rückmeldung, Kurzgespräch und Einstellungsentscheidung als durchgängiger Ablauf.',
      },
    ],
    offers: [
      {
        id: '44444444-4444-4444-8444-444444444444',
        name: 'Potenzialanalyse Mitarbeitergewinnung',
        description:
          'Kostenloser Einstieg: wenige Fragen zur Personalsituation, anschließend eine Einschätzung des Bewerbungsablaufs und ein kurzes Gespräch.',
      },
    ],
    evidence: [
      {
        id: '55555555-5555-4555-8555-555555555555',
        kind: 'CASE_STUDY',
        statement:
          'Ein Elektrotechnik-Betrieb aus dem Sauerland hat seinen Erstkontakt auf Rückmeldung am selben Tag und ein kurzes Gespräch statt eines Formulars umgestellt.',
        source: 'case-study/elektrotechnik-sauerland',
        approved: true,
        approvedAt: '2026-02-11T09:00:00+00:00',
        validUntil: null,
        numericValue: null,
        numericUnit: null,
      },
      {
        id: '66666666-6666-4666-8666-666666666666',
        kind: 'HISTORICAL_PERFORMANCE',
        statement:
          'Mehrstufige Formulare erzielten in bisherigen Kampagnen mehr terminierte Gespräche als reine Landingpages; die Datenlage ist noch nicht ausgereift.',
        source: 'learning-card/mehrstufiges-formular',
        approved: true,
        approvedAt: '2026-03-02T09:00:00+00:00',
        validUntil: null,
        numericValue: null,
        numericUnit: null,
      },
      {
        id: '77777777-7777-4777-8777-777777777777',
        kind: 'APPROVED_STATISTIC',
        statement: 'Interne Auswertung zur Reaktionszeit, Freigabe steht noch aus.',
        source: 'intern/reaktionszeit-auswertung',
        approved: false,
        approvedAt: null,
        validUntil: null,
        numericValue: null,
        numericUnit: null,
      },
    ],
    caseStudies: [
      {
        id: '88888888-8888-4888-8888-888888888888',
        client: 'Elektrotechnik-Betrieb Sauerland',
        industry: 'Elektro',
        challenge:
          'Über zwei Jahre auf Portalen ausgeschrieben, kaum verwertbare Bewerbungen, Touren dauerhaft unterbesetzt.',
        approach:
          'Erstkontakt umgestellt: Rückmeldung am selben Werktag, kurzes Telefonat statt Formular mit Lebenslaufpflicht, Entscheidung innerhalb einer Woche.',
        outcome:
          'Die offenen Stellen konnten ohne Vermittler besetzt werden; der Ablauf wird seither unverändert weitergeführt.',
        metrics: [],
        approved: true,
        usableInAds: true,
      },
    ],
    testimonials: [
      {
        id: '99999999-9999-4999-8999-999999999999',
        quote:
          'Wir haben nicht die Anzeige geändert, sondern den ersten Kontakt. Seitdem sprechen wir wieder mit Leuten, die wirklich anfangen wollen.',
        authorName: 'Betriebsinhaber',
        authorRole: 'Inhaber',
        company: 'Elektrotechnik-Betrieb Sauerland',
        approved: true,
        usableInAds: true,
      },
    ],
    faqs: [
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        question: 'Wie lange dauert die Potenzialanalyse?',
        answer:
          'Die Fragen sind in rund zwei Minuten beantwortet. Die Einschätzung erhalten Sie am folgenden Werktag.',
        approved: true,
      },
    ],
    guardrails: [
      {
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        kind: 'FORBIDDEN_TERM',
        pattern: 'günstig',
        matchMode: 'SUBSTRING',
        reasonDe: 'Preisargumente widersprechen der Positionierung.',
        severity: 'BLOCK',
      },
      {
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        kind: 'FORBIDDEN_CLAIM',
        pattern: 'garantiert',
        matchMode: 'SUBSTRING',
        reasonDe: 'Ergebnisgarantien sind rechtlich und inhaltlich unzulässig.',
        severity: 'BLOCK',
      },
      {
        id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        kind: 'STYLE_RULE',
        pattern: '!',
        matchMode: 'SUBSTRING',
        reasonDe: 'Ausrufezeichen passen nicht zur nüchternen Tonalität.',
        severity: 'WARN',
      },
    ],
    historicalCampaigns: [],
    historicalLearnings: [],
    activeCampaignSummaries: [],
  });
}
