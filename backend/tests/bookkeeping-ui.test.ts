import { readFileSync } from 'fs';
import path from 'path';
import { describe,it } from 'node:test';
import assert from 'node:assert';
const app=readFileSync(path.join(__dirname,'../src/public/app.js'),'utf8');const html=readFileSync(path.join(__dirname,'../src/pages/index.html'),'utf8');
describe('bookkeeping UI',()=>{it('provides private navigation, ledger states, confirmation, PDF and package controls',()=>{assert.match(html,/href="#\/bookkeeping"/);for(const text of ['No bookkeeping entries','Could not load bookkeeping','Delete bookkeeping entry?','Delete entry','PDF evidence','Create monthly package','missing-evidence warning','Set up business accounts'])assert.ok(app.includes(text),text);assert.match(app,/bookkeeping-delete-dialog/);assert.match(app,/accept="application\/pdf,.pdf"/);});});
