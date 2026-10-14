import * as auth from "./commands/auth.mjs";
import * as calendar from "./commands/calendar.mjs";
import * as cards from "./commands/cards.mjs";
import * as files from "./commands/files.mjs";
import * as invoices from "./commands/invoices.mjs";
import * as kb from "./commands/kb.mjs";
import * as newsletter from "./commands/newsletter.mjs";
import * as notifications from "./commands/notifications.mjs";
import * as people from "./commands/people.mjs";
import * as raw from "./commands/raw.mjs";
import * as recurring from "./commands/recurring.mjs";
import * as sponsors from "./commands/sponsors.mjs";
import * as tasks from "./commands/tasks.mjs";
import * as templates from "./commands/templates.mjs";
import { EXIT, UsageError, errorPayload, exitCodeFor, hintFor } from "./errors.mjs";

const AUTH_HELP = `dataops login | logout | whoami | tokens

Usage
  dataops login [--url URL] [--label NAME]   Device login: confirm a short code in the browser
  dataops login --service-token-stdin --url URL   Configure an invoice reader service credential
  dataops logout                             Revoke this machine's token and forget it
  dataops whoami                             Who the credential acts as, and the portal
  dataops tokens list                        Your API tokens
  dataops tokens revoke <id>                 Revoke one (a unique prefix is enough)

Non-interactive use: set DATAOPS_TOKEN (and DATAOPS_URL for a non-default portal).
`;

/**
 * Every command family. `commands` maps a subcommand to its handler; a family
 * with `run` takes no subcommand. Order here is the order in `--help`.
 */
export const FAMILIES = {
  tasks: { group: "Work", summary: tasks.summary, help: tasks.help, commands: tasks.commands },
  cards: { group: "Work", summary: cards.summary, help: cards.help, commands: cards.commands },
  templates: { group: "Work", summary: templates.summary, help: templates.help, commands: templates.commands },
  recurring: {
    group: "Work",
    summary: recurring.summary,
    help: recurring.help,
    commands: {
      list: recurring.list,
      create: recurring.create,
      edit: recurring.edit,
      pause: recurring.pause,
      resume: recurring.resume,
      delete: recurring.remove,
      generate: recurring.generate,
    },
  },
  notifications: { group: "Work", summary: notifications.summary, help: notifications.help, commands: notifications.commands },
  files: { group: "Work", summary: files.filesSummary, help: files.filesHelp, commands: files.filesCommands },
  artifacts: { group: "Work", summary: files.artifactsSummary, help: files.artifactsHelp, commands: files.artifactsCommands },
  kb: { group: "Knowledge", summary: kb.summary, help: kb.help, commands: kb.commands },
  newsletter: { group: "Planning", summary: newsletter.summary, help: newsletter.help, commands: newsletter.commands },
  calendar: {
    group: "Planning",
    summary: calendar.summary,
    help: calendar.help,
    commands: {
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
  sponsors: { group: "Finance", summary: sponsors.summary, help: sponsors.help, commands: sponsors.commands },
  invoices: {
    group: "Finance",
    summary: invoices.summary,
    help: invoices.help,
    commands: {
      list: invoices.list,
      detail: invoices.detail,
      document: invoices.document,
      readiness: invoices.readiness,
      edit: invoices.edit,
      verify: invoices.verify,
      confirm: invoices.confirm,
      reject: invoices.reject,
      retry: invoices.retry,
      reextract: invoices.reextract,
      process: invoices.processIntake,
    },
  },
  team: { group: "People", summary: people.teamSummary, help: people.teamHelp, commands: people.teamCommands },
  users: { group: "People", summary: people.usersSummary, help: people.usersHelp, commands: people.usersCommands },
  login: { group: "Account", summary: "Sign in with a device code confirmed in the browser", help: AUTH_HELP, run: auth.login },
  logout: { group: "Account", summary: "Revoke this machine's token", help: AUTH_HELP, run: auth.logout },
  whoami: { group: "Account", summary: "Show who the credential acts as", help: AUTH_HELP, run: auth.whoami },
  tokens: { group: "Account", summary: "List or revoke your API tokens", help: AUTH_HELP, commands: { list: auth.tokensList, revoke: auth.tokensRevoke } },
  api: { group: "Other", summary: raw.summary, help: raw.help, run: raw.call },
};

export function usage() {
  const lines = [
    "dataops - command line client for the DataOps portal (the same API as the web app)",
    "",
    "Usage",
    "  dataops <command> [subcommand] [arguments] [--json]",
    "  dataops <command> --help         Flags and examples for one command",
    "",
  ];
  const width = Math.max(...Object.keys(FAMILIES).map((name) => name.length));
  let group = "";
  for (const [name, family] of Object.entries(FAMILIES)) {
    if (family.group !== group) {
      group = family.group;
      lines.push(group);
    }
    lines.push(`  ${name.padEnd(width)}  ${family.summary}`);
  }
  lines.push(
    "",
    "Global options",
    "  --json        Machine-readable output on stdout (errors as JSON on stderr)",
    "  --url URL     Portal to talk to (default: DATAOPS_URL, the last login, or https://ops.dtcdev.click)",
    "  --help        Help for the command",
    "",
    "Environment",
    "  DATAOPS_TOKEN, DATAOPS_URL   Credential and portal for non-interactive use (agents, CI)",
    "",
    "Exit codes",
    "  0 ok   1 error   2 usage   3 auth/forbidden   4 not found   5 conflict (re-read, retry)",
    "  6 rejected input   7 server or network unavailable",
  );
  return lines.join("\n");
}

// Flags that may repeat; every other flag keeps its last value.
const REPEATABLE = new Set(["query"]);

/**
 * Minimal flag parser: `--flag value`, `--flag=value`, and `--boolean`.
 * Positional arguments collect into `_`; `--` ends flag parsing.
 */
export function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      args._.push(...argv.slice(index + 1));
      break;
    }
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    const [name, inlineValue] = token.slice(2).split(/=(.*)/s);
    const key = name.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    let value;
    if (inlineValue !== undefined) {
      value = inlineValue;
    } else {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        value = true;
      } else {
        value = next;
        index += 1;
      }
    }
    if (REPEATABLE.has(key) && args[key] !== undefined) {
      args[key] = [...(Array.isArray(args[key]) ? args[key] : [args[key]]), value];
    } else {
      args[key] = value;
    }
  }
  return args;
}

export async function run(argv, io = console) {
  const print = (line) => io.log(line);
  const output = { print };
  const [commandName, ...rest] = argv;
  const wantsJson = argv.includes("--json");

  if (!commandName || commandName === "--help" || commandName === "-h") {
    print(usage());
    return EXIT.ok;
  }
  if (commandName === "help") {
    const family = FAMILIES[rest[0]];
    print(family ? family.help : usage());
    return EXIT.ok;
  }

  const family = FAMILIES[commandName];
  if (!family) {
    io.error(`Unknown command: ${commandName}. Run \`dataops --help\`.`);
    return EXIT.usage;
  }

  let handler = family.run;
  let commandArgs = rest;
  if (family.commands) {
    const [subcommandName, ...subRest] = rest;
    if (!subcommandName || subcommandName === "--help" || subcommandName === "-h") {
      print(family.help);
      return subcommandName ? EXIT.ok : EXIT.usage;
    }
    handler = family.commands[subcommandName];
    commandArgs = subRest;
    if (!handler) {
      io.error(`Unknown subcommand: ${commandName} ${subcommandName}. One of: ${Object.keys(family.commands).join(", ")}.`);
      return EXIT.usage;
    }
  }

  const args = parseArgs(commandArgs);
  if (args.help || commandArgs.includes("-h")) {
    print(family.help);
    return EXIT.ok;
  }

  try {
    const result = await handler(args, output);
    if (args.json) print(JSON.stringify(result ?? null, null, 2));
    return EXIT.ok;
  } catch (error) {
    if (wantsJson) {
      io.error(JSON.stringify(errorPayload(error)));
    } else {
      io.error(`error: ${error.message}`);
      const hint = hintFor(error);
      if (hint) io.error(hint);
      if (error instanceof UsageError) io.error(`Run \`dataops ${commandName} --help\` for usage.`);
    }
    return exitCodeFor(error);
  }
}
