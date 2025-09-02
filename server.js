import express from "express";
import cors from "cors";
import { v4 as uuid } from "uuid";

const app = express();
app.use(cors());
app.use(express.json());

// In-memory stores (MVP)
const businesses = {}; // id -> { name, industry, timezone }
const bookings = [];   // { id, businessId, clientName, contact, service, when, notes, status }

// Health
app.get("/", (_req, res) => {
  res.json({ ok: true, service: "Alice Starter API", time: new Date().toISOString() });
});

// Create business
app.post("/business/create", (req, res) => {
  const { name, industry, timezone } = req.body || {};
  if (!name || !industry) return res.status(400).json({ error: "name and industry required" });
  const id = uuid();
  businesses[id] = { name, industry, timezone: timezone || "Africa/Johannesburg" };
  res.json({ businessId: id, business: businesses[id] });
});

// Helper to require X-Business-Id
function requireBusinessId(req, res, next) {
  const bid = req.headers["x-business-id"];
  if (!bid || !businesses[bid]) {
    return res.status(401).json({ error: "Missing or invalid X-Business-Id" });
  }
  req.businessId = bid;
  next();
}

// List bookings (for a business)
app.get("/bookings", requireBusinessId, (req, res) => {
  const list = bookings.filter(b => b.businessId === req.businessId);
  res.json(list);
});

// Create booking
app.post("/bookings", requireBusinessId, (req, res) => {
  const { clientName, contact, service, when, notes } = req.body || {};
  if (!clientName || !contact || !service || !when)
    return res.status(400).json({ error: "clientName, contact, service, when required" });
  const entry = {
    id: uuid(),
    businessId: req.businessId,
    clientName, contact, service, when,
    notes: notes || "",
    status: "confirmed"
  };
  bookings.push(entry);
  res.json(entry);
});

const PORT = process.env.PORT || 8080;
// ===== Alice EntrepreBot Packages & EFT Paywall =====
import nodemailer from "nodemailer";
import { v4 as uuid } from "uuid";

// --- Email transport ---
const mailerPkg = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});

const ADMIN_EMAIL_PKG = process.env.ADMIN_EMAIL;
const ADMIN_KEY_PKG   = process.env.ADMIN_KEY || "change-me";
const BASE_URL_PKG    = process.env.PUBLIC_BASE_URL || "https://alice-entreprebotza.onrender.com";

// --- State ---
const usageCountsPkg = {};       // businessId -> free uses count
const subscriptionsPkg = {};     // businessId -> { packageId, status, currentPeriodEnd }
const pendingApprovalsPkg = {};  // token -> { businessId, packageId, amount, requestedAt }

// --- Package definitions ---
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
      "Core: Bookings, Leads, FAQs, Staff login, Agenda, Clock-in/out"
    ]
  },
  pro: {
    id: "pro",
    name: "R250 – Pro (Alice Assistant + Virtual Consultations)",
    price: 250,
    benefits: [
      "Everything in Basic",
      "2x Virtual Consultations per month (strategy sessions with Alice)",
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
      "Tailor-made business consulting: strategy plans, competitor benchmarks, ROI planning",
      "More virtual consultations (up to 4–6 per month)",
      "Premium analytics & KPI dashboards",
      "Referral & reward automation (client suggestions, referrals, loyalty discounts)"
    ]
  }
};

// --- Helpers ---
async function sendPkgEmail(to, subject, html) {
  try { await mailerPkg.sendMail({ from: process.env.SMTP_USER, to, subject, html }); }
  catch (e) { console.error("Email error", e); }
}

function hasActiveSubPkg(bid, packageId) {
  const s = subscriptionsPkg[bid];
  const now = Math.floor(Date.now()/1000);
  return !!(s && s.status === "active" && s.packageId === packageId && (!s.currentPeriodEnd || s.currentPeriodEnd > now));
}

// --- Middleware gate ---
// Basic (R150) = free first 40 requests, then pay.
// Pro/Elite = always pay.
function gateByPackage(packageId = "basic") {
  return (req, res, next) => {
    const bid = req.headers["x-business-id"];
    if (!bid) return res.status(401).json({ error: "Missing businessId" });

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

// --- Endpoints ---
// List packages
app.get("/billing/packages", (req, res) => {
  res.json(Object.values(PACKAGES).map(p => ({
    id: p.id, name: p.name, price: p.price, benefits: p.benefits
  })));
});

// Start EFT (returns EFT message with total)
app.post("/billing/eft/start", requireBusinessId, (req, res) => {
  const { packageId } = req.body || {};
  const pack = PACKAGES[packageId] || PACKAGES.basic;
  const bid = req.businessId;

  const message = `💳 EFT Payment Instructions
Service: ${pack.name}
Total: R${pack.price}

Bank: FNB
Account Name: Alice N
Account Type: Cheque
Account Number: 63092455097
Reference: ${bid}

After payment, reply: DONE`;

  res.json({ ok: true, packageId: pack.id, amount: pack.price, message });
});

// Confirm EFT (user says DONE → email admin)
app.post("/billing/eft/done", requireBusinessId, (req, res) => {
  const { packageId = "basic" } = req.body || {};
  const pack = PACKAGES[packageId] || PACKAGES.basic;
  const bid = req.businessId;

  const token = uuid().slice(0, 6).toUpperCase();
  pendingApprovalsPkg[token] = {
    businessId: bid, packageId: pack.id, amount: pack.price, requestedAt: Date.now()
  };

  const approveLink = `${BASE_URL_PKG}/admin/approve?token=${token}&days=30&key=${encodeURIComponent(ADMIN_KEY_PKG)}`;
  const denyLink    = `${BASE_URL_PKG}/admin/deny?token=${token}&key=${encodeURIComponent(ADMIN_KEY_PKG)}`;

  const html = `
    <h3>EFT Claim</h3>
    <p><b>Business:</b> ${bid}</p>
    <p><b>Package:</b> ${pack.name}</p>
    <p><b>Amount:</b> R${pack.price}</p>
    <p><b>Token:</b> ${token}</p>
    <p><a href="${approveLink}">✅ Approve 30 days</a> | <a href="${denyLink}">❌ Deny</a></p>
  `;
  sendPkgEmail(ADMIN_EMAIL_PKG, `[Alice Bot EFT] ${pack.name} - Business ${bid}`, html);

  res.json({ ok: true, message: "Claim sent to admin. You’ll be unlocked after verification." });
});

// Approve / Deny (email links)
app.get("/admin/approve", (req, res) => {
  const { token, days = "30", key } = req.query || {};
  if (key !== ADMIN_KEY_PKG) return res.status(401).send("Unauthorized");
  const pending = pendingApprovalsPkg[token];
  if (!pending) return res.status(400).send("Invalid token");

  const expiresAt = Date.now() + Number(days) * 24*3600*1000;
  subscriptionsPkg[pending.businessId] = {
    status: "active", packageId: pending.packageId, currentPeriodEnd: Math.floor(expiresAt/1000)
  };
  delete pendingApprovalsPkg[token];
  res.send(`<h3>Approved ${days} days for ${pending.businessId} (${pending.packageId})</h3>`);
});

app.get("/admin/deny", (req, res) => {
  const { token, key } = req.query || {};
  if (key !== ADMIN_KEY_PKG) return res.status(401).send("Unauthorized");
  delete pendingApprovalsPkg[token];
  res.send("<h3>Denied</h3>");
});

// --- Apply gates ---
// Basic (R150)
app.post("/insights/weekly",   requireBusinessId, gateByPackage("basic"), (req,res)=>{ /* existing code */ });
app.post("/insights/forecast", requireBusinessId, gateByPackage("basic"), (req,res)=>{ /* existing code */ });
// Pro (R250)
app.post("/consultations",     requireBusinessId, gateByPackage("pro"), (req,res)=>{ res.json({ok:true, note:"Consult booked (demo)"}) });
// Elite (R500)
app.post("/upgrade/premium",   requireBusinessId, gateByPackage("elite"), (req,res)=>{ res.json({ok:true, note:"Premium active (demo)"}) });
// ===== End Paywall =====
app.listen(PORT, () => console.log(`Alice API listening on :${PORT}`));
