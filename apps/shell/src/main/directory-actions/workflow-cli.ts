import { app } from 'electron';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { createCliRunner, cliErrorMessage, type CliRunner } from '../mcp/cli-runner';
import { conversionSupported } from '../../../../../packages/cli/src/conversion-routes';
import type { DirectoryConversion, DirectoryQuality } from '../../shared/directory-actions-api';
import { regularFile, within } from './file-safety';
import { assertConversionResources } from './assets';
export function directoryCliEntry(): string {
    if (app.isPackaged) {
        const path = join(process.resourcesPath, 'cli', 'genoffice.cjs');
        if (existsSync(path))
            return path;
    }
    let root = app.getAppPath();
    for (let i = 0; i < 7; i++) {
        const path = join(root, 'packages', 'cli', 'dist', 'genoffice.cjs');
        if (existsSync(path))
            return path;
        const parent = dirname(root);
        if (parent === root)
            break;
        root = parent;
    }
    throw new Error('The bundled GenOffice CLI is missing. Run npm run build:all, including @genoffice/cli, and restart Nawa.');
}
function runner(): CliRunner {
    return createCliRunner({ executable: process.execPath, entry: directoryCliEntry() });
}
/** Typed verbs only. Model arguments never become a shell command or arbitrary CLI switches. */
export async function convertWorkflowFile(source: string, target: string, conversion: DirectoryConversion, signal: AbortSignal, network = false, cli = runner()): Promise<string[]> {
    if (!conversionSupported(extname(source), conversion.to) || extname(target).slice(1).toLowerCase() !== conversion.to)
        throw new Error('Unsupported conversion route.');
    await assertConversionResources(source, network);
    const args = ['convert', source, '--to', conversion.to, '--out', target];
    if (conversion.sheet)
        args.push('--sheet', conversion.sheet);
    const result = await cli.run(args, { signal, timeoutMs: 10 * 60 * 1000, cwd: dirname(target) });
    if (!result.ok)
        throw new Error(cliErrorMessage(result));
    if (signal.aborted)
        throw new Error('Conversion cancelled.');
    await regularFile([dirname(target)], target);
    const warnings = (result.json as unknown as {
        warnings?: unknown[];
    })?.warnings ?? [];
    return warnings.map(w => typeof w === 'string' ? w : JSON.stringify(w)).slice(0, 30);
}
export function qualityCommand(file: string): string[] | null {
    switch (extname(file).toLowerCase()) {
        case '.docx': return ['docs', 'check', file];
        case '.xlsx':
        case '.xlsm': return ['sheet', 'check', file];
        case '.pptx': return ['slides', 'audit', file];
        default: return null;
    }
}
export async function reviewWorkflowFile(file: string, images: boolean, signal: AbortSignal, cli = runner()): Promise<DirectoryQuality> {
    const result: DirectoryQuality = { checked: false, summary: '', warnings: [], images: [] };
    const command = qualityCommand(file);
    if (command) {
        const outcome = await cli.run(command, { signal, cwd: dirname(file), timeoutMs: 180000 });
        if (!outcome.ok)
            result.warnings.push(cliErrorMessage(outcome));
        else {
            result.checked = true;
            result.summary = outcome.json && 'summary' in outcome.json ? outcome.json.summary : 'Native check completed.';
            result.detail = JSON.stringify(outcome.json?.detail ?? {}, null, 2).slice(0, 24000);
            const warnings = (outcome.json as unknown as {
                warnings?: unknown[];
            })?.warnings ?? [];
            result.warnings.push(...warnings.map(w => typeof w === 'string' ? w : JSON.stringify(w)).slice(0, 30));
        }
    }
    else
        result.warnings.push('No dedicated correctness-check command for this format.');
    if (signal.aborted)
        throw new Error('Validation cancelled.');
    if (images && !['.csv', '.txt'].includes(extname(file).toLowerCase())) {
        const output = join(dirname(file), 'review-images');
        await mkdir(output, { recursive: true });
        // First-page preview is intentional: never imply that the whole document was visually checked.
        const outcome = await cli.run(['render', file, '--out', output, '--page', '1', '--scale', '1'], { signal, cwd: dirname(file), timeoutMs: 180000 });
        if (!outcome.ok)
            result.warnings.push(`Preview: ${cliErrorMessage(outcome)}`);
        else {
            const files = outcome.json?.detail?.files;
            let total = 0;
            if (Array.isArray(files))
                for (const raw of files.slice(0, 1)) {
                    if (!raw || typeof raw.path !== 'string' || !within(output, raw.path))
                        throw new Error('Invalid native render output.');
                    await regularFile([output], raw.path);
                    if (extname(raw.path).toLowerCase() !== '.png')
                        throw new Error('Renderer did not produce PNG.');
                    const size = (await lstat(raw.path)).size;
                    total += size;
                    if (total > 6 * 1024 * 1024) {
                        result.warnings.push('Preview exceeded 6 MiB; not embedded.');
                        break;
                    }
                    const bytes = await readFile(raw.path);
                    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
                        throw new Error('Invalid PNG preview.');
                    result.images.push({ page: Number(raw.page) || 1, dataUrl: `data:image/png;base64,${bytes.toString('base64')}` });
                }
            if (!result.images.length)
                result.warnings.push('No preview image was returned by the native renderer.');
        }
        result.warnings.push('Rendered preview covers the first page only. The model has not automatically inspected this image.');
    }
    if (signal.aborted)
        throw new Error('Validation cancelled.');
    return result;
}
