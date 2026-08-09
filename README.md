# Massage parlor scheduling system

A small phone-first web app for a family massage parlor: the admin adds and
cancels appointments while taking phone bookings; staff open a URL on their
phones and see the day's schedule update live.

**Status: design phase.** See [DESIGN.md](DESIGN.md) for the full v1 design —
requirements, architecture, API, and data model.

## Stack

- **Frontend** — static HTML/CSS/JS day grid, served from S3 via CloudFront
- **Backend** — AWS Lambda (Node) behind API Gateway, four endpoints
- **Data** — DynamoDB, appointments partitioned by date
- **IaC** — Pulumi (TypeScript)

## Planned layout

```
DESIGN.md     the v1 design document
infra/        Pulumi program (S3, CloudFront, API Gateway, Lambda, DynamoDB)
backend/      Lambda handler code
web/          static frontend (staff view + admin view)
```

## Prerequisites

- Node.js
- Pulumi CLI (logged in)
- AWS CLI with credentials configured

## Deploy (once implemented)

```
cd infra
npm install
pulumi up
```

Outputs the CloudFront URL — staff view at `/`, admin view at `/admin.html`.
