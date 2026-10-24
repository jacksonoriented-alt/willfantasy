# WillFantasy

WillFantasy is a fantasy cricket application built with React, Vite, Express,
Prisma, and PostgreSQL. The current codebase supports account sessions, fantasy
team creation, contest configuration, contest-generation administration, and
admin, finance-ledger, staff-role, and match-publication foundations. Match
fixtures can be synced from CricketLiveAPI; player and playing-XI ingestion,
match scoring, payment processing, paid contest entry, and prize settlement
are not implemented.

## Development

1. Install dependencies from the repository root with `npm install`.
2. Set `DATABASE_URL` in a local, untracked `.env` file. To enable fixture
   sync, also set `CRICKETLIVEAPI_API_KEY` there. Never commit credentials or
   production secrets; the provider key is used only by the backend.
3. Apply the reviewed Prisma migrations to the intended development database
   with `npx prisma migrate deploy`.
4. Start the API with `npm run dev:api` (port 4000).
5. In another terminal, start the frontend with `npm run dev:web` (port 5173).
   Vite proxies `/api` requests to the API.

The migrations remove the former simulated balances, wallet transactions,
sample match/player records, simulated entries, and payout records. The later
admin-foundation migration adds empty wallet, ledger, deposit/withdrawal,
staff-role, audit, and match-publication structures; it does not restore demo
balances or enable financial operations. Use the Admin Console's Match Manager
to sync CricketLiveAPI fixtures. Synced matches remain unpublished and cannot
be used for fantasy teams until player/squad data is integrated and an
administrator publishes a ready match.

## Accounts and teams

Users can register with an email, a permanent fantasy name (up to 30
characters), and a password of at least 12 characters, or sign in with an
existing account. Passwords are hashed using Node's scrypt implementation.
Sessions use random opaque tokens stored as hashes in the database and sent in
HTTP-only, same-site cookies. Sessions expire after 14 days; signing out revokes
the current token. Registration and login are rate-limited in each API process;
the limiter is not shared between instances and should not be treated as a
distributed abuse-prevention control.

Each match supports up to 25 saved teams per user. Teams are numbered
automatically and cannot be deleted; saved lineups can be edited until they
have contest entries. Team creation requires match/player data to be loaded
from a legitimate data source.

## Contests

Contest creation is restricted to administrator accounts. Set `ADMIN_EMAILS`
in the API environment to a comma-separated list of administrator email
addresses, or assign the database-backed `ADMIN` role. Use
`SUPER_ADMIN_EMAILS` only for designated super-administrator accounts. If
neither configuration grants a role, no account can administer contests.

The admin Contest Engine panel can pause/resume automatic generation, run a
generation cycle, review generation history and contest accounting, and edit
templates or create disabled templates. Templates configure entry fees in
paise, capacity, format, payout percentages, commission, match eligibility,
minimum entries, and match time windows. The initial migration seeds six
contest templates. Contest values shown in the lobby are projections only:
the API does not accept entries, charge fees, process refunds, or settle
payouts.

The Admin Console reports records currently stored in the database, manages
existing user accounts and registered cash-agent accounts, exposes deposit and
withdrawal review queues, and allows match publication controls. Administrative
changes are written to a SHA-256 hash-chained audit log. Cash agents can claim,
reject with a reason, or escalate a deposit request; they cannot approve or
credit one. Agent accounts must first register as ordinary users, then an
administrator can assign the cash-agent role. The dashboard uses only recorded
values: approved deposits are reported separately from pending requests,
wallet liabilities are not profit, and net profit is recorded platform
commission less recorded expenses. Contest entry fees and refunds are shown
separately. The accounting report is not a substitute for a reviewed ledger or
professional accounting advice.

Wallet and request tables are empty until a verified payment provider is
integrated. The wallet and request-history screens are read-only; deposit and
withdrawal submission APIs return `503`, and there is no deposit-approval,
wallet-credit, payout, or paid-contest-entry API. No provider credentials,
receiving instructions, or private payment evidence are configured. INR values
use paise; USDT values are stored in micro-USDT. Currency conversion and
Binance integration are not implemented.

Public fixtures are filtered to require explicit administrator publication,
provider readiness, and two populated participant squads. Set
`CRICKETLIVEAPI_API_KEY` in the API environment to enable manual fixture sync.
Imported fixtures stay unpublished until explicitly approved. Player and
playing-XI response mappings are not yet implemented, so fixture imports alone
do not make matches ready for public fantasy use. Contest generation and
publication also ignore unpublished or unready matches. Disabling or archiving
a match does not delete its teams, contests, or financial records.

Before implementing real-money features, review jurisdiction-specific laws
and restrictions, age and identity verification, payment-provider rules,
taxes, and platform policies. Do not accept real-money play until the required
payment, scoring, and compliance integrations have been implemented and
reviewed.

In production, set `NODE_ENV=production` and configure `WEB_ORIGINS` (or
`WEB_ORIGIN`) to the exact allowed frontend origin(s), comma-separated when
there are multiple. Production cookies are marked `Secure`. Review and apply
pending migrations in the intended environment before starting a release.

## Checks

- Backend type check: `npx tsc --noEmit`
- Contest financial unit tests: `npx tsx --test server/src/contest-engine.test.ts`
- CricketLiveAPI fixture contract tests: `npx tsx --test server/src/cricketliveapi.test.ts`
- Admin accounting unit tests: `npx tsx --test server/src/admin-foundation.test.ts`
- API integration test (only against an isolated development database): run the
  API with
  `ADMIN_EMAILS=contest-engine-admin@integration.invalid SUPER_ADMIN_EMAILS=contest-engine-superadmin@integration.invalid npm run dev:api`,
  then run
  `RUN_CONTEST_INTEGRATION_TESTS=1 npx tsx --test server/src/contest-engine.integration.test.ts`.
  The test creates and cleans its own fixtures, including audit-chain records.
- Frontend lint: `cd apps/web && npm run lint`
- Frontend production build: `cd apps/web && npm run build`
- API health check: `curl -s http://localhost:4000/api/health`
