/**
 * Every automation that runs on a schedule or fires on its own, in one
 * hardcoded list. It exists so people can see what runs without them: what it
 * does, when, where, and the settings it reads.
 *
 * The list is deliberately not generic. Each entry names the schedule that
 * infrastructure (or a GitHub workflow) actually declares; a test holds the
 * Lambda schedules to `infra/template.full.yaml` so the two cannot drift.
 *
 * `settings` name workspace settings (`db/workspaceSettings.ts`) that the
 * automation itself reads, so editing one here changes what the job does.
 * Values that are not really configurable get no setting.
 */

export type AutomationSchedule =
  /** A cron expression: EventBridge `cron(M H * * ? *)` or a 5-field GitHub cron, both in UTC. */
  | { kind: 'cron'; expression: string }
  | { kind: 'interval'; minutes: number }
  | { kind: 'event'; trigger: string };

/** Where an automation's last run can be read from, if anywhere. */
export type AutomationRunSource =
  /** Recorded by the job itself (`automations/runs.ts`). */
  | 'recorded'
  /** The knowledge worker's `jobs/<job>/success.json` checkpoint: successes only. */
  | 'knowledge-checkpoint'
  | 'none';

export interface AutomationSettingSpec {
  /** Workspace settings field the automation reads. */
  key: string;
  label: string;
  description: string;
  kind: 'days' | 'day-list';
}

export interface AutomationDefinition {
  id: string;
  name: string;
  description: string;
  /** The runner: a Lambda in the application stack, or a GitHub workflow. */
  runsIn: string;
  /** Logical id of the schedule in `infra/template.full.yaml`, for scheduled Lambdas. */
  infraSchedule?: string;
  schedule: AutomationSchedule;
  runSource: AutomationRunSource;
  /** Where to see its runs when the portal cannot (a GitHub workflow). */
  link?: string;
  settings: AutomationSettingSpec[];
}

const DAILY_JOB = 'Daily job (backend Lambda)';
const DAILY_JOB_SCHEDULE: AutomationSchedule = { kind: 'cron', expression: 'cron(0 8 * * ? *)' };
/** Shared by the sponsor alerts and the email suggestions, which chase on the same days. */
const SPONSOR_REMINDER_SETTINGS: AutomationSettingSpec[] = [
  {
    key: 'sponsorMaterialsReminderDays',
    label: 'Materials reminders',
    description: 'Days before publication to chase missing sponsor materials.',
    kind: 'day-list',
  },
  {
    key: 'sponsorFollowUpDays',
    label: 'Performance follow-up',
    description: 'Days after publication that the performance follow-up is due.',
    kind: 'days',
  },
];
const KNOWLEDGE_REPO_WORKFLOWS = 'https://github.com/DataTalksClub/dataops-knowledge/actions/workflows';

export const AUTOMATIONS: readonly AutomationDefinition[] = Object.freeze([
  {
    id: 'recurring-tasks',
    name: 'Recurring tasks',
    description: 'Creates the Tasks of every active recurring schedule whose cadence matches the day. A schedule date that falls on a Saturday or Sunday in Berlin creates its one Task on the following Monday instead.',
    runsIn: DAILY_JOB,
    infraSchedule: 'BackendFunctionDailyBackendCron',
    schedule: DAILY_JOB_SCHEDULE,
    runSource: 'recorded',
    settings: [],
  },
  {
    id: 'automatic-template-cards',
    name: 'Automatic template Cards',
    description: 'Creates a Card from each Template set to trigger automatically, on the days its schedule matches. Each Template sets its own schedule and lead days. A schedule date on a Saturday or Sunday in Berlin creates its Card on the following Monday, and a Card whose anchor date (schedule date plus lead days) falls on a weekend is anchored on the Monday, its Tasks dated from that Monday.',
    runsIn: DAILY_JOB,
    infraSchedule: 'BackendFunctionDailyBackendCron',
    schedule: DAILY_JOB_SCHEDULE,
    runSource: 'recorded',
    settings: [],
  },
  {
    id: 'newsletter-cards',
    name: 'Newsletter Cards',
    description: 'Creates the Card of each upcoming newsletter issue a set number of days before the issue goes out, earlier when the Template has a Task due further ahead.',
    runsIn: DAILY_JOB,
    infraSchedule: 'BackendFunctionDailyBackendCron',
    schedule: DAILY_JOB_SCHEDULE,
    runSource: 'recorded',
    settings: [{
      key: 'newsletterCardLeadDays',
      label: 'Lead time',
      description: 'Days before the issue date that its Card is created.',
      kind: 'days',
    }],
  },
  {
    id: 'sponsor-booking-alerts',
    name: 'Sponsor booking alerts',
    description: 'Notifies about agreed deals without a primary contact, missing or overdue sponsor materials, incomplete newsletter workflows and due performance follow-ups.',
    runsIn: DAILY_JOB,
    infraSchedule: 'BackendFunctionDailyBackendCron',
    schedule: DAILY_JOB_SCHEDULE,
    runSource: 'recorded',
    settings: SPONSOR_REMINDER_SETTINGS,
  },
  {
    id: 'sponsor-finance-alerts',
    name: 'Sponsor finance alerts',
    description: 'Notifies when a sponsor invoice is missing or due after delivery, a payment is overdue, a deal waits on us, or a payment needs reconciling.',
    runsIn: DAILY_JOB,
    infraSchedule: 'BackendFunctionDailyBackendCron',
    schedule: DAILY_JOB_SCHEDULE,
    runSource: 'recorded',
    settings: [],
  },
  {
    id: 'sponsor-communication-suggestions',
    name: 'Sponsor email suggestions',
    description: 'Drafts sponsor emails for review: booking confirmations, materials reminders, publication-live notes and performance follow-ups.',
    runsIn: DAILY_JOB,
    infraSchedule: 'BackendFunctionDailyBackendCron',
    schedule: DAILY_JOB_SCHEDULE,
    runSource: 'recorded',
    settings: SPONSOR_REMINDER_SETTINGS,
  },
  {
    id: 'execution-export',
    name: 'Execution data export',
    description: 'Exports Cards, Tasks, Templates and the rest of the execution data as a portable archive to the retained archive bucket.',
    runsIn: 'Backend Lambda',
    infraSchedule: 'BackendFunctionDailyBackendExport',
    schedule: { kind: 'cron', expression: 'cron(30 8 * * ? *)' },
    runSource: 'recorded',
    settings: [],
  },
  {
    id: 'dynamo-backup',
    name: 'DynamoDB backup',
    description: 'Dumps every DataOps DynamoDB table to the retained archive bucket.',
    runsIn: 'Backend Lambda',
    infraSchedule: 'BackendFunctionDailyDynamoBackup',
    schedule: { kind: 'cron', expression: 'cron(0 9 * * ? *)' },
    runSource: 'recorded',
    settings: [],
  },
  {
    id: 'knowledge-backup',
    name: 'Knowledge backup',
    description: 'Copies every published knowledge file version to the knowledge backup bucket.',
    runsIn: 'Knowledge worker Lambda',
    infraSchedule: 'KnowledgeWorkerFunction.DailyKnowledgeBackup',
    schedule: { kind: 'cron', expression: 'cron(0 3 * * ? *)' },
    runSource: 'knowledge-checkpoint',
    settings: [],
  },
  {
    id: 'knowledge-mirror',
    name: 'Knowledge mirror to GitHub',
    description: 'Commits the current published knowledge snapshot to the dataops-knowledge repository.',
    runsIn: 'Knowledge worker Lambda',
    infraSchedule: 'KnowledgeWorkerFunction.DailyKnowledgeMirror',
    schedule: { kind: 'cron', expression: 'cron(0 4 * * ? *)' },
    runSource: 'knowledge-checkpoint',
    settings: [],
  },
  {
    id: 'knowledge-publish',
    name: 'Knowledge publish',
    description: 'Validates the knowledge repository and publishes the files that differ from DataOps.',
    runsIn: 'GitHub Actions, dataops-knowledge',
    schedule: { kind: 'event', trigger: 'Push to main' },
    runSource: 'none',
    link: `${KNOWLEDGE_REPO_WORKFLOWS}/validate.yml`,
    settings: [],
  },
  {
    id: 'knowledge-repo-backup',
    name: 'Knowledge repository backup',
    description: 'Zips the knowledge repository and uploads it to S3 when the commit changed since the last backup.',
    runsIn: 'GitHub Actions, dataops-knowledge',
    schedule: { kind: 'cron', expression: '17 3 * * *' },
    runSource: 'none',
    link: `${KNOWLEDGE_REPO_WORKFLOWS}/backup-to-s3.yml`,
    settings: [],
  },
] satisfies AutomationDefinition[]);

export function automationById(id: string): AutomationDefinition | undefined {
  return AUTOMATIONS.find((automation) => automation.id === id);
}
