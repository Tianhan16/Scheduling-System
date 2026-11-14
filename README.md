# Zen Reflexology — Scheduling System

A phone-first appointment scheduler built for my family's massage studio —
**in daily production use at the store since August 2026**. The owner books
appointments while on the phone with customers; therapists check their day
from their own phones and see new bookings appear within seconds.

Runs serverless on AWS for roughly **$0/month**.

<p align="center">
  <img src="docs/screenshots/staff-mobile.jpg" width="320" alt="Staff view on a phone: day grid with colored appointment blocks, phone numbers masked">
  <img src="docs/screenshots/staff-dark.jpg" width="320" alt="The same staff view in dark mode">
</p>

<p align="center">
  <img src="docs/screenshots/admin-day.jpg" width="660" alt="Admin day view on desktop with full phone numbers and the roster button">
</p>

<p align="center">
  <img src="docs/screenshots/admin-detail.jpg" width="660" alt="Appointment detail popup with notes, edit and cancel actions">
</p>

*All customer data shown is fictional.*

## Features

- **Live day grid** — therapists as columns, time down the side, bookings as
  color-coded blocks (one color per service). Every phone polls the API and
  reflects changes within ~5 seconds.
- **Two roles, no logins** — the admin page can book, edit, and cancel; the
  staff page is read-only. The split is enforced server-side: the staff
  endpoint accepts no writes and **never sends full phone numbers** (staff
  see `••• 1234`), so privacy doesn't depend on the browser.
- **Daily staff roster** — the admin picks who's working each day and in
  which column order; unset days fall back to a sensible default. Anyone
  with a booking always gets a column, so appointments can never be hidden.
- **Conflict-checked booking** — overlapping appointments are rejected with
  a readable message. Cancellations are soft deletes, so a freed slot is
  instantly rebookable while the store keeps a no-show history.
- **Phone-first UI** — sticky time gutter and therapist names, tap-to-book
  on empty slots, tap any block for full details, native date picker,
  automatic dark mode, and seasonal holiday dressing that turns itself on
  and off by date.

## Architecture

```mermaid
flowchart LR
    P["Phone browser<br/>(admin + staff)"]
    CF["CloudFront"]
    S3["S3<br/>static frontend"]
    L["Lambda<br/>one function, small router"]
    DB[("DynamoDB<br/>single table")]

    P -->|"/*"| CF
    CF --> S3
    P -->|"/api/* (poll)"| CF
    CF --> L
    L --> DB
```

- **Frontend**: vanilla HTML/CSS/JS — no framework, no build step. The file
  you edit is the file that ships.
- **Backend**: one Node.js Lambda behind API Gateway; five routes.
- **Data**: a single DynamoDB table. Appointments are partitioned by date,
  so rendering a day is exactly one query — and the per-day roster record
  lives in the same partition, so it rides along for free.
- **Infrastructure**: everything above is defined in one
  [Pulumi](infra/index.ts) TypeScript program — `pulumi up` creates or
  updates the whole system.

The full design doc — requirements, API, data model, and the reasoning
behind the decisions — is in [DESIGN.md](DESIGN.md).

## Decisions I'd defend in an interview

- **Masking on the server, not in the UI.** Hiding data in the browser is
  furniture; the staff endpoint simply never includes full phone numbers,
  so no client-side trick can reveal them.
- **Soft deletes with a filtered overlap check.** Cancelled bookings stay in
  the table for history but are excluded from conflict checks — the classic
  soft-delete rebooking bug, designed out from day one.
- **Polling over WebSockets.** At one store's scale, a 5-second poll is
  indistinguishable from push, has no connections to drop, and keeps the
  whole system stateless.
- **No caching of static files.** At this traffic level, CDN caching of a
  few KB of HTML/JS buys nothing — turning it off made every deploy visible
  on the next refresh.

## Running it locally

```
node dev-server.mjs        # serves web/ on localhost:4173
```

The dev server proxies `/api/*` to a deployed backend. The production URL is
deliberately not in this repo (it's a real business) — put your own deployed
URL in a `.api-url` file next to the script, or set `SCHEDULE_API`.

## Deploying your own

Prerequisites: an AWS account, the Pulumi CLI, Node.js.

```
cd infra
npm install
pulumi up
```

That creates the table, Lambda, API, bucket, and CDN, seeds the service menu
and staff list (edit `seedConfig` in [infra/index.ts](infra/index.ts)), and
prints the URL of your copy.
