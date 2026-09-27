import { expect, it } from 'vitest'
import { directoryRoute } from '../src/renderer/src/directory-actions/routing'

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
