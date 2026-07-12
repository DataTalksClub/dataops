import { after, before, describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import ExcelJS from 'exceljs';
import { parseWorkbook } from '../scripts/import-bookkeeping';

describe('bookkeeping workbook parser',()=>{let dir:string,file:string;before(async()=>{dir=mkdtempSync(path.join(tmpdir(),'bookkeeping-synthetic-'));file=path.join(dir,'synthetic.xlsx');const wb=new ExcelJS.Workbook();
  const modern=[['Date','Paid date','Provider','Description','Amount','Currency','Amount EUR','Statement','Count','Comment','Type','Subtype','Category'],[new Date('2026-01-02T00:00:00Z'),new Date('2026-01-03T00:00:00Z'),'Synthetic Vendor','Synthetic item',12.34,'EUR',12.34,'Synthetic ref',1,'Synthetic comment','expense','service','software'],[]];
  const legacy=[['Sent','Payee','Description','Amount','Currency','Category','Comment'],[44562,'Legacy Synthetic','Legacy item','8.50','USD','services','Synthetic note']];
  for(const year of ['2021','2022','2023','2024','2025'])wb.addWorksheet(year).addRows(legacy);const ws=wb.addWorksheet('2026');ws.addRows(modern);ws.getCell('E2').value={formula:'10+2.34',result:12.34};wb.addWorksheet('Sheet2').addRows(legacy);wb.addWorksheet('taxes').addRows([['Date','Description','Amount','Currency'],[new Date('2026-02-01T00:00:00Z'),'Synthetic tax',25,'EUR'],['bad','Rejected synthetic','invalid','EUR']]);await wb.xlsx.writeFile(file);});after(()=>rmSync(dir,{recursive:true,force:true}));
  it('maps all eight layouts, cached formulas, dates, tax and safe rejection coordinates',async()=>{const result=await parseWorkbook(file);assert.deepEqual(Object.keys(result.counts),['2021','2022','2023','2024','2025','2026','Sheet2','taxes']);assert.equal(result.rows.length,8);assert.equal(result.rows.find(r=>r.sourceType==='xlsx-import'&&r.description==='Synthetic item')?.amount,'12.34');assert.equal(result.rows.find(r=>r.description==='Synthetic tax')?.counterparty,'Tax authority');assert.deepEqual(result.rejected,[{sheet:'taxes',row:3,reason:'INVALID_DATE'}]);assert.ok(result.rows.every(r=>/^[a-f0-9]{64}$/.test(r.sourceKey)));});
});
