import { zh } from './zh'

export const fr = {
  'Run location': 'Exécution',
  'Local server': 'Serveur local',
  'Cloud API': 'API cloud',
  'Context limit (tokens)': 'Limite du contexte (tokens)',
  'Output limit (tokens)': 'Limite de sortie (tokens)',
  'API output parameter': 'Paramètre de sortie API',
  Automatic: 'Automatique',
  'Test image understanding': 'Tester la compréhension des images',
  No: 'Non',
  Yes: 'Oui',
  'Advanced model settings': 'Paramètres avancés du modèle',
  'Tool calling verified.': 'Appels d’outils vérifiés.',
  Local: 'Local',
  Cloud: 'Cloud',
  'Search unavailable for this format': 'Recherche indisponible pour ce format',
  'Analysis unavailable for this format': 'Analyse indisponible pour ce format',
  'Save a copy as XLSX to search, inspect or analyze it.':
    'Enregistrez une copie XLSX pour rechercher, inspecter ou analyser.',
  'Extracted text is available; native inspection and editing are unavailable for this format.':
    'Le texte extrait est disponible ; l’inspection et l’édition natives ne sont pas disponibles pour ce format.',
  'Native analysis supports XLSX, XLSM, CSV, TSV and JSON tables.':
    'L’analyse native prend en charge les tableaux XLSX, XLSM, CSV, TSV et JSON.',
  'Codex output limits are advisory; large tool responses are rejected before execution.':
    'La limite de sortie Codex est indicative ; les réponses d’outils trop grandes sont rejetées avant exécution.',
} satisfies Record<keyof typeof zh, string>
