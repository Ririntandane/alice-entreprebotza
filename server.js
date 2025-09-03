// ===== Alice EntrepreBot Server (CommonJS, all-in-one, fast EFT flow) =====
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const jwt = require("jsonwebtoken");
const { v4: uuid } = require("uuid");
const nodemailer = require("nodemailer");

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";

// ---------------- In-memory data ----------------
const businesses = {};   // id -> { name, industry, timezone }
const bookings = [];     // { id, businessId, clientName, contact, service, when, staffId, notes, status }
const leads = [];        // { id, businessId, name, contact, service, budget, source, notes }
const staff = [];        // { id, businessId, name, nationalId, pin, role }
const attendance = [];   // { id, businessId, staffId, type, timestamp }
const overtime = [];     // { id, businessId, staffId, hours, reason, status }
const faqs = {};         // businessId -> [{q,a}]

// ===== Packages / Paywall state =====
const subscriptionsPkg = {};     // businessId -> { packageId, status, currentPeriodEnd }
const usageCountsPkg = {};       // businessId -> # of free basic calls
const pendingApprovalsPkg = {};  // token -> { businessId|null, packageId, amount, provisionalRef, businessName, industry, contact, requestedAt }

// ===== Packages (luxury copy, no "AI") =====
const PACKAGES = {
  basic: {
    id: "basic",
    name: "R150 – Basic (Self-Service Alice EntrepreBot Assistant)",
    price: 150,
    benefits: [
      "Weekly industry insights & trending hooks",
      "What to post, when to post, which platform",
      "Payday awareness (15th, 25th–30th)",
      "Simple revenue forecasts",
      "Core ops: Bookings, Leads, FAQs, Staff login, Agenda, Clock-in/out"
    ]
  },
  pro: {
    id: "pro",
    name: "R250 – Pro (Alice Assistant + Virtual Consultations)",
    price: 250,
    benefits: [
      "Everything in Basic",
      "2× Virtual Consultations per month (strategy sessions with Alice)",
      "Automatic reminders to staff/clients",
      "Priority booking system for CEO/staff scheduling"
    ]
  },
  elite: {
    id: "elite",
    name: "R500 – Elite (Tailor-Made Business Consulting by Alice)",
    price: 500,
    benefits: [
      "Everything in Pro",
      "Tailor-made consulting: strategy plans, competitor benchmarks, ROI planning",
      "More virtual consultations (up to 4–6 per month)",
      "Premium analytics & KPI dashboards",
      "Referral & reward automation (client suggestions, referrals, loyalty discounts)"
    ]
  }
};

// ===== Helpers =====
const nowIso = () => new Date().toISOString();

const requireBusinessId = (req, res, next) => {
  const bid = req.headers["x-business-id"];
  if (!bid || !businesses[bid]) {
    return res.status(401).json({ error: "Missing or invalid X-Business-Id" });
  }
  req.businessId = bid;
  next();
};

const requireStaffAuth = (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: "Missing Authorization header" });
  try {
    const token = auth.replace(/^Bearer\s+/i, "");
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
};

function hasActiveSubPkg(bid, packageId) {
  const s = subscriptionsPkg[bid];
  const now = Math.floor(Date.now()/1000);
  return !!(s && s.status === "active" && s.packageId === packageId && (!s.currentPeriodEnd || s.currentPeriodEnd > now));
}

// Gate: Basic gets first 40 calls free; Pro/Elite always paid
function gateByPackage(packageId = "basic") {
  return (req, res, next) => {
    const bid = req.headers["x-business-id"];
    if (!bid) return res.status(401).json({ error: "Missing or invalid X-Business-Id" });

    if (hasActiveSubPkg(bid, packageId)) return next();

    if (packageId === "basic") {
      usageCountsPkg[bid] = (usageCountsPkg[bid] || 0) + 1;
      if (usageCountsPkg[bid] <= 40) return next();
    }

    return res.status(402).json({
      error: "Subscription required",
      message: "Choose a package to continue: R150 / R250 / R500",
      packages: Object.values(PACKAGES).map(p => ({
        id: p.id, name: p.name, price: p.price, benefits: p.benefits
      }))
    });
  };
}

// ===== Email transport (Gmail App Password) =====
const mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_KEY   = process.env.ADMIN_KEY || "change-me";
const BASE_URL    = process.env.PUBLIC_BASE_URL || "http://localhost:8080";

async function sendEmail(to, subject, html) {
  try { await mailer.sendMail({ from: process.env.SMTP_USER, to, subject, html }); }
  catch (e) { console.error("Email error:", e.message); }
}

// ================= Health =================
app.get("/", (_req, res) => res.json({ ok: true, service: "Alice Starter API", time: nowIso() }));
app.get("/healthz", (_req, res) => res.json({ ok: true, time: nowIso() }));

// ================= Business =================
app.post("/business/create", (req, res) => {
  const { name, industry, timezone } = req.body || {};
  if (!name || !industry) return res.status(400).json({ error: "name and industry required" });
  const id = uuid();
  businesses[id] = { name, industry, timezone: timezone || "Africa/Johannesburg" };
  faqs[id] = faqs[id] || [
    { q: "What are your hours?", a: "Mon–Sat 09:00–18:00" },
    { q: "Do you accept walk-ins?", a: "Yes, subject to availability." }
  ];
  res.json({ businessId: id, business: businesses[id] });
});

// ================= Staff =================
app.post("/staff/create", requireBusinessId, (req, res) => {
  const { name, nationalId, pin, role } = req.body || {};
  if (!name || !nationalId || !pin) return res.status(400).json({ error: "name, nationalId, pin required" });
  const id = uuid();
  staff.push({ id, businessId: req.businessId, name, nationalId, pin, role: role || "staff" });
  res.json({ id });
});
app.post("/staff/login", requireBusinessId, (req, res) => {
  const { name, nationalId, pin } = req.body || {};
  const person = staff.find(
    s => s.businessId === req.businessId && s.name === name && s.nationalId === nationalId && s.pin === pin
  );
  if (!person) return res.status(401).json({ error: "Invalid credentials" });
  const token = jwt.sign(
    { staffId: person.id, businessId: req.businessId, role: person.role },
    JWT_SECRET,
    { expiresIn: "8h" }
  );
  res.json({ token, staff: { id: person.id, name: person.name, role: person.role } });
});
app.get("/staff/agenda", requireStaffAuth, (req, res) => {
  const items = bookings.filter(b => b.businessId === req.user.businessId && b.staffId === req.user.staffId && b.status !== "cancelled");
  res.json({ bookings: items });
});
app.post("/staff/clock-in", requireStaffAuth, (req, res) => {
  attendance.push({ id: uuid(), businessId: req.user.businessId, staffId: req.user.staffId, type: "in", timestamp: nowIso() });
  res.json({ ok: true });
});
app.post("/staff/clock-out", requireStaffAuth, (req, res) => {
  attendance.push({ id: uuid(), businessId: req.user.businessId, staffId: req.user.staffId, type: "out", timestamp: nowIso() });
  res.json({ ok: true });
});
app.post("/staff/overtime", requireStaffAuth, (req, res) => {
  const { hours, reason } = req.body || {};
  if (typeof hours !== "number" || hours <= 0) return res.status(400).json({ error: "hours must be a positive number" });
  const entry = { id: uuid(), businessId: req.user.businessId, staffId: req.user.staffId, hours, reason: reason || "", status: "pending" };
  overtime.push(entry);
  res.json(entry);
});

// ================= Bookings =================
app.get("/bookings", requireBusinessId, (req, res) => {
  const list = bookings.filter(b => b.businessId === req.businessId);
  res.json(list);
});
app.post("/bookings", requireBusinessId, (req, res) => {
  const { clientName, contact, service, when, staffId, notes } = req.body || {};
  if (!clientName || !contact || !service || !when) return res.status(400).json({ error: "clientName, contact, service, when required" });
  const entry = {
    id: uuid(), businessId: req.businessId, clientName, contact, service, when,
    staffId: staffId || null, notes: notes || "", status: "confirmed"
  };
  bookings.push(entry);
  res.json(entry);
});

// ================= Leads =================
app.post("/leads", requireBusinessId, (req, res) => {
  const { name, contact, service, budget, source, notes } = req.body || {};
  if (!name || !contact || !service) return res.status(400).json({ error: "name, contact, service required" });
  const entry = { id: uuid(), businessId: req.businessId, name, contact, service, budget: budget || "", source: source || "", notes: notes || "" };
  leads.push(entry);
  res.json(entry);
});

// ================= FAQs =================
app.get("/faqs", requireBusinessId, (req, res) => res.json(faqs[req.businessId] || []));
app.post("/faqs", requireBusinessId, (req, res) => {
  const { items } = req.body || {};
  if (!Array.isArray(items)) return res.status(400).json({ error: "items array required" });
  faqs[req.businessId] = items;
  res.json({ ok: true });
});

// ================= Insights (mock logic) =================
app.post("/insights/weekly", requireBusinessId, gateByPackage("basic"), (req, res) => {
  const biz = businesses[req.businessId] || {};
  const industry = biz.industry || "general";
  res.json({
    weekOf: nowIso().slice(0, 10),
    industry,
    trends: [
      "Payday promos boost conversions (15th, 25th–30th)",
      "Short-form video (15–30s) outperforms",
      "UGC/testimonials increase trust"
    ],
    suggestedPosts: [
      { platform: "Instagram", day: "Thu", time: "18:00", caption: `Payday glow-up ✨ Book now & save 10%. #PaydaySpecial #${industry}` },
      { platform: "TikTok", day: "Sat", time: "11:00", caption: `Behind the scenes + quick tips 🎥 #${industry}Tips` },
      { platform: "Facebook", day: "Tue", time: "12:30", caption: "Client story + referral rewards 💬 #HappyClients" }
    ],
    bestTimes: { Instagram: ["18:00"], TikTok: ["11:00"], Facebook: ["12:30"] }
  });
});

app.post("/insights/forecast", requireBusinessId, gateByPackage("basic"), (req, res) => {
  const { baselineWeeklyRevenue = 10000, marketingSpend = 1500 } = req.body || {};
  const paydayBoost = 0.12, trendBoost = 0.05;
  const projected = Math.round(baselineWeeklyRevenue * (1 + paydayBoost + trendBoost));
  const estimatedROI = Number((((projected - baselineWeeklyRevenue) - marketingSpend) / Math.max(marketingSpend, 1)).toFixed(2));
  res.json({
    baselineWeeklyRevenue,
    projectedWeeklyRevenue: projected,
    assumedLifts: { paydayBoost, trendBoost },
    marketingSpend,
    estimatedROI
  });
});

// ================= Example gated routes for Pro / Elite =================
app.post("/consultations", requireBusinessId, gateByPackage("pro"), (req, res) => {
  // Demo only
  res.json({ ok: true, note: "Consultation booked (demo). Replace with your own logic." });
});
app.post("/upgrade/premium", requireBusinessId, gateByPackage("elite"), (req, res) => {
  // Demo only
  res.json({ ok: true, note: "Premium upgrade active (demo). Replace with your own logic." });
});

// ===================================================================
//                BILLING: Packages, EFT (no header), Email approval
// ===================================================================

// List packages
app.get("/billing/packages", (_req, res) => {
  res.json(Object.values(PACKAGES).map(p => ({
    id: p.id, name: p.name, price: p.price, benefits: p.benefits
  })));
});

// Start EFT — FAST PATH (no Business-Id required)
app.post("/billing/eft/start", (req, res) => {
  const { packageId = "basic", businessName = "New Business", industry = "general", contact = "" } = req.body || {};
  const pack = PACKAGES[packageId] || PACKAGES.basic;

  const headerBid = req.headers["x-business-id"];
  const provisionalRef = headerBid || ("P-" + uuid().slice(0,6).toUpperCase());

  const message = `💳 EFT Payment Instructions
Service: ${pack.name}
Total: R${pack.price}

Bank: FNB
Account Name: Alice N
Account Type: Cheque
Account Number: 63092455097
Reference: ${provisionalRef}

After payment, reply: DONE`;

  res.json({
    ok: true,
    packageId: pack.id,
    amount: pack.price,
    message,
    provisionalRef,
    note: headerBid ? "Using your Business ID as reference." : "Fast start: no Business ID yet; using provisional reference."
  });
});

// Confirm EFT (DONE) — FAST PATH (no Business-Id required)
app.post("/billing/eft/done", (req, res) => {
  const {
    packageId = "basic",
    provisionalRef = "",
    businessName = "New Business",
    industry = "general",
    contact = ""
  } = req.body || {};

  const pack = PACKAGES[packageId] || PACKAGES.basic;
  const headerBid = req.headers["x-business-id"];
  const token = uuid().slice(0, 6).toUpperCase();

  pendingApprovalsPkg[token] = {
    businessId: headerBid || null,
    packageId: pack.id,
    amount: pack.price,
    requestedAt: Date.now(),
    provisionalRef: provisionalRef || ("P-" + uuid().slice(0,6).toUpperCase()),
    businessName,
    industry,
    contact
  };

  const approveLink = `${BASE_URL}/admin/approve?token=${token}&days=30&key=${encodeURIComponent(ADMIN_KEY)}`;
  const denyLink    = `${BASE_URL}/admin/deny?token=${token}&key=${encodeURIComponent(ADMIN_KEY)}`;

  const html = `
    <h3>EFT Claim</h3>
    <p><b>Provisional Ref:</b> ${pendingApprovalsPkg[token].provisionalRef}</p>
    <p><b>Package:</b> ${pack.name} (R${pack.price})</p>
    <p><b>BusinessId:</b> ${headerBid || "(none yet)"} </p>
    <p><b>Business Name:</b> ${businessName}</p>
    <p><b>Industry:</b> ${industry}</p>
    <p><b>Contact:</b> ${contact}</p>
    <p><a href="${approveLink}">✅ Approve 30 days</a> | <a href="${denyLink}">❌ Deny</a></p>
  `;
  sendEmail(ADMIN_EMAIL, `[Alice EFT] ${pack.name} — Ref ${pendingApprovalsPkg[token].provisionalRef}`, html);

  res.json({ ok: true, message: "Claim sent to admin. You’ll be unlocked after verification.", token });
});

// Approve — auto-creates a Business if missing
app.get("/admin/approve", (req, res) => {
  const { token, days = "30", key } = req.query || {};
  if (key !== ADMIN_KEY) return res.status(401).send("Unauthorized");
  const pending = pendingApprovalsPkg[token];
  if (!pending) return res.status(400).send("Invalid token");

  // Ensure we have a businessId; if missing, create one from pending info
  let bid = pending.businessId;
  if (!bid) {
    bid = uuid();
    businesses[bid] = {
      name: pending.businessName || "Approved Business",
      industry: pending.industry || "general",
      timezone: "Africa/Johannesburg"
    };
  }

  const expiresAt = Date.now() + Number(days) * 24 * 3600 * 1000;
  subscriptionsPkg[bid] = {
    status: "active",
    packageId: pending.packageId,
    currentPeriodEnd: Math.floor(expiresAt / 1000)
  };

  const approvedHtml = `
    <h3>Approved</h3>
    <p><b>BusinessId:</b> ${bid}</p>
    <p><b>Package:</b> ${pending.packageId}</p>
    <p><b>Expires:</b> ${new Date(expiresAt).toISOString()}</p>
    <p><b>Ref:</b> ${pending.provisionalRef}</p>
    <p><b>Name/Industry:</b> ${pending.businessName} / ${pending.industry}</p>
  `;
  delete pendingApprovalsPkg[token];
  res.setHeader("Content-Type", "text/html");
  res.send(approvedHtml);
});

// Deny
app.get("/admin/deny", (req, res) => {
  const { token, key } = req.query || {};
  if (key !== ADMIN_KEY) return res.status(401).send("Unauthorized");
  delete pendingApprovalsPkg[token];
  res.send("<h3>Denied</h3>");
});

// ================= Start =================
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Alice API listening on :${PORT}`));
