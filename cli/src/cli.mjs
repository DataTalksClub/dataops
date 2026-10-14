import {
  login,
  logout,
  tokensList,
  tokensRevoke,
  whoami,
} from "./commands/auth.mjs";
import * as recurring from "./commands/recurring.mjs";

import * as invoices from "./commands/invoices.mjs";
import * as calendar from "./commands/calendar.mjs";

const USAGE = `dataops - command line client for the DataOps portal API

Usage
  dataops <command> [subcommand] [options]

Auth
  login [--url URL] [--label NAME]   Sign in with a device code confirmed in the browser
  login --token-stdin [--url URL]      Validate and save an existing user API token from stdin
  login --service-token-stdin --url URL   Configure an invoice reader service token from stdin
  logout                             Revoke this machine's token
  whoami                             Show the signed-in user
  tokens list                        List your API tokens
  tokens revoke <id>                 Revoke a token

Recurring schedules
  recurring list
  recurring create --description D --cron "0 9 * * 1" [--assignee ID] [--paused]
  recurring edit <id> [--description D] [--cron C] [--assignee ID]
  recurring pause <id>
  recurring resume <id>
  recurring delete <id>
  recurring generate [--date YYYY-MM-DD] [--until YYYY-MM-DD]

Invoices (automatic publication after field verification)
  invoices list | readiness
  invoices detail <id> | document <id>
  invoices edit <id> --revision N [--paid-date YYYY-MM-DD] [--amount-eur N]
    [--payment-evidence NOTE] [--counterparty NAME] [--invoice-number REF]
    [--account-context CONTEXT] [--archive-required true|false] [--verified]
    Other fields: transaction-date, description, amount, currency, statement-ref,
    quantity, subtype, period, category, comment, archive-exception-reason.
  invoices verify <id> --revision N   Verify invoice/payment values and publish automatically
  invoices confirm <id> --revision N  Existing explicit verification action
  invoices reject <id> --revision N [--reason NOTE]
  invoices retry <id> --revision N
  invoices reextract <id> --revision N  Re-run extraction on an untouched draft
  invoices process --intake-item-id ID

Calendar activities & operational scheduling
  calendar list [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--type TYPE] [--status STATUS]
  calendar detail <id>
  calendar create --title T --type TYPE [--status STATUS] [--date DATE] [--starts-at ISO --ends-at ISO]
  calendar edit <id> [--title T] [--type TYPE] [--status STATUS] [--date DATE] [--version N]
  calendar delete <id> [--version N]
  calendar day <date>                   Show operational slot availability & full day schedule
  calendar slots [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--all]
  calendar settings [--connection ID] [--show-available-slots true|false] [--filter-busy true|false] ...
  calendar dismiss-alert <fingerprint>
  calendar sync-holidays

Global options
  --url URL     Portal to talk to (default: the profile from the last login)
  --json        Print the raw API response
  --help        Show this help

Environment
  DATAOPS_URL, DATAOPS_TOKEN override the stored profile (use these in CI).
`;

const COMMANDS = {
  login: { run: login },
  logout: { run: logout },
  whoami: { run: whoami },
  tokens: {
    subcommands: { list: tokensList, revoke: tokensRevoke },
  },
  invoices: { subcommands: { list: invoices.list, detail: invoices.detail, document: invoices.document, readiness: invoices.readiness, edit: invoices.edit, verify: invoices.verify, confirm: invoices.confirm, reject: invoices.reject, retry: invoices.retry, reextract: invoices.reextract, process: invoices.processIntake } },
  recurring: {
    subcommands: {
      list: recurring.list,
      create: recurring.create,
      edit: recurring.edit,
      pause: recurring.pause,
      resume: recurring.resume,
      delete: recurring.remove,
      generate: recurring.generate,
    },
  },
  calendar: {
    subcommands: {
      list: calendar.list,
      detail: calendar.detail,
      get: calendar.detail,
      create: calendar.create,
      edit: calendar.edit,
      delete: calendar.remove,
      day: calendar.day,
      schedule: calendar.day,
      slots: calendar.slots,
      overlays: calendar.slots,
      settings: calendar.settings,
      "dismiss-alert": calendar.dismissAlert,
      "sync-holidays": calendar.syncHolidays,
    },
  },
};

/**
 * Minimal flag parser: `--flag value`, `--flag=value`, and `--boolean`.
 * Positional arguments collect into `_`.
 */
export function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    const [name, inlineValue] = token.slice(2).split(/=(.*)/s);
    const key = name.replace(/-([a-z])/g, (_match, letter) =>
      letter.toUpperCase(),
    );
    if (inlineValue !== undefined) {
      args[key] = inlineValue;
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

export async function run(argv, io = console) {
  const print = (line) => io.log(line);
  const output = { print };
  const [commandName, ...rest] = argv;

  if (!commandName || commandName === "help" || commandName === "--help") {
    print(USAGE);
    return 0;
  }

  const command = COMMANDS[commandName];
  if (!command) {
    io.error(`Unknown command: ${commandName}\n`);
    print(USAGE);
    return 1;
  }

  let handler = command.run;
  let commandArgs = rest;
  if (command.subcommands) {
    const [subcommandName, ...subRest] = rest;
    handler = command.subcommands[subcommandName];
    commandArgs = subRest;
    if (!handler) {
      io.error(
        `Usage: dataops ${commandName} <${Object.keys(command.subcommands).join("|")}>`,
      );
      return 1;
    }
  }

  const args = parseArgs(commandArgs);
  if (args.help) {
    print(USAGE);
    return 0;
  }

  try {
    const result = await handler(args, output);
    if (args.json) print(JSON.stringify(result ?? null, null, 2));
    return 0;
  } catch (error) {
    io.error(`error: ${error.message}`);
    return 1;
  }
}
