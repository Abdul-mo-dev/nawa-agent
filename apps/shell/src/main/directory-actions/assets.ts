/** Reuses GenOffice's asset discovery, safe path resolver and single-file export.
 * Linked local images are enumerated before approval; bytes are copied only after approval. */
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative } from 'node:path';
import { singleFileImageSources, inlineImagesForSingleFile } from '../../../../html/src/main/single-file-html';
import { resolveSafeRelativeImagePath as htmlImage } from '../../../../html/src/main/asset-lifecycle';
import { extractMarkdownImageSources, rewriteMarkdownImageSources, resolveSafeRelativeImagePath as markdownImage } from '../../../../markdown/src/main/asset-lifecycle';
import { sniffBinaryAssetMime, ASSET_SNIFF_BYTES } from '../../../../html/src/main/asset-mime';
import { regularFile, hashFile, within } from './file-safety';
import type { LinkedImage } from '../../shared/directory-actions-api';
export type { LinkedImage } from '../../shared/directory-actions-api';
const html = (file: string) => ['.html', '.htm'].includes(extname(file).toLowerCase());
const supported = (file: string) => html(file) || ['.md', '.markdown'].includes(extname(file).toLowerCase());
const external = (s: string) => /^(https?:|data:)/i.test(s) || s.startsWith('//');
export async function discoverLinkedImages(file: string, roots: string[]): Promise<LinkedImage[]> {
    if (!supported(file))
        return [];
    const text = await readFile(file, 'utf8');
    const sources = html(file) ? singleFileImageSources(text) : extractMarkdownImageSources(text);
    const images = new Map<string, LinkedImage>();
    let bytes = 0;
    for (const source of sources) {
        if (!source || external(source))
            continue;
        const path = await (html(file) ? htmlImage : markdownImage)(file, source);
        if (!path)
            throw new Error(`Linked image is outside the document's safe directory: ${source}`);
        if (images.has(path))
            continue;
        await regularFile(roots, path);
        bytes += (await lstat(path)).size;
        if (images.size >= 64 || bytes > 64 * 1024 * 1024)
            throw new Error('Linked images exceed the 64-image / 64 MiB workflow budget.');
        images.set(path, { path, hash: await hashFile(path), source });
    }
    return [...images.values()];
}
export async function stageLinkedImages(original: string, copy: string, images: readonly LinkedImage[]): Promise<void> {
    for (const image of images) {
        const target = join(dirname(copy), relative(dirname(original), image.path));
        if (!within(dirname(copy), target))
            throw new Error('Linked image cannot escape the private copy.');
        await mkdir(dirname(target), { recursive: true });
        await copyFile(image.path, target, constants.COPYFILE_EXCL);
        if (await hashFile(target) !== image.hash)
            throw new Error('Linked image changed while copying it.');
    }
}
export async function finalizeWorkflowAssets(file: string, network: boolean): Promise<string[]> {
    if (!supported(file))
        return [];
    await assertConversionResources(file, network);
    const text = await readFile(file, 'utf8'), sources = html(file) ? singleFileImageSources(text) : extractMarkdownImageSources(text);
    if (!network && sources.some(s => /^https?:|^\/\//i.test(s)))
        throw new Error('This result embeds remote images. Approve a new workflow with network access, or request a result without remote images.');
    if (html(file)) {
        const result = await inlineImagesForSingleFile(text, file);
        if (result.skipped.length)
            throw new Error(`Local image references could not be preserved: ${result.skipped.join(', ')}`);
        if (result.inlined)
            await writeFile(file, result.html, 'utf8');
        return result.inlined ? [`Embedded ${result.inlined} local image references using the existing single-file HTML exporter.`] : [];
    }
    const replacements = new Map<string, string>();
    for (const source of sources) {
        if (external(source))
            continue;
        const path = await markdownImage(file, source);
        if (!path)
            throw new Error(`Unsafe or missing Markdown image: ${source}`);
        await regularFile([dirname(file)], path);
        const bytes = await readFile(path), mime = sniffBinaryAssetMime(bytes.subarray(0, ASSET_SNIFF_BYTES)) ?? (extname(path).toLowerCase() === '.svg' ? 'image/svg+xml' : null);
        if (!mime?.startsWith('image/'))
            throw new Error(`Unsupported image data: ${source}`);
        replacements.set(source, `data:${mime};base64,${bytes.toString('base64')}`);
    }
    if (replacements.size)
        await writeFile(file, rewriteMarkdownImageSources(text, replacements), 'utf8');
    return replacements.size ? [`Embedded ${replacements.size} local images so staging cleanup cannot break the published Markdown.`] : [];
}
/** A headless converter is a different process. Reject active/remote source dependencies
 * without explicit network consent, rather than fetching them before save approval. */
export async function assertConversionResources(file: string, network: boolean): Promise<void> {
    if (!supported(file))
        return;
    const text = await readFile(file, 'utf8');
    const sources = html(file) ? singleFileImageSources(text) : extractMarkdownImageSources(text);
    const active = /<\s*(?:script|iframe|object|embed)\b|\bon[a-z]+\s*=/i.test(text);
    const remote = sources.some(s => /^https?:|^\/\//i.test(s)) || /<(?:link|source|video|audio|img)\b[^>]*(?:href|src|srcset)\s*=\s*["']?(?:https?:|\/\/)/i.test(text) || /@import\b/i.test(text);
    if (!network && (active || remote))
        throw new Error('This source contains active HTML or external resources. Request conversion with explicit network permission, or use a self-contained static source.');
    // The existing single-file image helper does not bundle sibling scripts/stylesheets.
    for (const match of text.matchAll(/<(script|link)\b[^>]*(?:src|href)\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
        if (!/^(?:https?:|data:|\/\/|#)/i.test(match[2]!))
            throw new Error('Local linked scripts/stylesheets are not bundled by this workflow. Inline them in the source before conversion.');
    }
}
