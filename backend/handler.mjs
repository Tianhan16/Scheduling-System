// Lambda handler for the scheduling API.
// Runs on nodejs20.x, where the AWS SDK v3 is available without bundling.
//
// Routes (see DESIGN.md):
//   GET    /api/day?date=YYYY-MM-DD                    staff  — phones masked
//   GET    /api/admin/day?date=YYYY-MM-DD              admin  — full phones + notes
//   POST   /api/admin/appointments                     admin  — add appointment
//   DELETE /api/admin/appointments/{date}/{id}         admin  — soft cancel

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.TABLE_NAME;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const json = (statusCode, body) => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const toMinutes = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

const isBooked = (appt) => appt.status === "booked";

// Therapists + service menu live in a single config item, seeded by Pulumi.
async function getConfig() {
  const { Item } = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { date: "CONFIG", id: "current" } })
  );
  if (!Item) throw new Error("Config item missing — has seed data been deployed?");
  return Item;
}

// All appointments for one date (any status) — a single partition query.
async function queryDay(date) {
  const { Items } = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "#date = :date",
      ExpressionAttributeNames: { "#date": "date" },
      ExpressionAttributeValues: { ":date": date },
    })
  );
  return Items ?? [];
}

// Shape an appointment for the response. Masking happens HERE, server-side:
// the staff view never receives the full phone number at all (FR-4).
function view(appt, { masked }) {
  const base = {
    id: appt.id,
    therapistId: appt.therapistId,
    serviceId: appt.serviceId,
    customerName: appt.customerName,
    start: appt.start,
    durationMin: appt.durationMin,
    status: appt.status,
  };
  if (masked) {
    const digits = (appt.phone ?? "").replace(/\D/g, "");
    return { ...base, phoneLast4: digits ? digits.slice(-4) : null };
  }
  return { ...base, phone: appt.phone ?? null, notes: appt.notes ?? null };
}

async function getDay(date, { masked }) {
  const [config, appts] = await Promise.all([getConfig(), queryDay(date)]);
  return json(200, {
    date,
    therapists: config.therapists,
    services: config.services,
    // Cancelled appointments are kept in the table (no-show history) but
    // never sent to any client — they simply vanish from the grid.
    appointments: appts.filter(isBooked).map((a) => view(a, { masked })),
  });
}

async function createAppointment(body) {
  const { date, therapistId, serviceId, start } = body;
  const customerName = body.customerName?.trim();
  const phone = body.phone?.trim();

  if (!date || !DATE_RE.test(date)) return json(400, { message: "date must be YYYY-MM-DD" });
  if (!start || !TIME_RE.test(start)) return json(400, { message: "start must be HH:MM (24-hour)" });
  if (!phone) return json(400, { message: "phone is required" });

  const config = await getConfig();
  const therapist = config.therapists.find((t) => t.id === therapistId);
  if (!therapist) return json(400, { message: `Unknown therapist: ${therapistId}` });
  const service = config.services.find((s) => s.id === serviceId);
  if (!service) return json(400, { message: `Unknown service: ${serviceId}` });

  const durationMin = body.durationMin ?? service.durationMin;
  if (!Number.isInteger(durationMin) || durationMin <= 0 || durationMin > 480) {
    return json(400, { message: "durationMin must be a positive number of minutes" });
  }

  // Overlap check — BOOKED appointments only. A cancelled record never
  // blocks its slot, so cancelled slots are immediately rebookable.
  const newStart = toMinutes(start);
  const newEnd = newStart + durationMin;
  const clash = (await queryDay(date))
    .filter((a) => isBooked(a) && a.therapistId === therapistId)
    .find((a) => {
      const s = toMinutes(a.start);
      return newStart < s + a.durationMin && s < newEnd;
    });
  if (clash) {
    const clashService = config.services.find((s) => s.id === clash.serviceId);
    return json(409, {
      message: `${therapist.name} already has ${clashService?.name ?? "an appointment"} at ${clash.start}`,
    });
  }

  const appt = {
    date,
    id: `a-${randomUUID().slice(0, 8)}`,
    therapistId,
    serviceId,
    customerName: customerName || null,
    phone,
    notes: body.notes?.trim() || null,
    start,
    durationMin,
    status: "booked",
    createdAt: new Date().toISOString(),
  };
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: appt,
      ConditionExpression: "attribute_not_exists(id)",
    })
  );
  return json(201, view(appt, { masked: false }));
}

async function cancelAppointment(date, id) {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { date, id },
        UpdateExpression: "SET #status = :cancelled, cancelledAt = :now",
        ConditionExpression: "attribute_exists(id)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":cancelled": "cancelled",
          ":now": new Date().toISOString(),
        },
      })
    );
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      return json(404, { message: "Appointment not found" });
    }
    throw err;
  }
  return json(200, { message: "Cancelled" });
}

export const handler = async (event) => {
  const method = event.requestContext?.http?.method;
  const path = event.rawPath ?? "";
  const qs = event.queryStringParameters ?? {};

  try {
    if (method === "GET" && (path === "/api/day" || path === "/api/admin/day")) {
      if (!qs.date || !DATE_RE.test(qs.date)) {
        return json(400, { message: "date query param must be YYYY-MM-DD" });
      }
      return await getDay(qs.date, { masked: path === "/api/day" });
    }

    if (method === "POST" && path === "/api/admin/appointments") {
      let body;
      try {
        const raw = event.isBase64Encoded
          ? Buffer.from(event.body ?? "", "base64").toString("utf8")
          : event.body ?? "";
        body = JSON.parse(raw);
      } catch {
        return json(400, { message: "Body must be valid JSON" });
      }
      return await createAppointment(body);
    }

    if (method === "DELETE") {
      const m = path.match(/^\/api\/admin\/appointments\/(\d{4}-\d{2}-\d{2})\/([\w-]+)$/);
      if (m) return await cancelAppointment(m[1], m[2]);
    }

    return json(404, { message: `No route for ${method} ${path}` });
  } catch (err) {
    console.error(err);
    return json(500, { message: "Server error" });
  }
};
