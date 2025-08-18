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
app.listen(PORT, () => console.log(`Alice API listening on :${PORT}`));
