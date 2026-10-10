import { zh } from './zh'

export const pl = {
  'Run location': 'Miejsce uruchomienia',
  'Local server': 'Serwer lokalny',
  'Cloud API': 'API w chmurze',
  'Context limit (tokens)': 'Limit kontekstu (tokeny)',
  'Output limit (tokens)': 'Limit wyjścia (tokeny)',
  'API output parameter': 'Parametr wyjścia API',
  Automatic: 'Automatycznie',
  'Test image understanding': 'Testuj rozumienie obrazów',
  No: 'Nie',
  Yes: 'Tak',
  'Advanced model settings': 'Zaawansowane ustawienia modelu',
  'Tool calling verified.': 'Wywołania narzędzi zweryfikowane.',
  Local: 'Lokalnie',
  Cloud: 'Chmura',
  'Search unavailable for this format': 'Wyszukiwanie niedostępne dla tego formatu',
  'Analysis unavailable for this format': 'Analiza niedostępna dla tego formatu',
  'Save a copy as XLSX to search, inspect or analyze it.':
    'Zapisz kopię XLSX, aby wyszukiwać, sprawdzać lub analizować.',
  'Extracted text is available; native inspection and editing are unavailable for this format.':
    'Wyodrębniony tekst jest dostępny; natywne sprawdzanie i edycja są niedostępne dla tego formatu.',
  'Native analysis supports XLSX, XLSM, CSV, TSV and JSON tables.':
    'Natywna analiza obsługuje tabele XLSX, XLSM, CSV, TSV i JSON.',
  'Codex output limits are advisory; large tool responses are rejected before execution.':
    'Limit wyjścia Codex jest orientacyjny; zbyt duże odpowiedzi narzędzi są odrzucane przed wykonaniem.',
} satisfies Record<keyof typeof zh, string>
