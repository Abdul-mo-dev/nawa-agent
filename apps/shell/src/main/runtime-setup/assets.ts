export interface SetupAsset {
  id: string
  name: string
  url: string
  bytes: number
  sha256: string
}
const hf = (repo: string, revision: string, name: string) =>
  `https://huggingface.co/${repo}/resolve/${revision}/${name}?download=true`
export const MODEL_ASSETS: SetupAsset[] = [
  {
    id: 'chat',
    name: 'gemma-4-E4B_q4_0-it.gguf',
    bytes: 5154941280,
    sha256: '676c35070db6dbe52f93e9c864ee0fba4eddea94b9c875d9cb10daff453fbaee',
    url: hf(
      'google/gemma-4-E4B-it-qat-q4_0-gguf',
      '4b4a2c1d584be7264f87aac328a1bc739ce81b6c',
      'gemma-4-E4B_q4_0-it.gguf',
    ),
  },
  {
    id: 'embedding',
    name: 'embeddinggemma-2-Q8_0.gguf',
    bytes: 309855456,
    sha256: '2188ac1deca4b77dffefd603c2776a9d76d9d74ec01841392982ebb840b09135',
    url: hf(
      'ggml-org/embeddinggemma-2-GGUF',
      'bfcd298762cc34d0357ece5ebdd31791a3a374d8',
      'embeddinggemma-2-Q8_0.gguf',
    ),
  },
  {
    id: 'projector',
    name: 'mmproj-embeddinggemma-2-Q8_0.gguf',
    bytes: 554821024,
    sha256: 'c4a8a52691ecef40618438928bdf9e68379b854e24166f292592353db0aab64f',
    url: hf(
      'ggml-org/embeddinggemma-2-GGUF',
      'bfcd298762cc34d0357ece5ebdd31791a3a374d8',
      'mmproj-embeddinggemma-2-Q8_0.gguf',
    ),
  },
  {
    id: 'template',
    name: 'chat_template.jinja',
    bytes: 18569,
    sha256: '0a2c8073c878ab1da004bee933a998606537bbb62016310352c7285c3f01c5b5',
    url: hf(
      'google/gemma-4-E4B-it-qat-q4_0-unquantized',
      '476025a01dbf99361c062bbeca3d6a76bb4c4566',
      'chat_template.jinja',
    ),
  },
]
export function engineAsset(arch: string, backend: 'cuda' | 'cpu' | 'vulkan'): SetupAsset {
  if (backend === 'cuda') {
    if (!['x64', 'arm64'].includes(arch)) throw new Error('CUDA requires Windows x64 or ARM64.')
    const arm = arch === 'arm64'
    const name = `llama-b11541-bin-win-cuda-${arm ? '13.4-arm64' : '12.4-x64'}.zip`
    return {
      id: 'runtime',
      name,
      bytes: arm ? 145612224 : 265224711,
      sha256: arm
        ? '192f64a3516dfac9f872c535f5f4335f399a0009e5a51bc1299c5a5b57fcf40d'
        : 'c5ccdd22e6b11c013efd6a931f93c3707e6fa5ab2f90df5c7d1838785540ece3',
      url: `https://github.com/ggml-org/llama.cpp/releases/download/b11541/${name}`,
    }
  }
  const key = `${backend}-${arch}`
  const data: Record<string, [number, string]> = {
    'cpu-x64': [19518702, 'cdc0535d11038bb337dfba3c15682050eaa9c07aedd0f915b4c09e8a8e8c0a5c'],
    'cpu-arm64': [12343725, '8f112d39c0bde44451ae5878709fdf2196e8d680cb8cb9354ca5332337f0942b'],
    'vulkan-x64': [33464528, '37bba511d120222f13c3d520dd875f739a530cc124e78f7cbce0026de0173d8a'],
    'vulkan-arm64': [26018413, 'c31124767a0c61dc78e021f574dfb2d0b5a8a0837525a72bf0a0dfacc1ffcade'],
  }
  const value = data[key]
  if (!value) throw new Error('Default local runtimes require Windows x64 or ARM64.')
  const name = `llama-b11541-bin-win-${key}.zip`
  return {
    id: 'runtime',
    name,
    bytes: value[0],
    sha256: value[1],
    url: `https://github.com/ggml-org/llama.cpp/releases/download/b11541/${name}`,
  }
}
export function engineAssets(arch: string, backend: 'cuda' | 'cpu' | 'vulkan'): SetupAsset[] {
  const engine = engineAsset(arch, backend)
  if (backend !== 'cuda') return [engine]
  const arm = arch === 'arm64'
  const name = `cudart-llama-bin-win-cuda-${arm ? '13.4-arm64' : '12.4-x64'}.zip`
  return [
    engine,
    {
      id: 'cudaRuntime',
      name,
      bytes: arm ? 153262407 : 391443627,
      sha256: arm
        ? '642dcde8805b3e3165ca710a5443b3b4044b27d96bd3ee3132473988c9bcb774'
        : '8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6',
      url: `https://github.com/ggml-org/llama.cpp/releases/download/b11541/${name}`,
    },
  ]
}
export function officeAsset(arch: string): SetupAsset {
  const arm = arch === 'arm64',
    platform = arm ? 'aarch64' : 'x86_64',
    name = `LibreOffice_26.8.1_Win_${arm ? 'aarch64' : 'x86-64'}.msi`
  return {
    id: 'office',
    name,
    bytes: arm ? 360910848 : 374870016,
    sha256: arm
      ? '97c2173752325af1da3d8731f41c8e09a7c4ad491cf55d9b1069fadb5668e6d7'
      : 'c6298b10cfa1748bcbedad94c62ce771e240e5021bfd6d7a967cd571b04b5312',
    url: `https://downloadarchive.documentfoundation.org/libreoffice/old/26.8.1.1/win/${platform}/LibreOffice_26.8.1.1_Win_${arm ? 'aarch64' : 'x86-64'}.msi`,
  }
}
export function vcAsset(arch: string): SetupAsset {
  const arm = arch === 'arm64'
  const sha256 = arm
    ? 'b70ef586669a620a0a30a1156969c05c6a3831dc8f8bc992da75779d2a92f944'
    : '843068991daaa1f73ad9f6239bce4d0f6a07a51f18c37ea2a867e9beca71295c'
  const uuid = arm
      ? '57eef8ae-a341-46c3-b0bc-c041027b54cd'
      : 'ebdab8e5-1d7b-4d9f-a11b-cbb1720c3b12',
    name = `VC_redist.${arch}.exe`
  return {
    id: 'vc',
    name,
    bytes: arm ? 11870816 : 18731856,
    sha256,
    url: `https://download.visualstudio.microsoft.com/download/pr/${uuid}/${sha256.toUpperCase()}/${name}`,
  }
}
