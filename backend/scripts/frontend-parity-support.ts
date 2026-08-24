export { getClient } from '../src/db/client';

export {
  TABLE_TASKS,
  TABLE_CARDS,
  TABLE_TEMPLATES,
  TABLE_ARTIFACTS,
  TABLE_ASSISTANT_JOBS,
  TABLE_INTAKE,
  TABLE_NOTIFICATIONS,
  TABLE_SPONSOR_CRM,
} from '../src/db/tableNames';

export { createUserWithId } from '../src/db/users';
export { createBrowserSession } from '../src/db/sessions';
export type { BrowserSessionOptions } from '../src/db/sessions';
