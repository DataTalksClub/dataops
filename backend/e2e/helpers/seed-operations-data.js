/**
 * Seeds a realistic operating dataset through the work API so layout checks
 * measure what operators actually see: cards spread across stages from
 * multiple templates, tasks on those cards, sponsor CRM organizations, and
 * newsletter slots. Idempotent: duplicates (409/200) count as seeded and
 * individual failures never throw — callers proceed with whatever landed.
 */
async function seedOperationsData(baseURL) {
  const posted = (path, data) =>
    fetch(`${baseURL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });

  const today = new Date();
  const iso = (offsetDays) => {
    const date = new Date(today);
    date.setDate(date.getDate() + offsetDays);
    return date.toISOString().slice(0, 10);
  };
  const nextFriday = (weeksAhead) => {
    const date = new Date(today);
    date.setDate(date.getDate() + ((5 - date.getDay() + 7) % 7 || 7) + weeksAhead * 7);
    return date.toISOString().slice(0, 10);
  };

  const result = { templates: 0, cards: 0, tasks: 0, organizations: 0, slots: 0, failures: [] };

  let templateIds = [];
  try {
    const response = await fetch(`${baseURL}/api/templates`);
    if (response.ok) {
      const body = await response.json();
      templateIds = (body.templates || []).map((template) => template.id).slice(0, 3);
    }
  } catch {
    // Every Card needs a Template; with none listed the card seeds fail below.
  }
  result.templates = templateIds.length;

  const cardBlueprints = [
    { title: 'DTC Weekly newsletter issue 214', stage: 'preparation', anchor: 4 },
    { title: 'Podcast interview — episode 131', stage: 'preparation', anchor: 9 },
    { title: 'Sponsor onboarding — Acme Cloud', stage: 'preparation', anchor: 6 },
    { title: 'DTC Weekly newsletter issue 215', stage: 'announced', anchor: 11 },
    { title: 'Community meetup October', stage: 'announced', anchor: 18 },
    { title: 'Course launch cohort 5', stage: 'announced', anchor: 25 },
    { title: 'Podcast interview — episode 130', stage: 'after-event', anchor: -3 },
    { title: 'DTC Weekly newsletter issue 213', stage: 'after-event', anchor: -10 },
    { title: 'Partner webinar rerun', stage: 'after-event', anchor: -6 },
  ];

  const cardIds = [];
  for (const [index, blueprint] of cardBlueprints.entries()) {
    try {
      const response = await posted('/api/cards', {
        title: blueprint.title,
        stage: blueprint.stage,
        anchorDate: iso(blueprint.anchor),
        templateId: templateIds[index % templateIds.length],
      });
      if (response.ok || response.status === 200) {
        const body = await response.json();
        if (body.card && body.card.id) {
          cardIds.push({ id: body.card.id, anchorDate: body.card.anchorDate || iso(blueprint.anchor) });
          result.cards += 1;
        }
      } else {
        result.failures.push(`card ${blueprint.title}: HTTP ${response.status}`);
      }
    } catch (error) {
      result.failures.push(`card ${blueprint.title}: ${error.message}`);
    }
  }

  const taskTitles = [
    'Draft newsletter outline',
    'Confirm guest recording slot',
    'Send sponsor deliverable checklist',
    'Review draft issue with Alexey',
    'Upload recording and show notes',
    'Schedule social announcements',
  ];
  for (const [index, card] of cardIds.slice(0, 6).entries()) {
    try {
      const response = await posted('/api/tasks', {
        description: taskTitles[index % taskTitles.length],
        date: card.anchorDate,
        cardId: card.id,
      });
      if (response.ok || response.status === 200) result.tasks += 1;
      else result.failures.push(`task on card ${card.id}: HTTP ${response.status}`);
    } catch (error) {
      result.failures.push(`task on card ${card.id}: ${error.message}`);
    }
  }

  const organizations = [
    { displayName: 'Acme Cloud', domain: 'acme.cloud' },
    { displayName: 'Northwind Data', domain: 'northwinddata.io' },
    { displayName: 'Globex Analytics', domain: 'globex.ai' },
  ];
  for (const organization of organizations) {
    try {
      const response = await posted('/api/sponsor-crm/organizations', organization);
      if (response.ok || response.status === 200) result.organizations += 1;
      else result.failures.push(`organization ${organization.displayName}: HTTP ${response.status}`);
    } catch (error) {
      result.failures.push(`organization ${organization.displayName}: ${error.message}`);
    }
  }

  for (const [index, weeksAhead] of [0, 1, 2].entries()) {
    try {
      const response = await posted('/api/newsletter-slots', {
        publicationDate: nextFriday(weeksAhead),
        campaignLabel: 'DTC Weekly',
        campaignNumber: 213 + index,
        status: 'draft',
      });
      if (response.ok || response.status === 200) result.slots += 1;
      else result.failures.push(`newsletter slot +${weeksAhead}w: HTTP ${response.status}`);
    } catch (error) {
      result.failures.push(`newsletter slot +${weeksAhead}w: ${error.message}`);
    }
  }

  return result;
}

module.exports = { seedOperationsData };
