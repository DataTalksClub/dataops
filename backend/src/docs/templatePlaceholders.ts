import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RUNTIME_ROOT } from '../runtimePaths';

interface TemplateDocument { path?: string; id?: string; doc_type?: string; }
interface Parser {
  isTemplateDocument(markdown: string, document: TemplateDocument): boolean;
  parseTemplatePlaceholders(markdown: string): { issues: {code: string; message: string}[] };
}
let parser: Promise<Parser> | undefined;
export function templateParser(): Promise<Parser> {
  if (!parser) {
    const root = process.env.FRONTEND_ROOT ? resolve(process.env.FRONTEND_ROOT) : resolve(RUNTIME_ROOT, 'frontend');
    const source = readFileSync(resolve(root, 'src/template-placeholders.js'), 'utf8');
    // Preserve native ESM loading in the CommonJS backend; data URLs also work
    // in the Lambda artifact, where frontend assets have no package.json.
    const nativeImport = new Function('url', 'return import(url)') as (url: string) => Promise<Parser>;
    parser = nativeImport(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  }
  return parser;
}
