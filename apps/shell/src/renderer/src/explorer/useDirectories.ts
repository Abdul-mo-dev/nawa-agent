import { useCallback, useEffect, useRef, useState } from 'react'
import type { FolderListing } from '../../../shared/home-api'
import { pathKey } from './model'
export interface DirectoryState { listing?: FolderListing; loading: boolean; error?: string }
/** Lazy, coalesced reads. A stale response can never replace a newer directory snapshot. */
export function useDirectories() {
  const cache = useRef(new Map<string, DirectoryState>())
  const requests = useRef(new Map<string, Promise<FolderListing | undefined>>())
  const generation = useRef(0)
  const [, paint] = useState(0)
  useEffect(() => () => { generation.current++; requests.current.clear() }, [])
  const load = useCallback((path: string, force = false): Promise<FolderListing | undefined> => {
    const key = pathKey(path), active = requests.current.get(key)
    if (active) return active
    const prior = cache.current.get(key)
    if (!force && prior?.listing) return Promise.resolve(prior.listing)
    const current = generation.current
    cache.current.set(key, { ...prior, error: undefined, loading: true })
    paint(n => n + 1)
    const request = window.aiOffice.listWorkspaceFolder(path).then(listing => {
      if (current !== generation.current) return undefined
      cache.current.set(key, { listing, loading: false, error: listing.missing ? 'This folder is unavailable or cannot be read.' : undefined })
      return listing
    }).catch((error: unknown) => {
      if (current === generation.current) cache.current.set(key, { loading: false, error: error instanceof Error ? error.message : String(error) })
      return undefined
    }).finally(() => {
      if (requests.current.get(key) === request) requests.current.delete(key)
      if (current === generation.current) paint(n => n + 1)
    })
    requests.current.set(key, request)
    return request
  }, [])
  const get = (path: string): DirectoryState | undefined => cache.current.get(pathKey(path))
  const invalidate = useCallback(() => {
    generation.current++
    requests.current.clear()
    cache.current.clear()
    paint(n => n + 1)
  }, [])
  return { get, load, invalidate }
}
