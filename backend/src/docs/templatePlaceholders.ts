import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { RUNTIME_ROOT } from '../runtimePaths';

interface TemplateDocument { path?: string; id?: string; doc_type?: string; }
interface Parser {
  documentType(markdown: string): string | undefined;
  isTemplateDocument(markdown: string, document: TemplateDocument): boolean;
  parseTemplatePlaceholders(markdown: string): { issues: {code: string; message: string}[] };
}
let parser: Promise<Parser> | undefined;
export function templateParser(): Promise<Parser> {
  if (!parser) {
    // The parser is a runtime dependency, independent of the portal's optional
    // frontend override. tsx runs from backend/src; deployed code runs from dist.
    const root = basename(RUNTIME_ROOT) === 'src' ? resolve(RUNTIME_ROOT, '../../frontend') : resolve(RUNTIME_ROOT, 'frontend');
    const source = readFileSync(resolve(root, 'src/template-placeholders.js'), 'utf8');
    // Preserve native ESM loading in the CommonJS backend; data URLs also work
    // in the Lambda artifact, where frontend assets have no package.json.
    const nativeImport = new Function('url', 'return import(url)') as (url: string) => Promise<Parser>;
    parser = nativeImport(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  }
  return parser;
}
