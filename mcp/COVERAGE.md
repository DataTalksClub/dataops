# DataOps MCP parity with pocketshell-mcp

`pocketshell-mcp` exposed 24 DataOps commands via `manifests/dataops.json`
(dispatched to the DataOps CLI). The DataOps MCP replaces them with two
generic tools that hit the same portal API the CLI itself calls, so every
command below keeps working — plus the rest of the CLI surface the manifest
never covered.

| pocketshell-mcp command | kind | portal API family | DataOps MCP tool |
|---|---|---|---|
| tasks/list | read | `GET /api/tasks` | dataops_read |
| tasks/show | read | `GET /api/tasks/:id` | dataops_read |
| tasks/create | write | `POST /api/tasks` | dataops_write |
| tasks/update | write | `PUT /api/tasks/:id` | dataops_write |
| tasks/done | write | `PUT /api/tasks/:id` (waiting: `POST /api/tasks/:id/actions/resolve-done`) | dataops_write |
| tasks/reopen | write | `PUT /api/tasks/:id` | dataops_write |
| tasks/skip | write | `POST /api/tasks/:id/actions/skip` | dataops_write |
| tasks/delete | write | `DELETE /api/tasks/:id` | dataops_write |
| cards/list | read | `GET /api/cards` | dataops_read |
| cards/show | read | `GET /api/cards/:id` | dataops_read |
| cards/create | write | `POST /api/cards` | dataops_write |
| cards/update | write | `PUT /api/cards/:id` | dataops_write |
| cards/park | write | `POST /api/cards/:id/park` | dataops_write |
| cards/resume | write | `POST /api/cards/:id/resume` | dataops_write |
| cards/delete | write | `DELETE /api/cards/:id` | dataops_write |
| templates/list | read | `GET /api/templates` | dataops_read |
| templates/show | read | `GET /api/templates/:id` | dataops_read |
| resources/list | read | `GET /api/resources` | dataops_read |
| users/list | read | `GET /api/users` | dataops_read |
| team/list | read | `GET /api/team-members` | dataops_read |
| calendar/list | read | `GET /api/calendar-items` | dataops_read |
| calendar/get | read | `GET /api/calendar-items/:id` | dataops_read |
| invoices/list | read | `GET /api/bookkeeping/invoices` | dataops_read |
| invoices/detail | read | `GET /api/bookkeeping/invoices/:id` | dataops_read |

All 24 families are inside the `dataops_read`/`dataops_write` route
allowlist (`/api`, `/docs`, `/search`, `/knowledge`; auth/token routes
excluded). `mcp/test/mcp.test.mjs` asserts every family validates.
