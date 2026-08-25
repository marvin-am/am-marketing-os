import { GENERATION_DEFAULTS, type CreativePrinciple } from '@am/domain';
import { pickDeterministic } from '../hash';
import type {
  AngleDistinctnessReview,
  AngleIdeation,
  CampaignPackage,
  ClaimReview,
  ContextSummary,
  CoreMessage,
  CreativeConception,
  CreativeConceptDraft,
  FunnelSpecDraft,
  FunnelStrategy,
  HistoryFraming,
  MetaCopySet,
  MetricExplanation,
  OfferDevelopment,
} from '../prompts/schemas';

/**
 * Deterministic German fixture corpus.
 *
 * Written as if it came out of the real pipeline for A&M's own account:
 * consulting for German trade and construction businesses with roughly ten to
 * fifty employees, acquiring pre-qualification calls through Meta.
 *
 * Two properties are load-bearing:
 *
 * 1. Every value satisfies its step schema, so the fixture pipeline exercises
 *    the same validation path as a live one.
 * 2. The six creative concepts are *genuinely* different — one per mandated
 *    communication principle, with distinct vocabulary, motif, proof and funnel
 *    promise — so `checkCreativeDiversity` passing on them is a real result and
 *    not a threshold tuned around near-duplicates.
 *
 * The copy also obeys the rules the prompts impose on a live model: no invented
 * statistics, no HTML, and motifs that contain no text, logo or UI typography.
 */

const NO_TEXT_RULE =
  'Keine Schrift, keine Buchstaben, keine Zahlen, keine Logos, keine Etiketten, keine Beschriftungen, keine Bildschirme und keine Benutzeroberflächen im Bild.';

/* -------------------------------------------------------------------------- */
/* Creative concepts — one per mandated principle                              */
/* -------------------------------------------------------------------------- */

interface ConceptSeedContent {
  principle: CreativePrinciple;
  name: string;
  visualIdea: string;
  motif: string;
  hypothesis: string;
  rationale: string;
  proofUsed: string | null;
  funnelPromise: string;
  altText: string;
  primaryText: string;
  headline: string;
  description: string;
  callToAction: string;
}

const CONCEPT_CONTENT: readonly ConceptSeedContent[] = [
  {
    principle: 'PROBLEM_PAIN',
    name: 'Leerer Betriebshof am Montag',
    visualIdea:
      'Ein Betriebshof in der blauen Morgenstunde: zwei Transporter stehen unbewegt, das Rolltor der Halle ist halb geöffnet, auf dem feuchten Asphalt spiegelt sich das erste Licht. Niemand im Bild. Die Leere ist das Motiv.',
    motif:
      'Fotorealistische Weitwinkelaufnahme eines menschenleeren Handwerker-Betriebshofs in der blauen Morgenstunde. Zwei geschlossene helle Transporter, ein halb geöffnetes Rolltor, gestapelte Materialpaletten, feuchter Asphalt mit weichen Reflexionen, kühle Farbtemperatur, natürliches Licht, ruhige Bildsprache.',
    hypothesis:
      'Wenn der Engpass als konkreter Montagmorgen gezeigt wird statt als abstraktes Fachkräftethema, erkennt der Inhaber die eigene Lage sofort wieder und startet die Analyse.',
    rationale:
      'Die Zielgruppe erlebt den Mangel nicht als Statistik, sondern als verschobene Termine und Überstunden für die Stammbelegschaft. Ein Bild ohne Menschen macht genau diese Lücke sichtbar, ohne jemanden vorzuführen.',
    proofUsed: null,
    funnelPromise:
      'In zwei Minuten sehen Sie, an welcher Stelle Ihres Bewerbungsablaufs Kandidaten abspringen.',
    altText:
      'Menschenleerer Betriebshof eines Handwerksbetriebs im Morgengrauen mit zwei abgestellten Transportern.',
    primaryText:
      'Montag, kurz vor sieben. Der Auftrag steht, das Material liegt bereit – und die Kolonne rückt zu zweit statt zu viert aus. Jede Woche mit offener Stelle verschiebt den Terminplan weiter nach hinten und belastet die Leute, die geblieben sind. In der kostenlosen Potenzialanalyse gehen wir Ihren Bewerbungsablauf Schritt für Schritt durch und zeigen Ihnen, wo Kandidaten verloren gehen.',
    headline: 'Wenn der Montag mit zwei Mann startet',
    description: 'Kostenlose Potenzialanalyse für Handwerksbetriebe mit 10 bis 50 Mitarbeitenden.',
    callToAction: 'Potenzialanalyse anfordern',
  },
  {
    principle: 'CONCRETE_RESULT',
    name: 'Der letzte Haken am Schlüsselbrett',
    visualIdea:
      'Nahaufnahme eines hölzernen Schlüsselbretts in der Werkstatt. Alle Haken sind belegt, eine Hand hängt gerade den letzten Fahrzeugschlüssel ein. Warmes Abendlicht, geringe Schärfentiefe.',
    motif:
      'Fotorealistische Nahaufnahme eines hölzernen Schlüsselbretts in einer Handwerkerwerkstatt. Alle Haken sind mit Fahrzeugschlüsseln belegt, eine Hand hängt den letzten Schlüssel ein. Warmes seitliches Abendlicht, geringe Schärfentiefe, sichtbare Holzmaserung, ruhiger Hintergrund.',
    hypothesis:
      'Ein greifbares Ergebnisbild wirkt stärker als eine Zahl: Wer die volle Mannschaft vor Augen hat, verbindet die Analyse mit einem Zustand statt mit einem Versprechen.',
    rationale:
      'Der Nutzen einer besetzten Stelle ist im Betrieb sofort spürbar – planbare Touren, weniger Überstunden, ruhigere Stammbelegschaft. Das Schlüsselbrett ist das Alltagsobjekt, an dem sich dieser Zustand ablesen lässt.',
    proofUsed: null,
    funnelPromise:
      'Sie erhalten einen konkreten Ablauf, mit dem eine offene Stelle ohne Vermittler besetzt wird.',
    altText:
      'Hand hängt den letzten Fahrzeugschlüssel an ein vollständig belegtes Schlüsselbrett in einer Werkstatt.',
    primaryText:
      'Eine besetzte Stelle verändert mehr als eine Zeile im Organigramm: Touren werden wieder planbar, Überstunden gehen zurück, die erfahrenen Leute bleiben. Wir bauen mit Ihnen einen Bewerbungsweg, der ohne Zeitarbeit und ohne Vermittlungsprovision funktioniert – und der auch dann noch läuft, wenn die nächste Stelle frei wird. Starten Sie mit der kostenlosen Potenzialanalyse.',
    headline: 'Der letzte Haken ist wieder belegt',
    description: 'Eigener Bewerbungsweg statt Zeitarbeit – Analyse in rund zwei Minuten.',
    callToAction: 'Analyse starten',
  },
  {
    principle: 'COMPARISON_ALTERNATIVE',
    name: 'Bohlensteg oder betonierte Zufahrt',
    visualIdea:
      'Zwei Wege nebeneinander auf einem Baugrundstück: links ein provisorischer Bohlensteg über aufgeweichten Boden, rechts eine fertig betonierte Zufahrt. Gleiche Strecke, unterschiedlicher Untergrund. Erhöhte Perspektive.',
    motif:
      'Fotorealistische erhöhte Aufnahme eines Baugrundstücks mit zwei parallelen Wegen: links ein provisorischer Bohlensteg über aufgeweichtem Lehmboden, rechts eine fertig betonierte Zufahrt. Bedeckter Himmel, weiches diffuses Licht, dokumentarische Bildsprache.',
    hypothesis:
      'Die Gegenüberstellung zweier Beschaffungswege verlagert die Entscheidung von "Kosten heute" auf "Tragfähigkeit über die nächsten Quartale" und qualifiziert damit besser vor.',
    rationale:
      'Inhaber vergleichen Vermittlungsprovision und Eigenaufbau ohnehin im Kopf. Ein Bild aus ihrem eigenen Arbeitsalltag macht den Unterschied zwischen Provisorium und Substanz anschaulich, ohne den Wettbewerb abzuwerten.',
    proofUsed: null,
    funnelPromise:
      'Sie bekommen beide Wege für Ihren Betrieb nebeneinandergestellt – mit Ihren Rahmenbedingungen.',
    altText:
      'Baugrundstück mit einem provisorischen Bohlensteg links und einer betonierten Zufahrt rechts.',
    primaryText:
      'Ein Vermittler bringt Ihnen einen Kandidaten. Ein eigener Bewerbungsweg bringt Ihnen jeden Monat Kandidaten. Der Unterschied zeigt sich selten im ersten Quartal, sondern im dritten – wenn die nächste Stelle frei wird und der Weg schon steht. In der Potenzialanalyse stellen wir beide Varianten für Ihren Betrieb nebeneinander, mit Ihren Rahmenbedingungen statt mit Durchschnittswerten.',
    headline: 'Provision zahlen oder Zufahrt bauen',
    description: 'Vermittlungsprovision oder eigener Bewerbungsweg – der Vergleich für Ihren Betrieb.',
    callToAction: 'Vergleich anfordern',
  },
  {
    principle: 'PROOF_CASE_DATAPOINT',
    name: 'Fallstudie Elektrotechnik',
    visualIdea:
      'Ein aufgeschlagener Ordner auf einer Werkbank, daneben ein Zollstock und eine Tasse. Die Seiten sind leer, der Blick fällt schräg von oben. Ruhige Dokumentationsästhetik statt Werbebild.',
    motif:
      'Fotorealistische Aufsicht auf eine Werkbank aus Massivholz: ein aufgeschlagener Ordner mit unbedruckten Seiten, ein zusammengeklappter Zollstock, eine schlichte Tasse. Weiches Tageslicht von der Seite, dokumentarische Bildsprache, gedeckte Farben, keine Dekoration.',
    hypothesis:
      'Ein freigegebener, nachvollziehbarer Ablauf aus einem vergleichbaren Betrieb überzeugt skeptische Inhaber stärker als ein Nutzenversprechen.',
    rationale:
      'Diese Zielgruppe traut Kollegen mehr als Anbietern. Der Verweis auf eine intern dokumentierte, für Werbung freigegebene Fallstudie liefert Glaubwürdigkeit, ohne eine Kennzahl zu behaupten, die nicht belegt ist.',
    proofUsed:
      'Freigegebene Fallstudie eines Elektrotechnik-Betriebs aus dem Sauerland (intern dokumentiert, für Werbung freigegeben).',
    funnelPromise:
      'Sie sehen den dokumentierten Ablauf eines vergleichbaren Betriebs Schritt für Schritt.',
    altText:
      'Aufgeschlagener Ordner mit leeren Seiten auf einer Werkbank, daneben Zollstock und Tasse.',
    primaryText:
      'Ein Elektrotechnik-Betrieb aus dem Sauerland hatte über zwei Jahre auf Portalen ausgeschrieben. Geändert wurde am Ende nicht die Anzeige, sondern der erste Kontakt: Rückmeldung noch am selben Tag und ein kurzes Gespräch statt eines Formulars mit Lebenslaufpflicht. Die freigegebene Fallstudie zeigt diesen Ablauf Schritt für Schritt – ohne Hochglanz, mit den Punkten, an denen es zunächst hakte.',
    headline: 'Wie ein Elektrobetrieb seine Kolonne füllte',
    description: 'Freigegebene Fallstudie: was der Betrieb an seinem Erstkontakt verändert hat.',
    callToAction: 'Fallstudie ansehen',
  },
  {
    principle: 'OBJECTION_HANDLING',
    name: 'Wir haben schon alles probiert',
    visualIdea:
      'Eine Pinnwand im Meisterbüro, dicht mit übereinander gehefteten, unbedruckten Zetteln belegt. Einige Nadeln liegen lose davor. Frontale Aufnahme, Tageslicht von links.',
    motif:
      'Fotorealistische frontale Aufnahme einer stark belegten Korkpinnwand in einem kleinen Handwerksbüro. Viele überlappende, unbedruckte Papierzettel, einige lose Pinnnadeln auf der Ablage darunter. Tageslicht von links, leicht körnige Textur, nüchterne Bildsprache.',
    hypothesis:
      'Wer den Einwand ausspricht, bevor der Leser ihn denkt, gewinnt Aufmerksamkeit von genau den Betrieben, die bereits mehrere Ansätze hinter sich haben.',
    rationale:
      'Betriebe mit langer Versuchsliste sind schwerer erreichbar, aber deutlich kaufbereiter, sobald sie sich verstanden fühlen. Die überfüllte Pinnwand ist das visuelle Äquivalent dieser Liste.',
    proofUsed: null,
    funnelPromise:
      'Sie prüfen in wenigen Fragen, welcher Baustein in Ihrem bisherigen Vorgehen fehlt.',
    altText: 'Dicht belegte Korkpinnwand mit vielen überlappenden, unbedruckten Zetteln.',
    primaryText:
      'Portale, Aushang im Schaufenster, Prämie für Empfehlungen, ein Versuch mit einer Agentur: Die meisten Betriebe, mit denen wir sprechen, haben genau diese Liste hinter sich. Auffällig oft fehlt derselbe Baustein – ein Weg, auf dem sich jemand in zwei Minuten und ohne Lebenslauf melden kann. Prüfen Sie in der Potenzialanalyse, ob dieser Baustein auch bei Ihnen fehlt.',
    headline: '„Wir haben schon alles probiert.“',
    description: 'Für Betriebe, die Portale, Prämien und Agenturen bereits durch haben.',
    callToAction: 'Kurz prüfen lassen',
  },
  {
    principle: 'CONTRARIAN_INSIGHT',
    name: 'Antwortzeit schlägt Stundenlohn',
    visualIdea:
      'Eine Sanduhr steht auf einem Werkstattregal zwischen Schraubkisten, der obere Teil ist fast leer. Hartes Seitenlicht wirft einen langen Schatten über die Regalbretter.',
    motif:
      'Fotorealistische Nahaufnahme einer schlichten Sanduhr auf einem metallenen Werkstattregal zwischen einfachen Schraubkisten, der obere Glaskörper fast leer. Hartes Seitenlicht, kräftiger langer Schatten, industrielle Umgebung, gedeckte Farben.',
    hypothesis:
      'Die Umkehrung der üblichen Lohndebatte erzeugt Widerspruch und damit Aufmerksamkeit; wer weiterliest, ist offen für eine Prozessänderung statt einer Lohnerhöhung.',
    rationale:
      'Der Reflex der Zielgruppe lautet "wir können nicht mehr zahlen". Der Angle verschiebt den Hebel von den Kosten auf die Reihenfolge im Ablauf und macht damit eine Veränderung denkbar, die nichts kostet.',
    proofUsed: null,
    funnelPromise: 'Sie erfahren, welche Reihenfolge im Erstkontakt den Unterschied macht.',
    altText: 'Fast abgelaufene Sanduhr auf einem Werkstattregal zwischen Schraubkisten.',
    primaryText:
      'In vielen Betrieben wird über Stundenlöhne diskutiert, während Kandidaten längst mit jemand anderem im Gespräch sind. Wer sich am selben Tag zurückmeldet, spricht mit Menschen, die noch niemand angerufen hat. Das kostet keinen Cent mehr Lohn, sondern eine andere Reihenfolge im Ablauf. In der Potenzialanalyse zeigen wir Ihnen, wie diese Reihenfolge im Alltag aussieht.',
    headline: 'Nicht der Stundenlohn entscheidet zuerst',
    description: 'Warum die Reaktionszeit im Bewerbungsablauf schwerer wiegt als der Lohn.',
    callToAction: 'Ablauf ansehen',
  },
];

function conceptKey(index: number): string {
  return `concept_${index + 1}`;
}

export function fixtureConceptDrafts(seed: number): CreativeConceptDraft[] {
  const count = GENERATION_DEFAULTS.creativeConceptCount;
  // The seed rotates which principle opens the set — the six concepts stay the
  // same, their order does not, so two campaigns do not present identically.
  const offset = seed % CONCEPT_CONTENT.length;
  return Array.from({ length: count }, (_, index): CreativeConceptDraft => {
    const content = CONCEPT_CONTENT[(index + offset) % CONCEPT_CONTENT.length]!;
    return {
      key: conceptKey(index),
      name: content.name,
      principle: content.principle,
      visualIdea: content.visualIdea,
      imagePrompt: `${content.motif} ${NO_TEXT_RULE}`,
      hypothesis: content.hypothesis,
      rationale: content.rationale,
      proofUsed: content.proofUsed,
      funnelPromise: content.funnelPromise,
      altText: content.altText,
      aspectRatios: ['1:1', '4:5'],
    };
  });
}

export function fixtureCreativeConception(seed: number): CreativeConception {
  return {
    concepts: fixtureConceptDrafts(seed),
    diversityNotesDe: [
      'Jedes Konzept folgt genau einem der sechs Kommunikationsprinzipien.',
      'Die Motive unterscheiden sich in Ort, Tageszeit und Bildlogik, nicht nur in der Headline.',
      'Nur ein Konzept stützt sich auf einen freigegebenen Proof; die übrigen argumentieren ohne Beleg.',
    ],
  };
}

export function fixtureMetaCopy(seed: number): MetaCopySet {
  const offset = seed % CONCEPT_CONTENT.length;
  return {
    copies: Array.from({ length: GENERATION_DEFAULTS.creativeConceptCount }, (_, index) => {
      const content = CONCEPT_CONTENT[(index + offset) % CONCEPT_CONTENT.length]!;
      return {
        conceptKey: conceptKey(index),
        copy: {
          primaryText: content.primaryText,
          headline: content.headline,
          description: content.description,
          callToAction: content.callToAction,
        },
      };
    }),
  };
}

/* -------------------------------------------------------------------------- */
/* Steps 1–6                                                                   */
/* -------------------------------------------------------------------------- */

export function fixtureContextSummary(seed: number): ContextSummary {
  return {
    brandSummaryDe: `A&M begleitet inhabergeführte Handwerks- und Bauunternehmen mit zehn bis fünfzig Mitarbeitenden bei Mitarbeitergewinnung und Ablauforganisation. Die Positionierung ist bewusst nüchtern: kein Employer-Branding-Vokabular, sondern Ablaufberatung, die im Betriebsalltag funktioniert. ${pickDeterministic(
      [
        'Angesprochen wird die Inhaberebene direkt, sachlich und ohne Superlative.',
        'Die Ansprache richtet sich unmittelbar an die Inhaberebene und verzichtet auf Superlative.',
        'Kommuniziert wird auf Augenhöhe mit der Inhaberebene, sachlich und ohne Werbefloskeln.',
      ],
      seed,
    )}`,
    audienceSummaryDe:
      'Entscheider sind Inhaberinnen und Inhaber sowie Betriebsleitungen im Elektro-, Sanitär-, Dach- und Ausbauhandwerk in Deutschland. Sie treffen Entscheidungen abends oder am Wochenende, lesen mobil und misstrauen Anbietern, die schnelle Ergebnisse versprechen. Der wiederkehrende Schmerz ist nicht die fehlende Anzeige, sondern der verschobene Terminplan und die Überlastung der Stammbelegschaft.',
    offerLandscapeDe:
      'Im Portfolio stehen die kostenlose Potenzialanalyse als Einstieg, ein Benchmark für Betriebe mit laufender Personalsuche sowie ein tiefergehender Audit für Bestandskunden. Für kalte Zielgruppen trägt bislang nur der Einstieg mit niedriger Hürde; alles, was einen Lebenslauf oder eine lange Datenabfrage verlangt, bricht früh ab.',
    approvedFacts: [
      {
        statementDe:
          'Eine für Werbung freigegebene Fallstudie eines Elektrotechnik-Betriebs aus dem Sauerland dokumentiert die Umstellung des Erstkontakts.',
        sourceRef: 'case-study/elektrotechnik-sauerland',
        confidence: 'FACT',
      },
      {
        statementDe:
          'Frühere Kampagnen mit mehrstufigem Formular zeigten eine höhere Terminquote als reine Landingpages; die Datenlage ist noch nicht ausgereift.',
        sourceRef: 'learning-card/mehrstufiges-formular',
        confidence: 'INDICATION',
      },
      {
        statementDe:
          'Eine Rückmeldung am selben Tag verbessert vermutlich die Gesprächsbereitschaft von Kandidaten.',
        sourceRef: null,
        confidence: 'HYPOTHESIS',
      },
    ],
    guardrailNotesDe: [
      'Die Begriffe „günstig“ und „billig“ sind ausgeschlossen und dürfen auch nicht umschrieben werden.',
      'Garantieformulierungen zu Bewerberzahlen oder Besetzungszeiten sind nicht zulässig.',
      'Kennzahlen dürfen nur genannt werden, wenn sie aus freigegebener Evidenz stammen.',
    ],
    openQuestionsDe:
      seed % 2 === 0
        ? [
            'Liegt eine freigegebene Fallstudie aus dem Dachhandwerk vor, um die Branchenbreite zu belegen?',
            'Ist die Rückmeldung am selben Tag im Betriebsalltag der Kundschaft überhaupt zugesagt?',
          ]
        : [
            'Liegt eine freigegebene Fallstudie aus dem Dachhandwerk vor, um die Branchenbreite zu belegen?',
            'Ist die Rückmeldung am selben Tag im Betriebsalltag der Kundschaft überhaupt zugesagt?',
            'Wie weit reicht die Regionalabdeckung für Betriebe außerhalb von Nordrhein-Westfalen?',
          ],
  };
}

export function fixtureHistoryFraming(seed: number): HistoryFraming {
  const extra = pickDeterministic(
    [
      'Unabhängigkeit von Personalvermittlern im Handwerk',
      'Erstkontakt ohne Lebenslauf im Bewerbungsablauf',
      'Planbare Tourenbesetzung trotz offener Stellen',
    ],
    seed,
  );
  return {
    queryTextsDe: [
      'Mitarbeitergewinnung für Handwerksbetriebe ohne Zeitarbeit',
      'Bewerbungsablauf mit kurzer Reaktionszeit statt Anzeigenschaltung',
      'Potenzialanalyse als Einstieg für inhabergeführte Betriebe',
      extra,
    ],
    focusDe:
      'Gesucht werden abgeschlossene Kampagnen der letzten sechs Monate, die denselben Engpass adressiert haben – unabhängig davon, ob sie über ein mehrstufiges Formular oder eine Landingpage liefen. Ziel ist die Abgrenzung des neuen Angles, nicht die Wiederverwendung alter Creatives.',
    exclusionsDe: [
      'Kampagnen zur Kundengewinnung statt zur Mitarbeitergewinnung',
      'Testläufe ohne ausreichende Laufzeit',
    ],
  };
}

export function fixtureAngleIdeation(seed: number): AngleIdeation {
  const angles = [
    {
      name: 'Planbarkeit statt Personalsuche',
      perspective:
        'Der Engpass wird nicht als Personalthema betrachtet, sondern als Frage der Terminplanbarkeit im laufenden Betrieb.',
      rationale:
        'Inhaber messen Schaden in verschobenen Terminen und Überstunden, nicht in unbesetzten Stellen. Wer den Engpass so benennt, trifft die tatsächliche Entscheidungslogik und umgeht die abgenutzte Fachkräftedebatte.',
      keywords: ['Planbarkeit', 'Terminverschiebung', 'Kolonne', 'Überstunden', 'Auftragslage'],
    },
    {
      name: 'Erstkontakt als Nadelöhr',
      perspective:
        'Nicht die Stellenanzeige entscheidet über Bewerbungen, sondern was in den ersten Stunden nach dem Interesse passiert.',
      rationale:
        'Die Betriebe optimieren fast ausschließlich die Anzeige. Der Angle verlagert die Aufmerksamkeit auf den Ablauf danach und öffnet damit einen Hebel, der weder Budget noch Lohnerhöhung braucht.',
      keywords: ['Erstkontakt', 'Reaktionszeit', 'Rückmeldung', 'Bewerbungsablauf', 'Nadelöhr'],
    },
    {
      name: 'Unabhängigkeit von Vermittlern',
      perspective:
        'Der Betrieb wird als Auftraggeber betrachtet, der sich aus der Abhängigkeit von Vermittlungsprovisionen löst.',
      rationale:
        'Provisionen sind eine wiederkehrende Belastung, über die Inhaber ungern sprechen. Der Angle greift ein bestehendes Unbehagen auf, ohne den Wettbewerb direkt anzugreifen.',
      keywords: ['Vermittlung', 'Provision', 'Unabhängigkeit', 'Eigenaufbau', 'Zeitarbeit'],
    },
    {
      name: 'Der Betrieb als Arbeitsplatz, nicht als Marke',
      perspective:
        'Statt Arbeitgebermarke wird der konkrete Arbeitsplatz beschrieben: Fahrzeug, Kolonne, Feierabend, Weg zur Baustelle.',
      rationale:
        'Employer-Branding-Sprache wirkt in dieser Zielgruppe wie Fremdkörper. Konkrete Arbeitsplatzbeschreibungen sind anschlussfähig und lassen sich ohne Agenturbudget umsetzen.',
      keywords: ['Arbeitsplatz', 'Kolonne', 'Fahrzeug', 'Feierabend', 'Alltag'],
    },
  ];
  const recommended = pickDeterministic(angles, seed);
  return {
    angles,
    recommendedAngleName: recommended.name,
    rationaleDe:
      'Empfohlen wird der Angle, der am weitesten von den zuletzt gelaufenen Kampagnen entfernt liegt und gleichzeitig ohne zusätzliche Evidenz auskommt. Damit bleibt die Aussage auch dann tragfähig, wenn die Freigabe weiterer Fallstudien noch aussteht.',
  };
}

export function fixtureAngleDistinctnessReview(_seed: number): AngleDistinctnessReview {
  return {
    differentiationDe:
      'Der vorgeschlagene Angle teilt mit früheren Kampagnen die Zielgruppe, nicht aber die Perspektive: Bisher stand die Sichtbarkeit der Stellenanzeige im Mittelpunkt, jetzt der Ablauf unmittelbar nach dem ersten Interesse. Damit verschiebt sich sowohl das Versprechen als auch die Frage, die im Funnel gestellt wird.',
    sharpenedAngle: null,
    adjustmentsDe: [
      'Den Begriff „Fachkräftemangel“ vermeiden, er verbindet die Kampagne mit den Vorgängern.',
      'Den Erstkontakt konkret benennen, statt allgemein von Prozessoptimierung zu sprechen.',
    ],
  };
}

export function fixtureOfferDevelopment(seed: number): OfferDevelopment {
  return {
    offer: {
      name: 'Potenzialanalyse Mitarbeitergewinnung',
      type: 'POTENTIAL_ANALYSIS',
      valueExchange:
        'Der Betrieb beantwortet wenige Fragen zur aktuellen Personalsituation und erhält im Anschluss eine Einschätzung, an welcher Stelle des Bewerbungsablaufs Kandidaten verloren gehen und welcher Schritt zuerst geändert werden sollte.',
      deliverable:
        'Schriftliche Einschätzung des Bewerbungsablaufs mit priorisierter Reihenfolge der nächsten Schritte, im Anschluss ein Gespräch von rund zwanzig Minuten.',
      effortPromise: pickDeterministic(['2 Minuten', 'rund 2 Minuten'], seed),
      qualificationIntent:
        'Die Fragen trennen Betriebe mit akutem Bedarf und Entscheidungsbefugnis von Interessenten ohne offene Stelle, ohne dass ein Lebenslauf oder eine lange Datenabfrage nötig wird.',
    },
    rationaleDe:
      'Die Potenzialanalyse hält die Einstiegshürde niedrig und liefert dem Vertrieb trotzdem die drei Merkmale, die über die Terminvergabe entscheiden: Betriebsgröße, Anzahl offener Stellen und bisher genutzte Wege. Ein Audit als Einstieg wäre für kalte Zielgruppen zu voraussetzungsvoll.',
    alternativesDe: [
      'Benchmark gegen vergleichbare Betriebe – setzt eigene Kennzahlen voraus, die selten vorliegen.',
      'Direktes Strategiegespräch – höhere Hürde, dafür schnellere Qualifizierung.',
    ],
  };
}

export function fixtureCoreMessage(seed: number): CoreMessage {
  return {
    coreMessageDe:
      'Offene Stellen kosten Sie nicht Bewerber, sondern Termine. Wir zeigen Ihnen, an welcher Stelle Ihres Bewerbungsablaufs die Kandidaten abspringen – und welchen Schritt Sie zuerst ändern sollten.',
    hypothesisDe:
      'Wenn die Botschaft am verschobenen Terminplan ansetzt statt am Fachkräftemangel, fühlen sich Inhaber persönlich angesprochen und starten die Analyse, obwohl sie Personalanbietern grundsätzlich skeptisch gegenüberstehen.',
    proofPointsDe: [
      'Freigegebene Fallstudie eines Elektrotechnik-Betriebs zur Umstellung des Erstkontakts',
      'Wiederkehrendes Muster aus Erstgesprächen: Abbruch vor dem Lebenslauf-Upload',
    ],
    toneNotesDe: pickDeterministic(
      [
        'Nüchtern, kollegial, in der Sie-Form. Kurze Hauptsätze, Handwerksvokabular statt Beratersprache, keine Superlative und keine Ausrufezeichen.',
        'Sachlich und direkt, in der Sie-Form. Konkrete Alltagsbilder aus dem Betrieb, keine Anglizismen, keine Versprechen ohne Beleg.',
      ],
      seed,
    ),
  };
}

/* -------------------------------------------------------------------------- */
/* Steps 9–12                                                                  */
/* -------------------------------------------------------------------------- */

export function fixtureFunnelStrategy(_seed: number): FunnelStrategy {
  return {
    funnels: [
      {
        key: 'funnel_1',
        kind: 'MULTI_STEP_FORM',
        name: 'Potenzialanalyse in fünf Schritten',
        rationale:
          'Ein mehrstufiges Formular verteilt die Qualifizierung auf kurze Einzelfragen und hält damit die Abbruchquote niedrig, während der Vertrieb trotzdem alle Merkmale für die Terminvergabe erhält.',
        hypothesis:
          'Fünf kurze Schritte ohne Lebenslauf führen zu mehr abgeschlossenen Analysen als ein einzelnes langes Formular auf einer Landingpage.',
        promise: 'In rund zwei Minuten zur Einschätzung Ihres Bewerbungsablaufs.',
        qualificationQuestionCount: 5,
        questionOutline: [
          'Wie viele Mitarbeitende hat Ihr Betrieb?',
          'Wie viele Stellen sind aktuell offen?',
          'Welche Wege haben Sie bisher genutzt?',
          'Wie schnell melden Sie sich heute auf eine Bewerbung zurück?',
          'Bis wann soll die Stelle besetzt sein?',
        ],
        resultConcept:
          'Am Ende erscheint eine Einordnung des eigenen Ablaufs mit dem konkret nächsten Schritt sowie das Angebot eines kurzen Gesprächs.',
      },
      {
        key: 'funnel_2',
        kind: 'MULTI_STEP_FORM',
        name: 'Kurzcheck Erstkontakt',
        rationale:
          'Eine verkürzte Variante prüft, ob vier Fragen ohne Zeitangabe zum Besetzungstermin bereits ausreichen, um Termine in vergleichbarer Qualität zu erzeugen.',
        hypothesis:
          'Der Verzicht auf die Frage nach dem Besetzungstermin erhöht die Abschlussquote, ohne die Qualifizierung im Gespräch spürbar zu verschlechtern.',
        promise: 'Vier Fragen zu Ihrem Erstkontakt – Einschätzung sofort im Anschluss.',
        qualificationQuestionCount: 4,
        questionOutline: [
          'Wie viele Mitarbeitende hat Ihr Betrieb?',
          'Wie viele Stellen sind aktuell offen?',
          'Wie schnell melden Sie sich heute auf eine Bewerbung zurück?',
          'Wer entscheidet bei Ihnen über Einstellungen?',
        ],
        resultConcept:
          'Der Abschluss zeigt eine kurze Einordnung des Erstkontakts und führt direkt zur Terminauswahl.',
      },
      {
        key: 'funnel_3',
        kind: 'LANDING_PAGE',
        name: 'Fallstudien-Landingpage',
        rationale:
          'Für das Proof-Konzept ist eine Seite mit ausführlicher Darstellung der freigegebenen Fallstudie sinnvoll, weil die Argumentation Lesezeit braucht, bevor eine Frage gestellt wird.',
        hypothesis:
          'Leser, die zuerst den dokumentierten Ablauf sehen, senden das Formular mit höherer Bereitschaft ab als Leser, die sofort befragt werden.',
        promise: 'Der dokumentierte Ablauf eines vergleichbaren Betriebs – Schritt für Schritt.',
        qualificationQuestionCount: 4,
        questionOutline: [],
        resultConcept:
          'Nach dem Absenden folgt eine Bestätigungsseite mit dem Ablauf des Erstgesprächs und der Zusage einer Rückmeldung.',
      },
    ],
    rationaleDe:
      'Die Mischung testet die Formatfrage sauber: zwei mehrstufige Formulare unterscheiden sich nur in der Zahl der Qualifizierungsfragen, die Landingpage prüft, ob ausführliche Argumentation vor der ersten Frage die Abschlussbereitschaft erhöht.',
  };
}

export function fixtureFunnelSpecDraft(seed: number, funnelKey = 'funnel_1'): FunnelSpecDraft {
  // funnel_3 is the landing-page variant in `fixtureFunnelStrategy`.
  const isLandingPage = funnelKey === 'funnel_3';
  return {
    funnelKey,
    kind: isLandingPage ? 'LANDING_PAGE' : 'MULTI_STEP_FORM',
    headlineDe: isLandingPage
      ? 'Wie ein Elektrobetrieb seinen Erstkontakt umgestellt hat'
      : 'Wo verliert Ihr Bewerbungsablauf die Kandidaten?',
    subheadlineDe: isLandingPage
      ? 'Der dokumentierte Ablauf aus einem Betrieb mit denselben offenen Stellen wie bei Ihnen.'
      : 'Beantworten Sie fünf kurze Fragen und erhalten Sie eine Einschätzung Ihres Ablaufs.',
    sections: [
      {
        kind: 'HERO',
        headlineDe: 'Offene Stellen kosten Termine, nicht nur Bewerber',
        bodyDe:
          'Wenn die Kolonne unterbesetzt ausrückt, verschiebt sich der Terminplan – und mit ihm die Zufriedenheit Ihrer Kundschaft. Die Potenzialanalyse zeigt Ihnen, an welcher Stelle Ihres Ablaufs Kandidaten abspringen.',
        bulletsDe: ['Ohne Lebenslauf', 'Ohne Registrierung', 'Antwort noch am selben Werktag'],
      },
      {
        kind: 'PROBLEM',
        headlineDe: 'Der Ablauf, nicht die Anzeige',
        bodyDe:
          'Die meisten Betriebe verbessern immer wieder die Stellenanzeige. Der Abbruch passiert jedoch meist später: beim Formular, beim Lebenslauf oder in den Tagen bis zur ersten Rückmeldung.',
        bulletsDe: [
          'Formular verlangt Unterlagen, die abends niemand zur Hand hat',
          'Rückmeldung dauert länger als der Wettbewerb braucht',
          'Erstgespräch wird zu spät angeboten',
        ],
      },
      {
        kind: 'PROOF',
        headlineDe: 'Ein Betrieb, der es umgestellt hat',
        bodyDe:
          'Ein Elektrotechnik-Betrieb aus dem Sauerland hat nicht die Anzeige geändert, sondern den ersten Kontakt: Rückmeldung am selben Tag, kurzes Gespräch statt Formular. Die Fallstudie ist intern dokumentiert und für die Verwendung freigegeben.',
        bulletsDe: ['Freigegebene Fallstudie', 'Ablauf Schritt für Schritt dokumentiert'],
      },
      {
        kind: 'CTA',
        headlineDe: 'Jetzt Ablauf prüfen',
        bodyDe:
          'Beantworten Sie die Fragen zur aktuellen Situation Ihres Betriebs. Im Anschluss erhalten Sie eine Einschätzung und ein Angebot für ein kurzes Gespräch.',
        bulletsDe: ['Dauer rund zwei Minuten'],
      },
    ],
    steps: isLandingPage
      ? []
      : [
          {
            key: 'betrieb',
            titleDe: 'Ihr Betrieb',
            helpTextDe: 'Zwei kurze Angaben zur Einordnung.',
            fields: [
              {
                key: 'mitarbeiterzahl',
                labelDe: 'Wie viele Mitarbeitende hat Ihr Betrieb?',
                type: 'SINGLE_SELECT',
                required: true,
                helpTextDe: null,
                options: [
                  { key: 'bis_9', labelDe: 'Bis 9' },
                  { key: 'zehn_bis_24', labelDe: '10 bis 24' },
                  { key: 'fuenfundzwanzig_bis_50', labelDe: '25 bis 50' },
                  { key: 'ueber_50', labelDe: 'Mehr als 50' },
                ],
                qualification: 'SCORING',
                piiClass: 'QUALIFICATION',
              },
              {
                key: 'gewerk',
                labelDe: 'In welchem Gewerk sind Sie tätig?',
                type: 'SINGLE_SELECT',
                required: true,
                helpTextDe: null,
                options: [
                  { key: 'elektro', labelDe: 'Elektro' },
                  { key: 'sanitaer_heizung', labelDe: 'Sanitär und Heizung' },
                  { key: 'dach', labelDe: 'Dach' },
                  { key: 'ausbau', labelDe: 'Ausbau und Trockenbau' },
                  { key: 'sonstiges', labelDe: 'Anderes Gewerk' },
                ],
                qualification: 'ROUTING_ONLY',
                piiClass: 'QUALIFICATION',
              },
            ],
          },
          {
            key: 'bedarf',
            titleDe: 'Ihr aktueller Bedarf',
            helpTextDe: null,
            fields: [
              {
                key: 'offene_stellen',
                labelDe: 'Wie viele Stellen sind aktuell offen?',
                type: 'SINGLE_SELECT',
                required: true,
                helpTextDe: null,
                options: [
                  { key: 'keine', labelDe: 'Aktuell keine' },
                  { key: 'eine', labelDe: 'Eine' },
                  { key: 'zwei_bis_drei', labelDe: 'Zwei bis drei' },
                  { key: 'mehr_als_drei', labelDe: 'Mehr als drei' },
                ],
                qualification: 'DISQUALIFYING',
                piiClass: 'QUALIFICATION',
              },
              {
                key: 'reaktionszeit',
                labelDe: 'Wie schnell melden Sie sich heute auf eine Bewerbung zurück?',
                type: 'SINGLE_SELECT',
                required: true,
                helpTextDe: 'Eine ehrliche Einschätzung genügt.',
                options: [
                  { key: 'gleicher_tag', labelDe: 'Am selben Tag' },
                  { key: 'zwei_bis_drei_tage', labelDe: 'Nach zwei bis drei Tagen' },
                  { key: 'eine_woche', labelDe: 'Nach etwa einer Woche' },
                  { key: 'unterschiedlich', labelDe: 'Sehr unterschiedlich' },
                ],
                qualification: 'SCORING',
                piiClass: 'QUALIFICATION',
              },
            ],
          },
          {
            key: 'kontakt',
            titleDe: 'Wohin dürfen wir die Einschätzung senden?',
            helpTextDe: null,
            fields: [
              {
                key: 'vorname',
                labelDe: 'Vorname',
                type: 'FIRST_NAME',
                required: true,
                helpTextDe: null,
                options: [],
                qualification: 'NONE',
                piiClass: 'PII',
              },
              {
                key: 'nachname',
                labelDe: 'Nachname',
                type: 'LAST_NAME',
                required: true,
                helpTextDe: null,
                options: [],
                qualification: 'NONE',
                piiClass: 'PII',
              },
              {
                key: 'geschaeftliche_mailadresse',
                labelDe: 'Geschäftliche E-Mail-Adresse',
                type: 'EMAIL',
                required: true,
                helpTextDe: 'Wir senden die Einschätzung direkt an diese Adresse.',
                options: [],
                qualification: 'NONE',
                piiClass: 'PII',
              },
              {
                key: 'einwilligung',
                labelDe: 'Ich bin mit der Kontaktaufnahme einverstanden.',
                type: 'CONSENT',
                required: true,
                helpTextDe: null,
                options: [],
                qualification: 'NONE',
                piiClass: 'OPERATIONAL',
              },
            ],
          },
        ],
    ctaLabelDe: pickDeterministic(['Einschätzung anfordern', 'Analyse abschließen'], seed),
    consentTextDe:
      'Mit dem Absenden willigen Sie ein, dass A&M Ihre Angaben zur Bearbeitung Ihrer Anfrage verarbeitet und Sie zur Potenzialanalyse kontaktiert. Sie können diese Einwilligung jederzeit mit Wirkung für die Zukunft widerrufen.',
    resultScreenDe:
      'Vielen Dank. Wir sehen uns Ihre Angaben an und melden uns am nächsten Werktag mit der Einschätzung Ihres Bewerbungsablaufs sowie einem Terminvorschlag für ein kurzes Gespräch.',
  };
}

export function fixtureClaimReview(_seed: number): ClaimReview {
  return {
    claims: [
      {
        text: 'Ein Elektrotechnik-Betrieb aus dem Sauerland hat seinen Erstkontakt umgestellt.',
        evidence: {
          evidenceItemId: null,
          kind: 'CASE_STUDY',
          summary:
            'Intern dokumentierte und für Werbung freigegebene Fallstudie zur Umstellung des Erstkontakts.',
          sourceRef: 'case-study/elektrotechnik-sauerland',
        },
        confidence: 'FACT',
        requiresHypothesisLabel: false,
      },
      {
        text: 'Mehrstufige Formulare erzielen in unseren Kampagnen bislang mehr Termine als reine Landingpages.',
        evidence: {
          evidenceItemId: null,
          kind: 'HISTORICAL_PERFORMANCE',
          summary: 'Beobachtung aus abgeschlossenen Kampagnen; Datenlage noch nicht ausgereift.',
          sourceRef: 'learning-card/mehrstufiges-formular',
        },
        confidence: 'INDICATION',
        requiresHypothesisLabel: false,
      },
      {
        text: 'Eine Rückmeldung am selben Tag erhöht die Gesprächsbereitschaft von Kandidaten.',
        evidence: null,
        confidence: 'HYPOTHESIS',
        requiresHypothesisLabel: true,
      },
    ],
    violations: [],
    risksDe: [
      'Der Angle „Antwortzeit schlägt Stundenlohn“ kann als Kritik am Betrieb gelesen werden; die Tonalität muss kollegial bleiben.',
      'Die Fallstudie stammt aus einem Gewerk; die Übertragbarkeit auf Dach- und Ausbaubetriebe ist nicht belegt.',
    ],
    blocked: false,
  };
}

export function fixtureCampaignPackage(seed: number): CampaignPackage {
  return {
    campaignName: pickDeterministic(
      [
        'Erstkontakt-Offensive Handwerk',
        'Potenzialanalyse Handwerk – Erstkontakt',
        'Handwerk: Ablauf vor Anzeige',
      ],
      seed,
    ),
    audience: {
      name: 'Inhaber Handwerk 10–50 Mitarbeitende',
      description:
        'Inhaberinnen, Inhaber und Betriebsleitungen von Elektro-, Sanitär-, Dach- und Ausbaubetrieben in Deutschland mit zehn bis fünfzig Mitarbeitenden, die aktuell mindestens eine Stelle offen haben und Entscheidungen selbst treffen.',
      audienceSegmentId: null,
      companySizeRange: '10–50 Mitarbeitende',
      industries: ['Elektro', 'Sanitär und Heizung', 'Dach', 'Ausbau und Trockenbau'],
      roles: ['Inhaberin', 'Inhaber', 'Betriebsleitung', 'Meisterin', 'Meister'],
      geo: 'Deutschland',
      painPoints: [
        'Termine verschieben sich, weil Kolonnen unterbesetzt ausrücken',
        'Bewerbungen brechen vor dem Lebenslauf-Upload ab',
        'Vermittlungsprovisionen belasten die Kalkulation dauerhaft',
      ],
      exclusions: ['Betriebe ohne offene Stelle', 'Personaldienstleister und Vermittler'],
    },
    differentiationFromPast:
      'Frühere Kampagnen haben die Sichtbarkeit der Stellenanzeige adressiert und mit Employer-Branding-Sprache gearbeitet. Diese Kampagne setzt beim Ablauf nach dem ersten Interesse an, verzichtet vollständig auf Markenvokabular und stellt den verschobenen Terminplan in den Mittelpunkt. Auch das Angebot wechselt vom Strategiegespräch zur niedrigschwelligen Potenzialanalyse.',
    risks: [
      'Die Zielgruppe ist gegenüber Personalanbietern vorbelastet; ein zu forscher Ton kostet Reichweite.',
      'Nur ein Konzept stützt sich auf einen freigegebenen Proof – fällt dieser weg, trägt die Argumentation ausschließlich auf Hypothesen.',
      'Die Fallstudie stammt aus dem Elektrohandwerk und ist nicht auf alle Gewerke übertragbar.',
    ],
    experimentKind: 'BUNDLED_FUNNEL_TEST',
    experimentHypothesisDe:
      'Ein mehrstufiges Formular mit fünf Fragen erzeugt mehr abgeschlossene Analysen je Session als eine Landingpage mit ausführlicher Argumentation, ohne die Qualifizierung im Erstgespräch zu verschlechtern.',
    testVariableDe: 'Funnel-Format bei identischem Angle und identischem Angebot',
    stopRulesDe: [
      'Abbruch, wenn eine Variante über die gesamte Mindestlaufzeit keine abgeschlossene Analyse erzeugt.',
      'Abbruch, wenn die Guardrail-Metrik die festgelegte Schwelle in zwei aufeinanderfolgenden Auswertungen verfehlt.',
      'Abbruch, wenn sich die Qualifizierungsfragen während der Laufzeit ändern – die Ergebnisse wären nicht vergleichbar.',
    ],
    scaleRulesDe: [
      'Skalierung erst, wenn die Mindestlaufzeit erreicht und die Mindestzahl an Conversions je Arm erfüllt ist.',
      'Skalierung nur auf die Variante mit besserem Wert auf der primären Metrik, nicht auf Basis der Leadzahl allein.',
      'Vor jeder Budgeterhöhung wird geprüft, ob die CRM-Daten der Kohorte bereits ausgereift sind.',
    ],
    primaryMetric: 'cost_per_qualified_vq',
    secondaryMetrics: ['submission_rate', 'cpl', 'vq_scheduled_rate'],
    guardrailMetrics: ['show_rate', 'qualified_vq_rate'],
    budgetRationaleDe:
      'Das Budget wird so bemessen, dass jede Variante die festgelegte Mindestzahl an Conversions innerhalb der Mindestlaufzeit erreichen kann; die konkreten Beträge stammen aus der deterministischen Budgetplanung und nicht aus dieser Einschätzung.',
  };
}

export function fixtureMetricExplanation(_seed: number): MetricExplanation {
  return {
    explanationDe:
      'Die Abweichung entsteht überwiegend im Übergang vom Formularabschluss zum terminierten Gespräch, nicht im Anzeigenteil der Strecke. Die Reichweite verhält sich über beide Varianten hinweg vergleichbar, während sich die Wege erst nach dem Absenden trennen. Das spricht dafür, die Ursache im Nachfassprozess und in der Terminlogik zu suchen und nicht im Creative.',
    drivingFactorsDe: [
      'Der Übergang vom Formularabschluss zur Terminvereinbarung unterscheidet sich zwischen den Varianten.',
      'Die Reichweitenkennzahlen liegen für beide Varianten nah beieinander.',
      'Die CRM-Daten der jüngeren Kohorte sind noch nicht vollständig gereift.',
    ],
    nextHypothesisDe:
      'Wenn die Terminvereinbarung unmittelbar auf der Bestätigungsseite angeboten wird statt per Rückruf, steigt der Anteil der Formularabschlüsse, aus denen ein Gespräch wird.',
    nextTestDe:
      'Beide Varianten unverändert weiterlaufen lassen und ausschließlich die Bestätigungsseite variieren: Terminauswahl direkt auf der Seite gegen Rückrufzusage, bei identischem Formular.',
    caveatDe:
      'Die Aussage stützt sich auf eine Kohorte, deren CRM-Daten noch nicht ausgereift sind; sie ist eine Indikation, kein belegter Zusammenhang.',
  };
}
