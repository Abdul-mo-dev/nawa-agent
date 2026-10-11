import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { appBinaryForResources } from '../src/resources'

describe('appBinaryForResources', () => {
  it('finds the app in a custom Windows install directory', () => {
    expect(appBinaryForResources(join('D:\\Apps\\Nawa', 'resources'), 'win32')).toBe(
      join('D:\\Apps\\Nawa', 'Nawa.exe'),
    )
  })

  it('resolves the same binary for the default Windows install directory', () => {
    const localAppData = 'C:\\Users\\test\\AppData\\Local'
    const resources = join(localAppData, 'Programs', 'Nawa', 'resources')
    expect(appBinaryForResources(resources, 'win32')).toBe(
      join(localAppData, 'Programs', 'Nawa', 'Nawa.exe'),
    )
  })

  it('finds the app in a custom macOS bundle location', () => {
    expect(appBinaryForResources(join('/Volumes/Work/Nawa.app/Contents/Resources'), 'darwin')).toBe(
      join('/Volumes/Work/Nawa.app/Contents/MacOS/Nawa'),
    )
  })

  it('finds the app in a custom Linux prefix', () => {
    expect(appBinaryForResources(join('/opt/nawa-custom/resources'), 'linux')).toBe(
      join('/opt/nawa-custom/nawa'),
    )
  })

  it('keeps legacy GenOffice executable discovery explicit', () => {
    expect(
      appBinaryForResources(join('/legacy/GenOffice', 'resources'), 'win32', 'GenOffice'),
    ).toBe(join('/legacy/GenOffice', 'GenOffice.exe'))
  })
})
