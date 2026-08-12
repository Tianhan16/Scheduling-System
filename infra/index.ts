import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// DynamoDB — one table, appointments partitioned by date (see DESIGN.md)
// ---------------------------------------------------------------------------

const table = new aws.dynamodb.Table("appointments", {
  billingMode: "PAY_PER_REQUEST",
  hashKey: "date",
  rangeKey: "id",
  attributes: [
    { name: "date", type: "S" },
    { name: "id", type: "S" },
  ],
});

// Seed data: therapists + service menu (Zen Reflexology).
// durationMin is only the default prefill — admin sets real length per booking.
const seedConfig = {
  therapists: [
    { id: "t-summer", name: "Summer" },
    { id: "t-cindy", name: "Cindy" },
    { id: "t-helen", name: "Helen" },
    { id: "t-mona", name: "Mona" },
    { id: "t-tony", name: "Tony" },
    { id: "t-coco", name: "Coco" },
    { id: "t-jason", name: "Jason" },
    { id: "t-vivi", name: "Vivi" },
    { id: "t-sub1", name: "Sub 1" },
    { id: "t-sub2", name: "Sub 2" },
  ],
  services: [
    { id: "s-lomi", name: "Lomi Lomi", durationMin: 60, color: "pink" },
    { id: "s-deep", name: "Deep Tissue", durationMin: 60, color: "teal" },
    { id: "s-swedish", name: "Swedish", durationMin: 60, color: "purple" },
    { id: "s-combo", name: "Combo", durationMin: 60, color: "amber" },
    { id: "s-foot", name: "Foot Massage", durationMin: 60, color: "coral" },
    { id: "s-unknown", name: "Unknown", durationMin: 60, color: "gray" },
  ],
};

// DynamoDB items are written in its typed JSON format ({S: ...}, {N: ...}).
const toAttr = (v: unknown): any => {
  if (typeof v === "string") return { S: v };
  if (typeof v === "number") return { N: String(v) };
  if (Array.isArray(v)) return { L: v.map(toAttr) };
  if (v && typeof v === "object") {
    return { M: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toAttr(x)])) };
  }
  throw new Error(`Unsupported attribute value: ${v}`);
};

new aws.dynamodb.TableItem("config", {
  tableName: table.name,
  hashKey: table.hashKey,
  rangeKey: table.rangeKey.apply((r) => r!),
  item: JSON.stringify({
    date: { S: "CONFIG" },
    id: { S: "current" },
    therapists: toAttr(seedConfig.therapists),
    services: toAttr(seedConfig.services),
  }),
});

// ---------------------------------------------------------------------------
// Lambda — the API code in ../backend
// ---------------------------------------------------------------------------

const role = new aws.iam.Role("api-role", {
  assumeRolePolicy: JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      { Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" },
    ],
  }),
});

new aws.iam.RolePolicyAttachment("api-logs", {
  role: role.name,
  policyArn: aws.iam.ManagedPolicy.AWSLambdaBasicExecutionRole,
});

new aws.iam.RolePolicy("api-ddb", {
  role: role.id,
  policy: table.arn.apply((arn) =>
    JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query"],
          Resource: arn,
        },
      ],
    })
  ),
});

const fn = new aws.lambda.Function("api", {
  runtime: aws.lambda.Runtime.NodeJS20dX,
  handler: "handler.handler",
  role: role.arn,
  code: new pulumi.asset.AssetArchive({
    ".": new pulumi.asset.FileArchive("../backend"),
  }),
  environment: { variables: { TABLE_NAME: table.name } },
  memorySize: 256,
  timeout: 10,
});

// ---------------------------------------------------------------------------
// API Gateway (HTTP API) — routes requests to the Lambda
// ---------------------------------------------------------------------------

const api = new aws.apigatewayv2.Api("api", { protocolType: "HTTP" });

const integration = new aws.apigatewayv2.Integration("api-lambda", {
  apiId: api.id,
  integrationType: "AWS_PROXY",
  integrationUri: fn.invokeArn,
  payloadFormatVersion: "2.0",
});

const routeKeys = [
  "GET /api/day",
  "GET /api/admin/day",
  "POST /api/admin/appointments",
  "PUT /api/admin/appointments/{date}/{id}",
  "DELETE /api/admin/appointments/{date}/{id}",
  "PUT /api/admin/roster/{date}",
];
for (const routeKey of routeKeys) {
  new aws.apigatewayv2.Route(routeKey.toLowerCase().replace(/[^a-z0-9]+/g, "-"), {
    apiId: api.id,
    routeKey,
    target: pulumi.interpolate`integrations/${integration.id}`,
  });
}

new aws.apigatewayv2.Stage("default", { apiId: api.id, name: "$default", autoDeploy: true });

new aws.lambda.Permission("api-invoke", {
  action: "lambda:InvokeFunction",
  function: fn.name,
  principal: "apigateway.amazonaws.com",
  sourceArn: pulumi.interpolate`${api.executionArn}/*/*`,
});

// ---------------------------------------------------------------------------
// S3 — private bucket holding the static frontend files
// ---------------------------------------------------------------------------

const bucket = new aws.s3.BucketV2("web");

new aws.s3.BucketPublicAccessBlock("web-private", {
  bucket: bucket.id,
  blockPublicAcls: true,
  blockPublicPolicy: true,
  ignorePublicAcls: true,
  restrictPublicBuckets: true,
});

// ---------------------------------------------------------------------------
// CloudFront — the one public HTTPS front door.
//   /*      -> S3 (static files, cached)
//   /api/*  -> API Gateway (never cached)
// ---------------------------------------------------------------------------

const oac = new aws.cloudfront.OriginAccessControl("web-oac", {
  name: "scheduling-web-oac",
  originAccessControlOriginType: "s3",
  signingBehavior: "always",
  signingProtocol: "sigv4",
});

const apiHost = api.apiEndpoint.apply((u) => new URL(u).host);

// AWS-managed cache/request policies (fixed well-known IDs).
const CACHING_DISABLED = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad";
const ALL_VIEWER_EXCEPT_HOST = "b689b0a8-53d0-40ab-baf2-68738e2966ac";

const cdn = new aws.cloudfront.Distribution("cdn", {
  enabled: true,
  defaultRootObject: "index.html",
  priceClass: "PriceClass_100",
  origins: [
    {
      originId: "s3",
      domainName: bucket.bucketRegionalDomainName,
      originAccessControlId: oac.id,
    },
    {
      originId: "api",
      domainName: apiHost,
      customOriginConfig: {
        httpPort: 80,
        httpsPort: 443,
        originProtocolPolicy: "https-only",
        originSslProtocols: ["TLSv1.2"],
      },
    },
  ],
  // Static files are NOT edge-cached: at this traffic level caching buys
  // nothing, and it made deploys take up to 24h to reach phones.
  defaultCacheBehavior: {
    targetOriginId: "s3",
    viewerProtocolPolicy: "redirect-to-https",
    allowedMethods: ["GET", "HEAD"],
    cachedMethods: ["GET", "HEAD"],
    cachePolicyId: CACHING_DISABLED,
    compress: true,
  },
  orderedCacheBehaviors: [
    {
      pathPattern: "/api/*",
      targetOriginId: "api",
      viewerProtocolPolicy: "https-only",
      allowedMethods: ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"],
      cachedMethods: ["GET", "HEAD"],
      cachePolicyId: CACHING_DISABLED,
      originRequestPolicyId: ALL_VIEWER_EXCEPT_HOST,
    },
  ],
  restrictions: { geoRestriction: { restrictionType: "none" } },
  viewerCertificate: { cloudfrontDefaultCertificate: true },
});

// Only CloudFront may read the bucket — it is never publicly accessible.
new aws.s3.BucketPolicy("web-allow-cdn", {
  bucket: bucket.id,
  policy: pulumi.jsonStringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: "cloudfront.amazonaws.com" },
        Action: "s3:GetObject",
        Resource: pulumi.interpolate`${bucket.arn}/*`,
        Condition: { StringEquals: { "AWS:SourceArn": cdn.arn } },
      },
    ],
  }),
});

// Upload every file in ../web. The etag makes `pulumi up` re-upload a file
// whenever its content changes.
const webDir = path.join(__dirname, "..", "web");
const contentTypes: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};
for (const file of fs.readdirSync(webDir)) {
  const full = path.join(webDir, file);
  if (!fs.statSync(full).isFile()) continue;
  new aws.s3.BucketObjectv2(file, {
    bucket: bucket.id,
    key: file,
    source: new pulumi.asset.FileAsset(full),
    contentType: contentTypes[path.extname(file)] ?? "application/octet-stream",
    // Browsers must revalidate on every load (cheap 304 via ETag) — without
    // this, heuristic caching serves stale JS/CSS after deploys.
    cacheControl: "no-cache",
    etag: crypto.createHash("md5").update(fs.readFileSync(full)).digest("hex"),
  });
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

export const url = pulumi.interpolate`https://${cdn.domainName}`;
export const distributionId = cdn.id;
export const adminUrl = pulumi.interpolate`https://${cdn.domainName}/admin.html`;
export const apiEndpoint = api.apiEndpoint;
