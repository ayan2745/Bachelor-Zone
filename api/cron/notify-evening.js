import { getSupabaseAdmin } from "../../lib/supabaseAdmin.js";

const NOTIFICATION_RETENTION_DAYS = 3;

function isAuthorized(req) {
  const auth = req.headers["authorization"] || "";
  const secret = process.env.CRON_SECRET;
  return Boolean(secret) && auth === `Bearer ${secret}`;
}

async function cleanupOldNotifications(db) {
  const cutoff = new Date(Date.now() - NOTIFICATION_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await db.from("notifications").delete().lt("created_at", cutoff);
}

// Vercel Cron — scheduled for 10:00 UTC (4:00 PM Asia/Dhaka). See vercel.json.
export default async function handler(req, res) {
  if (!isAuthorized(req)) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  try {
    const db = getSupabaseAdmin();
    await cleanupOldNotifications(db);

    const { error } = await db.from("notifications").insert({
      title: "🍛 Dinner Meal Reminder",
      message: "Hey, Did you update your dinner meal today? If not, please update it now.",
      notif_type: "auto_evening",
      created_by_email: "",
      created_by_name: "System",
    });
    if (error) throw error;

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("notify-evening cron error:", err);
    return res.status(500).json({ success: false, error: err.message || String(err) });
  }
}
