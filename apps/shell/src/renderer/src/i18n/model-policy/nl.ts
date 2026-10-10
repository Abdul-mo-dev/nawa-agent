import { zh } from './zh'

export const nl = {
  'Run location': 'Uitvoeringslocatie',
  'Local server': 'Lokale server',
  'Cloud API': 'Cloud-API',
  'Context limit (tokens)': 'Contextlimiet (tokens)',
  'Output limit (tokens)': 'Uitvoerlimiet (tokens)',
  'API output parameter': 'API-uitvoerparameter',
  Automatic: 'Automatisch',
  'Test image understanding': 'Beeldbegrip testen',
  No: 'Nee',
  Yes: 'Ja',
  'Advanced model settings': 'Geavanceerde modelinstellingen',
  'Tool calling verified.': 'Toolaanroepen geverifieerd.',
  Local: 'Lokaal',
  Cloud: 'Cloud',
  'Search unavailable for this format': 'Zoeken niet beschikbaar voor dit formaat',
  'Analysis unavailable for this format': 'Analyse niet beschikbaar voor dit formaat',
  'Save a copy as XLSX to search, inspect or analyze it.':
    'Sla een XLSX-kopie op om te zoeken, controleren of analyseren.',
  'Extracted text is available; native inspection and editing are unavailable for this format.':
    'Geëxtraheerde tekst is beschikbaar; dit formaat ondersteunt geen native inspectie of bewerking.',
  'Native analysis supports XLSX, XLSM, CSV, TSV and JSON tables.':
    'Native analyse ondersteunt XLSX-, XLSM-, CSV-, TSV- en JSON-tabellen.',
  'Codex output limits are advisory; large tool responses are rejected before execution.':
    'De Codex-uitvoerlimiet is een richtlijn; te grote toolantwoorden worden vóór uitvoering geweigerd.',
} satisfies Record<keyof typeof zh, string>
