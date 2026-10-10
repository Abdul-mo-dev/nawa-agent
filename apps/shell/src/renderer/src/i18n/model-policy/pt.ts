import { zh } from './zh'

export const pt = {
  'Run location': 'Local de execução',
  'Local server': 'Servidor local',
  'Cloud API': 'API na nuvem',
  'Context limit (tokens)': 'Limite de contexto (tokens)',
  'Output limit (tokens)': 'Limite de saída (tokens)',
  'API output parameter': 'Parâmetro de saída da API',
  Automatic: 'Automático',
  'Test image understanding': 'Testar compreensão de imagens',
  No: 'Não',
  Yes: 'Sim',
  'Advanced model settings': 'Configurações avançadas do modelo',
  'Tool calling verified.': 'Chamadas de ferramentas verificadas.',
  Local: 'Local',
  Cloud: 'Nuvem',
  'Search unavailable for this format': 'Pesquisa indisponível para este formato',
  'Analysis unavailable for this format': 'Análise indisponível para este formato',
  'Save a copy as XLSX to search, inspect or analyze it.':
    'Salve uma cópia XLSX para pesquisar, inspecionar ou analisar.',
  'Extracted text is available; native inspection and editing are unavailable for this format.':
    'O texto extraído está disponível; a inspeção e a edição nativas não estão disponíveis para este formato.',
  'Native analysis supports XLSX, XLSM, CSV, TSV and JSON tables.':
    'A análise nativa suporta tabelas XLSX, XLSM, CSV, TSV e JSON.',
  'Codex output limits are advisory; large tool responses are rejected before execution.':
    'O limite de saída do Codex é indicativo; respostas de ferramentas muito grandes são rejeitadas antes da execução.',
} satisfies Record<keyof typeof zh, string>
