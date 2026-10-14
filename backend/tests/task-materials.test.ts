import { describe, it } from 'node:test';
import assert from 'node:assert';

import { extractTitleLinks, mergeMaterials, normalizeTaskMaterials } from '../src/taskMaterials';

describe('task title links', () => {
  it('moves Markdown and bare links out of an imported title and tidies what is left', () => {
    assert.deepStrictEqual(
      extractTitleLinks('Announce in Slack ( , [template](https://docs.google.com/document/d/x/edit?usp=sharing]))'),
      { title: 'Announce in Slack', materials: [{ url: 'https://docs.google.com/document/d/x/edit', label: 'template' }] },
    );
    assert.deepStrictEqual(
      extractTitleLinks('Adding timecodes - UPDATE https://www.loom.com/share/abc'),
      { title: 'Adding timecodes - UPDATE', materials: [{ url: 'https://www.loom.com/share/abc' }] },
    );
    assert.deepStrictEqual(
      extractTitleLinks('Schedule posts ([old doc](https://docs.google.com/document/d/y/edit)) - when ready'),
      { title: 'Schedule posts - when ready', materials: [{ url: 'https://docs.google.com/document/d/y/edit', label: 'old doc' }] },
    );
  });

  it('leaves plain titles, non-web links and link-only titles alone', () => {
    assert.deepStrictEqual(extractTitleLinks('Plain title'), { title: 'Plain title', materials: [] });
    assert.deepStrictEqual(extractTitleLinks('See [notes](#below)'), { title: 'See [notes](#below)', materials: [] });
    assert.deepStrictEqual(
      extractTitleLinks('[brief](https://docs.google.com/document/d/x/edit)'),
      { title: '[brief](https://docs.google.com/document/d/x/edit)', materials: [] },
    );
  });

  it('keeps one material per destination and validates supplied ones', () => {
    assert.deepStrictEqual(
      mergeMaterials([{ url: 'https://docs.google.com/document/d/x/edit', label: 'A' }], [{ url: 'https://docs.google.com/document/d/x/view' }]),
      [{ url: 'https://docs.google.com/document/d/x/edit', label: 'A' }],
    );
    assert.deepStrictEqual(
      normalizeTaskMaterials([{ url: 'https://luma.com/e?utm_source=x', label: '' }]),
      { materials: [{ url: 'https://luma.com/e' }] },
    );
    assert.ok('error' in normalizeTaskMaterials([{ url: 'javascript:alert(1)' }]));
  });
});
