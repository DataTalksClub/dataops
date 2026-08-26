import assert from 'node:assert';
import { describe, it } from 'node:test';

import ExcelJS from 'exceljs';

interface DataBarExtensionRule extends ExcelJS.DataBarRuleType {
  x14Id?: string;
}

describe('ExcelJS dependency compatibility', () => {
  // A non-gradient data bar is serialized through the x14 extension, which uses UUID v4.
  it('writes and reads an extended conditional-formatting rule', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Conditional Formatting');
    sheet.getCell('A1').value = 'Label';
    sheet.getCell('B1').value = 'Amount';
    for (let row = 2; row <= 4; row += 1) {
      sheet.getCell(`A${row}`).value = `Item ${row}`;
      sheet.getCell(`B${row}`).value = row * 10;
    }

    const rule: DataBarExtensionRule = {
      type: 'dataBar',
      priority: 1,
      gradient: false,
      minLength: 0,
      maxLength: 100,
      showValue: true,
      border: true,
      negativeBarColorSameAsPositive: false,
      axisPosition: 'auto',
      direction: 'leftToRight',
      cfvo: [{type: 'min'}, {type: 'max'}],
    };
    sheet.addConditionalFormatting({ref: 'B2:B4', rules: [rule]});

    const bytes = await workbook.xlsx.writeBuffer();
    const loadedWorkbook = new ExcelJS.Workbook();
    await loadedWorkbook.xlsx.load(bytes);
    const loadedSheet = loadedWorkbook.getWorksheet('Conditional Formatting');
    assert.ok(loadedSheet);
    assert.strictEqual(loadedSheet.getCell('B2').value, 20);

    const [formatting] = loadedSheet.conditionalFormattings;
    assert.ok(formatting);
    assert.strictEqual(formatting.ref, 'B2:B4');
    const [loadedRule] = formatting.rules as DataBarExtensionRule[];
    assert.ok(loadedRule);
    assert.strictEqual(loadedRule.type, 'dataBar');
    assert.match(
      loadedRule.x14Id ?? '',
      /^\{[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}\}$/,
    );
  });
});
