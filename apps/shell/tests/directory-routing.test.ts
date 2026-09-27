import { expect, it } from 'vitest'
import { directoryRoute, routedDirectorySkill } from '../src/renderer/src/directory-actions/routing'
import type { AgentSkill } from '@genoffice/agent-core'

// Keep spreadsheets selected: a routing miss would otherwise load MyAgent tools.
const scope = { opened: 'C:\\sample files', files: ['C:\\sample files\\employee-data.xlsx', 'C:\\sample files\\notes.txt'], directories: [] }

it.each([
  'list file in this dir',
  'list files in this dir',
  'list file in this directory',
  'list files in current folder',
  'list all the files in this dir',
  'please show me the files in the current directory',
  'could you list the file names here, please?',
  'LIST  FILE\nIN THIS DIR!!!',
  'show selected files',
  'list filenames',
  'list dirs',
  'list directories in this folder',
  'show me files and folders in this directory',
  'what files are in this dir?',
  'which folders are in the opened directory?',
  'what’s in this folder?',
  'what is in this directory',
  'give me a list of files here',
])('routes a filename-only listing without MyAgent preparation: %s', task => {
  expect(directoryRoute(task, scope)).toMatchObject({ intent: 'metadata', prepareKnowledge: false, maxTurns: 12 })
})

it.each([
  'list files containing Hollie Parker',
  'list file in this dir containing Hollie Parker',
  'list files in this dir and count employees',
  'show files in this folder with overdue invoices',
  'list files and summarize their contents',
  'what is in employee-data.xlsx?',
  'show file contents',
  'list directories mentioned in notes.txt',
])('does not mistake content or combined work for a metadata-only listing: %s', task => {
  expect(directoryRoute(task, scope).intent).not.toBe('metadata')
  expect(directoryRoute(task, scope).prepareKnowledge).toBe(true)
})

const survey = 'C:\\sample files\\Survey data.xlsx', overviewScope = { ...scope, files: [...scope.files, survey] }
it.each([
  'what is Survey data.xlsx about',
  'What does "Survey data.xlsx" contain?',
  'please describe Survey data.xlsx',
  'Could you give me an overview of `Survey data.xlsx`, please?',
  'tell me about Survey data.xlsx',
  'what is in Survey data.xlsx?',
  'summarize the structure of Survey data.xlsx',
  'show me the columns in Survey data.xlsx',
  'what is C:\\sample files\\Survey data.xlsx about?',
])('prepares a named-workbook overview for %s', task => {
  expect(directoryRoute(task, overviewScope)).toMatchObject({ intent: 'overview', target: survey, prepareKnowledge: true })
})
it('uses a sole workbook for deictic overview questions, but does not guess among multiple files', () => {
  expect(directoryRoute("what's this workbook about?", { ...scope, files: [survey] })).toMatchObject({ intent: 'overview', target: survey })
  expect(directoryRoute("what's this workbook about?", overviewScope).intent).not.toBe('overview')
  expect(directoryRoute('what is sales totals.xlsx about', { ...scope, files: ['C:\\sample files\\sales totals.xlsx'] }).intent).toBe('overview')
})
it.each([
  'summarize the survey results in Survey data.xlsx',
  'what is Survey data.xlsx about and how many respondents feel unsafe?',
  'compare Survey data.xlsx and employee-data.xlsx',
  'describe Survey data.xlsx and update its headers',
  'what is unselected.xlsx about',
  'what is notes.txt about',
])('keeps findings, combined work and other files out of the workbook-overview shortcut: %s', task => {
  expect(directoryRoute(task, overviewScope).intent).not.toBe('overview')
})
it('advertises eight focused tools for an overview and retains native/SQL discovery fallbacks', async () => {
  const part = (names: string[]): AgentSkill => ({ id: names[0], systemPrompt: 'General capability guidance', tools: names.map(name => ({ name, description: '', inputSchema: {} })), executeTool: () => ({ output: '{}', summary: 'done' }) })
  const skill = routedDirectorySkill(directoryRoute('what is Survey data.xlsx about', overviewScope), {
    reader: part(['list_directory', 'list_files', 'search_files', 'read_file']), inspection: part(['inspect_file', 'query_file']),
    analytics: part(['discover_datasets']), mutation: part(['update_file']),
    knowledge: part(['discover_knowledge_tools', 'use_knowledge_tool', 'spreadsheet_catalog_search', 'spreadsheet_describe_dataset', 'spreadsheet_query_sql', 'word_read_sections', 'knowledge_search']),
  })
  expect(skill.tools.map(tool => tool.name)).toEqual(['list_directory', 'list_files', 'search_files', 'discover_knowledge_tools', 'use_knowledge_tool', 'spreadsheet_catalog_search', 'spreadsheet_describe_dataset', 'discover_file_tools'])
  expect(skill.systemPrompt).toContain('not respondent findings')
  await skill.executeTool({ id: 'read', name: 'discover_file_tools', input: { capability: 'reading' } })
  expect(skill.tools.some(tool => tool.name === 'inspect_file')).toBe(true)
  await skill.executeTool({ id: 'sql', name: 'discover_file_tools', input: { capability: 'knowledge' } })
  expect(skill.tools.some(tool => tool.name === 'spreadsheet_query_sql')).toBe(true)
})
