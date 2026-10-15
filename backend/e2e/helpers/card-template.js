/**
 * Every Card is instantiated from a Template. Specs whose subject is
 * something else create their Cards from this Template without Tasks, so a
 * new Card starts as empty as the spec expects.
 *
 * One Template is created per request context, and they all share the E2E
 * backend, so each gets a unique name: specs that find a Template row by name
 * must not match the copies other specs and retries left behind.
 */
const templateIds = new WeakMap();

async function emptyTemplateId(request, baseURL = '') {
  if (!templateIds.has(request)) {
    templateIds.set(request, (async () => {
      const response = await request.post(`${baseURL}/__e2e__/template-fixtures`, {
        data: {
          name: `Synthetic empty workflow ${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
          type: 'synthetic-empty',
          sourcePath: 'workflow-templates/synthetic-empty.yaml',
          taskDefinitions: [],
        },
      });
      if (response.status() !== 201) throw new Error(`Empty Template fixture failed: HTTP ${response.status()}`);
      return (await response.json()).template.id;
    })());
  }
  return templateIds.get(request);
}

module.exports = { emptyTemplateId };
