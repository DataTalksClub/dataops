#!/usr/bin/env node
import { run } from "../src/cli.mjs";

process.exitCode = await run(process.argv.slice(2), console);
