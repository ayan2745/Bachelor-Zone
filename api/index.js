import { getSupabaseAdmin } from "../lib/supabaseAdmin.js";

// ─── CORS helper ─────────────────────────────────────────────────────────────
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}
function sendJson(res, data, status = 200) {
  setCors(res);
  return res.status(status).json(data);
}

// ─── Date helpers ─────────────────────────────────────────────────────────────
function getServerClock() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Dhaka",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = type => parts.find(p => p.type === type)?.value || "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) || 0 };
}
function todayStr() { return getServerClock().date; }
function monthOf(dateStr) { return dateStr.slice(0, 7); }
function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const MONTHLY_MEMBER_TABLE = "monthly_members";
const RENT_PAYMENT_REMARKS = "AUTO: Room Rent Payment";
const MEAL_DEADLINE_OVERRIDE_TABLE = "meal_deadline_overrides";
const BAZAR_SETTINGS_TABLE = "bazar_settings";
const BAZAR_PERIODS_TABLE = "bazar_periods";
const BAZAR_MEALS_TABLE = "bazar_meals";
const NOTIFICATIONS_TABLE = "notifications";
const NOTIFICATION_READS_TABLE = "notification_reads";
const NOTIFICATION_RETENTION_DAYS = 3;

// ─── Notification cleanup (keeps the table light — 3 day retention) ───────────
async function cleanupOldNotifications(db) {
  const cutoff = new Date(Date.now() - NOTIFICATION_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  try {
    await db.from(NOTIFICATIONS_TABLE).delete().lt("created_at", cutoff);
  } catch (e) {
    console.error("Notification cleanup failed:", e);
  }
}

function isMissingMobileNumberColumn(error) {
  const message = String(error?.message || error?.details || "");
  return message.includes("mobile_number") && message.toLowerCase().includes("column");
}

function missingMobileNumberColumnError() {
  return new Error("Missing database column: public.members.mobile_number. Run bazar-and-meal-extension.sql in Supabase, then save the member again.");
}

function daysInMonth(monthKey) {
  const [year, month] = monthKey.split("-").map(Number);
  return new Date(year, month, 0).getDate();
}
function buildBazarPeriods(monthKey, splitBetween, assignedRows = []) {
  const totalDays = daysInMonth(monthKey);
  const split = Math.max(1, Math.min(totalDays, parseInt(splitBetween, 10) || 1));
  const base = Math.floor(totalDays / split);
  const assignedByRange = {};
  (assignedRows || []).forEach(r => {
    assignedByRange[`${r.start_day}-${r.end_day}`] = r;
  });
  const periods = [];
  let start = 1;
  for (let i = 1; i <= split; i++) {
    const end = i === split ? totalDays : start + base - 1;
    const assigned = assignedByRange[`${start}-${end}`];
    periods.push({
      startDay: start,
      endDay: end,
      label: `${start}-${end}`,
      memberEmail: assigned?.member_email || "",
      memberName: assigned?.member_name || "",
    });
    start = end + 1;
  }
  return periods;
}

// ─── Prior month key ──────────────────────────────────────────────────────────
function priorMonth(monthKey) {
  const [y, m] = monthKey.split("-").map(Number);
  const d = new Date(y, m - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// ════════════════════════════════════════════════════════════════════════════════
export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const action = req.method === "GET" ? req.query.action : req.body?.action;

  try {

    // ── HEALTH ────────────────────────────────────────────────────────────────
    if (action === "health") {
      return sendJson(res, { success: true, message: "API is working" });
    }

    if (action === "getServerClock") {
      return sendJson(res, { success: true, serverClock: getServerClock() });
    }

    const db = getSupabaseAdmin();

    // ════════════════════════════════════════════════════════════════════════
    // AUTH
    // ════════════════════════════════════════════════════════════════════════
    if (action === "authenticateUser") {
      const email    = String(req.query.email    || "").toLowerCase().trim();
      const password = String(req.query.password || "").trim();

      const { data: member, error } = await db
        .from("members")
        .select("name,email,password_legacy,authority")
        .eq("email", email)
        .maybeSingle();

      if (error) throw error;
      if (!member || member.password_legacy !== password)
        return sendJson(res, { success: false, error: "Invalid Credentials!" });

      return sendJson(res, {
        success: true,
        user: { name: member.name, email: member.email, authority: member.authority },
      });
    }

    // ════════════════════════════════════════════════════════════════════════
    // GET DATA  (main dashboard load)
    // ════════════════════════════════════════════════════════════════════════
    if (action === "getData") {
      const userEmail   = String(req.query.email     || "").toLowerCase().trim();
      const targetMonth = String(req.query.monthYear || "").trim();
      const targetDate  = String(req.query.date      || todayStr()).trim();

      // ── All parallel queries ─────────────────────────────────────────────
      const [
        membersRes,       // identity/auth only
        monthMembersRes,  // who is active this month + their rent
        mealsRes,
        bazarRes,
        rentRes,
        adjRes,
        utilRes,
        rateRes,
        todayMealsRes,
        next7PrefRes,
        allMonthsRes,
        allMonthMembersRes, // all monthly_members rows (for lifetime calc)
        allUtilRes,
        allRatesRes,
        allRentRes,
        mealDeadlineRes,
        bazarSettingRes,
        bazarPeriodsRes,
        bazarMealsRes,
      ] = await Promise.all([
        db.from("members").select("*"),
        db.from(MONTHLY_MEMBER_TABLE).select("*").eq("month_key", targetMonth),
        db.from("meals").select("*").eq("month_key", targetMonth),
        db.from("bazar_entries").select("*").eq("month_key", targetMonth),
        db.from("rent_status").select("*").eq("month_key", targetMonth),
        db.from("adjustments").select("*").eq("month_key", targetMonth),
        db.from("utilities").select("*").eq("month_key", targetMonth).maybeSingle(),
        db.from("monthly_meal_rates").select("*").eq("month_key", targetMonth).maybeSingle(),
        db.from("meals").select("*").eq("meal_date", targetDate),
        db.from("meals")
          .select("meal_date,lunch,dinner,guest_lunch,guest_dinner")
          .eq("member_email", userEmail)
          .gte("meal_date", addDays(targetDate, 1))
          .lte("meal_date", addDays(targetDate, 7)),
        db.from("meals").select("month_key"),
        db.from(MONTHLY_MEMBER_TABLE).select("*"),
        db.from("utilities").select("*"),
        db.from("monthly_meal_rates").select("*"),
        db.from("rent_status").select("*"),
        db.from(MEAL_DEADLINE_OVERRIDE_TABLE).select("*").eq("override_date", targetDate).maybeSingle(),
        db.from(BAZAR_SETTINGS_TABLE).select("*").eq("month_key", targetMonth).maybeSingle(),
        db.from(BAZAR_PERIODS_TABLE).select("*").eq("month_key", targetMonth),
        db.from(BAZAR_MEALS_TABLE).select("*").eq("month_key", targetMonth),
      ]);

      if (membersRes.error)       throw membersRes.error;
      if (monthMembersRes.error)  throw monthMembersRes.error;
      if (next7PrefRes.error)     throw next7PrefRes.error;
      if (allRentRes.error)       throw allRentRes.error;
      if (bazarMealsRes.error)    throw bazarMealsRes.error;

      const allMemberDir    = membersRes.data       || []; // directory (name/email/authority/mobile)
      const monthMembers    = monthMembersRes.data   || []; // active this month
      const monthMeals      = mealsRes.data          || [];
      const bazarList       = bazarRes.data          || [];
      const rentData        = rentRes.data           || [];
      const adjData         = adjRes.data            || [];
      const utilRow         = utilRes.data           || { electricity:0, wifi:0, gas:0, filter:0, bua:0, other:0 };
      const todayMeals      = todayMealsRes.data     || [];
      const next7Preferences = (next7PrefRes.data || []).map(r => ({
        date: r.meal_date,
        lunch: r.lunch || 0,
        dinner: r.dinner || 0,
        guestLunch: r.guest_lunch || 0,
        guestDinner: r.guest_dinner || 0,
      }));
      const allMonthMem     = allMonthMembersRes.data || [];
      const allUtil         = allUtilRes.data        || [];
      const allRates        = allRatesRes.data       || [];
      const allRent         = allRentRes.data        || [];
      const mealDeadlineExtended = Boolean(mealDeadlineRes.data?.extended);
      const bazarMealRows = bazarMealsRes.data || [];

      // ── Active members for this month (from monthly_members) ─────────────
      const activeMonthMembers = monthMembers.filter(m => String(m.status || "").trim().toLowerCase() === "active");
      const headCount = Math.max(1, activeMonthMembers.length);
      const bazarSplitBetween = Math.max(1, parseInt(bazarSettingRes.data?.split_between, 10) || headCount || 1);
      const bazarPeriods = buildBazarPeriods(targetMonth, bazarSplitBetween, bazarPeriodsRes.data || []);
      const targetDay = parseInt(targetDate.slice(8, 10), 10);
      const currentBazarPeriod = monthOf(targetDate) === targetMonth
        ? bazarPeriods.find(p => targetDay >= p.startDay && targetDay <= p.endDay)
        : null;
      const currentBazarMember = currentBazarPeriod
        ? allMemberDir.find(m => String(m.email || "").toLowerCase().trim() === String(currentBazarPeriod.memberEmail || "").toLowerCase().trim())
        : null;
      const requester = allMemberDir.find(m => String(m.email || "").toLowerCase().trim() === userEmail);
      const isBua = String(requester?.authority || "").trim().toLowerCase() === "bua";
      const isCurrentBazarMember = Boolean(currentBazarPeriod?.memberEmail) && String(currentBazarPeriod.memberEmail).toLowerCase().trim() === userEmail;
      const canViewBazarMeal = isBua || isCurrentBazarMember;
      const currentBazarMeal = bazarMealRows.find(r => r.meal_date === targetDate);
      const managedBazarMeals = isCurrentBazarMember ? bazarMealRows.filter(r => {
        const day = parseInt(String(r.meal_date || "").slice(8, 10), 10);
        return day >= currentBazarPeriod.startDay && day <= currentBazarPeriod.endDay;
      }) : [];

      // ── Meal rate ────────────────────────────────────────────────────────
      let mealRate = rateRes.data?.meal_rate || 0;
      if (!mealRate) {
        const totalMeals = monthMeals.reduce(
          (s, r) => s + (r.lunch||0) + (r.dinner||0) + (r.guest_lunch||0) + (r.guest_dinner||0), 0
        );
        const totalCost = bazarList.reduce((s, r) => s + (r.cost||0), 0);
        mealRate = totalMeals > 0 && totalCost > 0 ? totalCost / totalMeals : 0;
      }

      // ── Utility totals ────────────────────────────────────────────────────
      const utilTotal =
        (utilRow.electricity||0) + (utilRow.wifi||0) + (utilRow.gas||0) +
        (utilRow.filter||0) + (utilRow.bua||0) + (utilRow.other||0);
      const utilitySplitPerHead = utilTotal / headCount;

      // ── Build rateByMonth map ─────────────────────────────────────────────
      const rateByMonth = {};
      allRates.forEach(r => { rateByMonth[r.month_key] = r.meal_rate; });

      // ── Build headCountByMonth map (from monthly_members) ────────────────
      const headByMonth = {};
      allMonthMem.forEach(r => {
        if (String(r.status || "").trim().toLowerCase() === "active") {
          headByMonth[r.month_key] = (headByMonth[r.month_key] || 0) + 1;
        }
      });

      // ── Active membership + rent maps ─────────────────────────────────────
      const rentByMonthEmail = {};
      const activeMonthsByEmail = {};
      allMonthMem.forEach(r => {
        const email = String(r.member_email || "").toLowerCase().trim();
        if (!email || String(r.status || "").trim().toLowerCase() !== "active") return;
        rentByMonth_set(rentByMonthEmail, r.month_key, email, r.rent_amount || 0);
        activeMonthsByEmail[email] = activeMonthsByEmail[email] || new Set();
        activeMonthsByEmail[email].add(r.month_key);
      });
      function rentByMonth_set(map, mk, em, val) { map[`${mk}|${em}`] = val; }
      function rentByMonth_get(map, mk, em) { return map[`${mk}|${em}`] || 0; }

      // ── Rent payment status by month/email ───────────────────────────────
      const rentStatusByMonthEmail = {};
      allRent.forEach(r => {
        const email = String(r.member_email || "").toLowerCase().trim();
        if (!email || !r.month_key) return;
        const key = `${r.month_key}|${email}`;
        const status = String(r.status || "Due").trim();
        if (status.toLowerCase() === "paid" || !rentStatusByMonthEmail[key]) {
          rentStatusByMonthEmail[key] = status;
        }
      });
      function isRentPaid(mk, em) {
        return String(rentStatusByMonthEmail[`${mk}|${em}`] || "").toLowerCase() === "paid";
      }
      function summarizeRentStatus(rows) {
        if ((rows || []).some(r => String(r.status || "").trim().toLowerCase() === "paid")) return "Paid";
        return rows?.[0]?.status || "Due";
      }

      // ── Utility cost by month map ─────────────────────────────────────────
      const utilByMonth = {};
      allUtil.forEach(u => {
        utilByMonth[u.month_key] =
          (u.electricity||0)+(u.wifi||0)+(u.gas||0)+(u.filter||0)+(u.bua||0)+(u.other||0);
      });

      // ── Lifetime balance calculator for any email ─────────────────────────
      async function calcLifetimeBalance(email) {
        const normalizedEmail = String(email || "").toLowerCase().trim();
        const [umRes, ubRes, uaRes] = await Promise.all([
          db.from("meals").select("*").eq("member_email", normalizedEmail),
          db.from("bazar_entries").select("cost,month_key").eq("buyer_email", normalizedEmail),
          db.from("adjustments").select("amount,month_key,remarks").eq("member_email", normalizedEmail),
        ]);
        const userMeals = umRes.data || [];
        const userBazar = ubRes.data || [];
        const userAdj   = uaRes.data || [];

        // meals grouped by month
        const mealsByMonth = {};
        userMeals.forEach(r => {
          mealsByMonth[r.month_key] = mealsByMonth[r.month_key] || [];
          mealsByMonth[r.month_key].push(r);
        });

        let mealCost = 0, rentCost = 0, rentPaidCredit = 0, utilCost = 0;
        const monthlyNet = {};
        const autoRentCreditByMonth = {};

        const activeMonths = [...(activeMonthsByEmail[normalizedEmail] || new Set())].sort();
        const activeMonthSet = new Set(activeMonths);

        for (const mk of activeMonths) {
          const rate = rateByMonth[mk] || (mk === targetMonth ? mealRate : 0);
          const rows = mealsByMonth[mk] || [];
          const count = rows.reduce(
            (s,r) => s+(r.lunch||0)+(r.dinner||0)+(r.guest_lunch||0)+(r.guest_dinner||0), 0
          );
          mealCost += count * rate;

          // rent for this month from monthly_members
          const monthRent = rentByMonth_get(rentByMonthEmail, mk, normalizedEmail);
          rentCost += monthRent;

          // utility split for this month
          const hc = headByMonth[mk] || headCount;
          const monthUtil = (utilByMonth[mk] || 0) / Math.max(1, hc);
          utilCost += monthUtil;
          monthlyNet[mk] = (monthlyNet[mk] || 0) - (count * rate) - monthRent - monthUtil;
        }

        const bazarTotal = userBazar
          .filter(r => activeMonthSet.has(r.month_key))
          .reduce((s,r) => {
            const val = r.cost || 0;
            monthlyNet[r.month_key] = (monthlyNet[r.month_key] || 0) + val;
            return s + val;
          }, 0);
        const adjTotal = userAdj.reduce((s,r) => {
          const mk = r.month_key || targetMonth;
          const val = r.amount || 0;
          if (String(r.remarks || "").trim() === RENT_PAYMENT_REMARKS) {
            autoRentCreditByMonth[mk] = (autoRentCreditByMonth[mk] || 0) + val;
            return s;
          }
          monthlyNet[mk] = (monthlyNet[mk] || 0) + val;
          return s + val;
        }, 0);

        activeMonths.forEach(mk => {
          const statusCredit = isRentPaid(mk, normalizedEmail) ? rentByMonth_get(rentByMonthEmail, mk, normalizedEmail) : 0;
          const monthRentPaidCredit = Math.max(autoRentCreditByMonth[mk] || 0, statusCredit);
          rentPaidCredit += monthRentPaidCredit;
          monthlyNet[mk] = (monthlyNet[mk] || 0) + monthRentPaidCredit;
        });

        const net = parseFloat((bazarTotal + adjTotal + rentPaidCredit - mealCost - rentCost - utilCost).toFixed(2));
        const currentMonthNet = parseFloat((monthlyNet[targetMonth] || 0).toFixed(2));
        const oldRemaining = parseFloat((net - currentMonthNet).toFixed(2));
        return {
          net,
          oldRemaining,
          currentMonthNet,
          bazarTotal:  parseFloat(bazarTotal.toFixed(2)),
          adjTotal:    parseFloat(adjTotal.toFixed(2)),
          mealCost:    parseFloat(mealCost.toFixed(2)),
          rentCost:    parseFloat(rentCost.toFixed(2)),
          rentPaidCredit: parseFloat(rentPaidCredit.toFixed(2)),
          utilCost:    parseFloat(utilCost.toFixed(2)),
        };
      }

      // ── Build membersArray for this month ────────────────────────────────
      // We calculate lifetime balance for all active members in parallel
      const membersArray = await Promise.all(
        activeMonthMembers.map(async mm => {
          const memberEmail = String(mm.member_email || "").toLowerCase().trim();
          const memberRentRows = rentData.filter(r => String(r.member_email || "").toLowerCase().trim() === memberEmail);
          const rentStatus = summarizeRentStatus(memberRentRows);
          const rentAmt    = mm.rent_amount || 0;

          const memberMeals = monthMeals.filter(r => String(r.member_email || "").toLowerCase().trim() === memberEmail);
          const mealCount   = memberMeals.reduce(
            (s,r) => s+(r.lunch||0)+(r.dinner||0)+(r.guest_lunch||0)+(r.guest_dinner||0), 0
          );
          const mealCost  = mealCount * mealRate;
          const memberAdjustments = adjData
            .filter(a => String(a.member_email || "").toLowerCase().trim() === memberEmail);
          const autoRentPaidCredit = memberAdjustments
            .filter(a => String(a.remarks || "").trim() === RENT_PAYMENT_REMARKS)
            .reduce((s,a) => s+(a.amount||0), 0);
          const statusRentPaidCredit = String(rentStatus).trim().toLowerCase() === "paid" ? rentAmt : 0;
          const rentPaidCredit = Math.max(autoRentPaidCredit, statusRentPaidCredit);
          const monthAdj = memberAdjustments
            .filter(a => String(a.remarks || "").trim() !== RENT_PAYMENT_REMARKS)
            .reduce((s,a) => s+(a.amount||0), 0);
          const monthBazar = bazarList
            .filter(b => String(b.buyer_email || "").toLowerCase().trim() === memberEmail)
            .reduce((s,b) => s+(b.cost||0), 0);
          const monthDue  = monthBazar + monthAdj + rentPaidCredit - mealCost - rentAmt - utilitySplitPerHead;

          // Lifetime balance for every active member
          const lifeBreakdown = await calcLifetimeBalance(memberEmail);

          return {
            name:             mm.member_name,
            email:            memberEmail,
            rentStatus,
            rentAmount:       rentAmt,
            rentPaidCredit:   parseFloat(rentPaidCredit.toFixed(2)),
            rentCreditAppliedToMonthDue: true,
            monthBazar:       parseFloat(monthBazar.toFixed(2)),
            monthAdj:         parseFloat(monthAdj.toFixed(2)),
            monthMealCost:    parseFloat(mealCost.toFixed(2)),
            monthMealCount:   mealCount,
            monthSpecificDue: parseFloat(monthDue.toFixed(2)),
            overallBalance:   lifeBreakdown.net,
            lifeBreakdown,
          };
        })
      );

      // ── User's own rent status this month ─────────────────────────────────
      const userRentStatus = summarizeRentStatus(
        rentData.filter(r => String(r.member_email || "").toLowerCase().trim() === userEmail)
      );

      // ── User's own financials ─────────────────────────────────────────────
      const selfMember  = membersArray.find(m => m.email === userEmail);
      const lifeData    = selfMember ? selfMember.lifeBreakdown : await calcLifetimeBalance(userEmail);
      const userBalance = typeof lifeData === 'object' ? lifeData.net : lifeData;

      // ── Today's totals ────────────────────────────────────────────────────
      const lunchTotal  = todayMeals.reduce((s,r) => s+(r.lunch||0)+(r.guest_lunch||0),  0);
      const dinnerTotal = todayMeals.reduce((s,r) => s+(r.dinner||0)+(r.guest_dinner||0), 0);

      const activeRoster = todayMeals.map(r => ({
        name: r.member_name,
        details: `L: ${r.lunch} | D: ${r.dinner}${r.guest_lunch||r.guest_dinner?` | GL: ${r.guest_lunch} GD: ${r.guest_dinner}`:""}`,
      }));
      const userTodayMealRow = todayMeals.find(r => r.member_email === userEmail);
      const userTodayMeal = userTodayMealRow ? {
        date: userTodayMealRow.meal_date,
        name: userTodayMealRow.member_name,
        email: userTodayMealRow.member_email,
        lunch: userTodayMealRow.lunch,
        dinner: userTodayMealRow.dinner,
        guestLunch: userTodayMealRow.guest_lunch || 0,
        guestDinner: userTodayMealRow.guest_dinner || 0,
      } : null;

      // ── Available months list ─────────────────────────────────────────────
      const allMonthKeys = [
        ...new Set((allMonthsRes.data||[]).map(r => r.month_key).filter(Boolean))
      ].sort().reverse();
      if (!allMonthKeys.includes(targetMonth)) allMonthKeys.unshift(targetMonth);

      // ── Bazar log ─────────────────────────────────────────────────────────
      const bazarLog = bazarList.map(b => ({
        date: b.bazar_date, buyer: b.buyer_name, buyerEmail: b.buyer_email,
        items: b.items, cost: b.cost,
      })).reverse();

      // ── Full month meals ──────────────────────────────────────────────────
      const fullMonthMeals = monthMeals.map(r => ({
        date: r.meal_date, name: r.member_name,
        email: r.member_email,
        lunch: r.lunch, dinner: r.dinner,
        guestLunch: r.guest_lunch||0, guestDinner: r.guest_dinner||0,
      })).sort((a,b) => b.date.localeCompare(a.date));

      // ── Adjustment history ────────────────────────────────────────────────
      const adjustmentHistory = adjData.map(r => ({
        name: r.member_name, email: r.member_email,
        date: r.adjustment_date, amount: r.amount, remarks: r.remarks,
      })).reverse();

      // ── allMembersRaw (full directory, enriched with lifetime balance so admins ──
      // ── can view ALL members at once, not just those active this month) ──────
      const allMembersRaw = await Promise.all(allMemberDir.map(async m => {
        const email = String(m.email || "").toLowerCase().trim();
        const activeMatch = membersArray.find(am => am.email === email);
        if (activeMatch) {
          return {
            name: m.name,
            email,
            authority: m.authority,
            mobileNumber: m.mobile_number || "",
            isActiveThisMonth: true,
            rentStatus: activeMatch.rentStatus,
            rentAmount: activeMatch.rentAmount,
            rentPaidCredit: activeMatch.rentPaidCredit,
            rentCreditAppliedToMonthDue: activeMatch.rentCreditAppliedToMonthDue,
            monthSpecificDue: activeMatch.monthSpecificDue,
            overallBalance: activeMatch.overallBalance,
            lifeBreakdown: activeMatch.lifeBreakdown,
          };
        }
        // Not on this month's roster — still fetch lifetime balance so their
        // running total can be shown in the "All Members" balance view.
        const lifeBreakdown = await calcLifetimeBalance(email);
        return {
          name: m.name,
          email,
          authority: m.authority,
          mobileNumber: m.mobile_number || "",
          isActiveThisMonth: false,
          rentStatus: null,
          rentAmount: 0,
          rentPaidCredit: 0,
          rentCreditAppliedToMonthDue: true,
          monthSpecificDue: 0,
          overallBalance: lifeBreakdown.net,
          lifeBreakdown,
        };
      }));

      return sendJson(res, {
        success: true,
        lunchTotal, dinnerTotal,
        financials: {
          mealRate:   parseFloat(mealRate.toFixed(2)),
          userBalance,
          rentStatus: userRentStatus,
        },
        activeRoster,
        userTodayMeal,
        next7Preferences,
        mealDeadlineExtended,
        serverClock: getServerClock(),
        bazarSchedule: {
          splitBetween: bazarSplitBetween,
          periods: bazarPeriods,
          currentPerson: currentBazarPeriod?.memberName || "",
          currentPersonMobile: currentBazarMember?.mobile_number || "",
        },
        bazarMealPlan: canViewBazarMeal ? {
          canViewToday: true, canManage: isCurrentBazarMember,
          today: currentBazarMeal ? { lunch: currentBazarMeal.lunch_menu || "", dinner: currentBazarMeal.dinner_menu || "" } : null,
          period: isCurrentBazarMember ? currentBazarPeriod : null,
          meals: managedBazarMeals.map(r => ({ date: r.meal_date, lunch: r.lunch_menu || "", dinner: r.dinner_menu || "" })),
        } : { canViewToday: false, canManage: false, today: null, period: null, meals: [] },
        bazarList: bazarLog,
        fullMonthMeals,
        monthsList: allMonthKeys,
        membersArray,       // active members this month with balances
        allMembersRaw,      // full directory (for dropdowns)
        monthMembersRaw: activeMonthMembers.map(m => ({
          email:     m.member_email,
          name:      m.member_name,
          rentAmount: m.rent_amount || 0,
          status:    m.status,
        })),
        adjustmentHistory,
        utilityCostsRaw: {
          electricity: utilRow.electricity||0, wifi: utilRow.wifi||0,
          gas: utilRow.gas||0, filter: utilRow.filter||0,
          bua: utilRow.bua||0, other: utilRow.other||0,
        },
        headCount,
      });
    }

    // ════════════════════════════════════════════════════════════════════════
    // SUBMIT MEAL
    // ════════════════════════════════════════════════════════════════════════
    if (action === "submitMeal") {
      const { date, email, name, lunch, dinner, guestLunch, guestDinner } = req.body;
      const monthKey = monthOf(date);
      // Only allow if member is active in monthly_members for this month
      const { data: mmRow } = await db.from(MONTHLY_MEMBER_TABLE)
        .select("status").eq("month_key", monthKey)
        .eq("member_email", email.toLowerCase().trim()).maybeSingle();
      if (!mmRow || String(mmRow.status || "").trim().toLowerCase() !== "active") {
        return sendJson(res, { success: false, error: "You are not an active member for this month. Contact admin." }, 403);
      }
      const { error } = await db.from("meals").upsert(
        {
          meal_date: date, month_key: monthKey,
          member_name:  name.toUpperCase(),
          member_email: email.toLowerCase().trim(),
          lunch: parseFloat(lunch)||0, dinner: parseFloat(dinner)||0,
          guest_lunch: parseFloat(guestLunch)||0, guest_dinner: parseFloat(guestDinner)||0,
        },
        { onConflict: "meal_date,member_email" }
      );
      if (error) throw error;
      return sendJson(res, { success: true });
    }

    // ════════════════════════════════════════════════════════════════════════
    // SUBMIT NEXT 7 DAYS MEAL PREFERENCES
    // ════════════════════════════════════════════════════════════════════════
    if (action === "submitMealPreferences") {
      const { email, name, preferences } = req.body;
      const normalizedEmail = String(email || "").toLowerCase().trim();
      const normalizedName = String(name || "").toUpperCase();
      const safePreferences = Array.isArray(preferences) ? preferences.slice(0, 7) : [];

      const requested = safePreferences
        .map(p => ({
          date: String(p.date || "").slice(0, 10),
          lunch: parseFloat(p.lunch) || 0,
          dinner: parseFloat(p.dinner) || 0,
          guestLunch: parseFloat(p.guestLunch) || 0,
          guestDinner: parseFloat(p.guestDinner) || 0,
        }))
        .filter(p => /^\d{4}-\d{2}-\d{2}$/.test(p.date));

      if (!normalizedEmail || !requested.length) {
        return sendJson(res, { success: false, error: "No meal preferences selected." }, 400);
      }

      const monthKeys = [...new Set(requested.map(p => monthOf(p.date)))];
      const { data: activeRows, error: activeError } = await db.from(MONTHLY_MEMBER_TABLE)
        .select("month_key,status")
        .eq("member_email", normalizedEmail)
        .in("month_key", monthKeys);
      if (activeError) throw activeError;

      const activeMonthSet = new Set(
        (activeRows || [])
          .filter(r => String(r.status || "").trim().toLowerCase() === "active")
          .map(r => r.month_key)
      );

      const rows = requested
        .filter(p => activeMonthSet.has(monthOf(p.date)))
        .map(p => ({
          meal_date: p.date,
          month_key: monthOf(p.date),
          member_name: normalizedName,
          member_email: normalizedEmail,
          lunch: p.lunch,
          dinner: p.dinner,
          guest_lunch: p.guestLunch,
          guest_dinner: p.guestDinner,
        }));
      const skippedDates = requested
        .filter(p => !activeMonthSet.has(monthOf(p.date)))
        .map(p => p.date);

      if (!rows.length) {
        return sendJson(res, {
          success: false,
          error: "No active roster found for those dates. Ask admin to approve the month roster first.",
          skippedDates,
        }, 403);
      }

      const { error } = await db.from("meals").upsert(rows, { onConflict: "meal_date,member_email" });
      if (error) throw error;
      return sendJson(res, { success: true, savedCount: rows.length, skippedDates });
    }

    // BAZAR MEMBER: SAVE THE MENU FOR THEIR CURRENT BAZAR PERIOD
    if (action === "saveBazarMeals") {
      const email = String(req.body.email || "").toLowerCase().trim();
      const serverDate = todayStr();
      const monthKey = monthOf(serverDate);
      const todayDay = parseInt(serverDate.slice(8, 10), 10);
      const requestedMeals = Array.isArray(req.body.meals) ? req.body.meals.slice(0, 31) : [];
      const [{ data: setting }, { data: assignedRows, error: periodsError }] = await Promise.all([
        db.from(BAZAR_SETTINGS_TABLE).select("split_between").eq("month_key", monthKey).maybeSingle(),
        db.from(BAZAR_PERIODS_TABLE).select("*").eq("month_key", monthKey),
      ]);
      if (periodsError) throw periodsError;
      const { count: activeCount, error: activeError } = await db.from(MONTHLY_MEMBER_TABLE)
        .select("*", { count: "exact", head: true }).eq("month_key", monthKey).eq("status", "Active");
      if (activeError) throw activeError;
      const periods = buildBazarPeriods(monthKey, Math.max(1, parseInt(setting?.split_between, 10) || activeCount || 1), assignedRows || []);
      const ownedPeriod = periods.find(p => p.memberEmail && String(p.memberEmail).toLowerCase().trim() === email && todayDay >= p.startDay && todayDay <= p.endDay);
      if (!ownedPeriod) return sendJson(res, { success: false, error: "Only the running Bazar member can update this period's menu." }, 403);

      const rows = requestedMeals.map(m => {
        const date = String(m.date || "").slice(0, 10);
        const day = parseInt(date.slice(8, 10), 10);
        return {
          meal_date: date, month_key: monthKey, bazar_owner_email: email,
          lunch_menu: String(m.lunch || "").trim().slice(0, 250),
          dinner_menu: String(m.dinner || "").trim().slice(0, 250),
          updated_at: new Date().toISOString(),
          valid: monthOf(date) === monthKey && day >= ownedPeriod.startDay && day <= ownedPeriod.endDay,
        };
      }).filter(r => r.valid).map(({ valid, ...row }) => row);
      if (!rows.length) return sendJson(res, { success: false, error: "No valid Bazar-period meals were supplied." }, 400);
      const { error } = await db.from(BAZAR_MEALS_TABLE).upsert(rows, { onConflict: "meal_date" });
      if (error) throw error;
      return sendJson(res, { success: true, savedCount: rows.length });
    }

    // ════════════════════════════════════════════════════════════════════════
    // ADMIN: EXTEND TODAY'S MEAL ENTRY TIME
    // ════════════════════════════════════════════════════════════════════════
    if (action === "adminSetMealDeadlineOverride") {
      const overrideDate = String(req.body.date || todayStr()).slice(0, 10);
      const enabled = Boolean(req.body.enabled);
      if (enabled) {
        const { error } = await db.from(MEAL_DEADLINE_OVERRIDE_TABLE).upsert(
          { override_date: overrideDate, extended: true, updated_at: new Date().toISOString() },
          { onConflict: "override_date" }
        );
        if (error) throw error;
      } else {
        const { error } = await db.from(MEAL_DEADLINE_OVERRIDE_TABLE).delete().eq("override_date", overrideDate);
        if (error) throw error;
      }
      return sendJson(res, { success: true, mealDeadlineExtended: enabled });
    }

    // ════════════════════════════════════════════════════════════════════════
    // ADMIN: SAVE BAZAR SPLIT COUNT
    // ════════════════════════════════════════════════════════════════════════
    if (action === "adminSaveBazarSplit") {
      const monthYear = String(req.body.monthYear || monthOf(todayStr())).slice(0, 7);
      const splitBetween = Math.max(1, Math.min(daysInMonth(monthYear), parseInt(req.body.splitBetween, 10) || 1));
      const { error } = await db.from(BAZAR_SETTINGS_TABLE).upsert(
        { month_key: monthYear, split_between: splitBetween, updated_at: new Date().toISOString() },
        { onConflict: "month_key" }
      );
      if (error) throw error;
      const { error: clearError } = await db.from(BAZAR_PERIODS_TABLE).delete().eq("month_key", monthYear);
      if (clearError) throw clearError;
      return sendJson(res, { success: true });
    }

    // ════════════════════════════════════════════════════════════════════════
    // MEMBER: CLAIM ONE BAZAR PERIOD
    // ════════════════════════════════════════════════════════════════════════
    if (action === "claimBazarPeriod") {
      const monthYear = String(req.body.monthYear || monthOf(todayStr())).slice(0, 7);
      const startDay = parseInt(req.body.startDay, 10);
      const endDay = parseInt(req.body.endDay, 10);
      const normalizedEmail = String(req.body.email || "").toLowerCase().trim();
      const normalizedName = String(req.body.name || "").toUpperCase();
      if (!normalizedEmail || !startDay || !endDay || startDay > endDay || endDay > daysInMonth(monthYear)) {
        return sendJson(res, { success: false, error: "Invalid bazar period." }, 400);
      }

      const { data: mmRow } = await db.from(MONTHLY_MEMBER_TABLE)
        .select("status").eq("month_key", monthYear)
        .eq("member_email", normalizedEmail).maybeSingle();
      if (!mmRow || String(mmRow.status || "").trim().toLowerCase() !== "active") {
        return sendJson(res, { success: false, error: "You are not an active member for this month. Contact admin." }, 403);
      }

      const { data: userExisting, error: userExistingError } = await db.from(BAZAR_PERIODS_TABLE)
        .select("id").eq("month_key", monthYear).eq("member_email", normalizedEmail).maybeSingle();
      if (userExistingError) throw userExistingError;
      if (userExisting) {
        return sendJson(res, { success: false, error: "You already selected one bazar period for this month." }, 409);
      }

      const { data: periodExisting, error: periodExistingError } = await db.from(BAZAR_PERIODS_TABLE)
        .select("id,member_name").eq("month_key", monthYear)
        .eq("start_day", startDay).eq("end_day", endDay).maybeSingle();
      if (periodExistingError) throw periodExistingError;
      if (periodExisting) {
        return sendJson(res, { success: false, error: `This period is already locked for ${periodExisting.member_name}.` }, 409);
      }

      const { error } = await db.from(BAZAR_PERIODS_TABLE).insert({
        month_key: monthYear,
        start_day: startDay,
        end_day: endDay,
        member_email: normalizedEmail,
        member_name: normalizedName,
      });
      if (error) throw error;
      return sendJson(res, { success: true });
    }

    // ════════════════════════════════════════════════════════════════════════
    // SUBMIT BAZAR
    // ════════════════════════════════════════════════════════════════════════
    if (action === "submitBazar") {
      const { date, email, name, items, cost } = req.body;
      const monthKey = monthOf(date);
      const { data: mmRow } = await db.from(MONTHLY_MEMBER_TABLE)
        .select("status").eq("month_key", monthKey)
        .eq("member_email", email.toLowerCase().trim()).maybeSingle();
      if (!mmRow || String(mmRow.status || "").trim().toLowerCase() !== "active") {
        return sendJson(res, { success: false, error: "You are not an active member for this month. Contact admin." }, 403);
      }
      const { error } = await db.from("bazar_entries").insert({
        bazar_date: date, month_key: monthKey,
        buyer_name: name.toUpperCase(), buyer_email: email.toLowerCase().trim(),
        items, cost: parseFloat(cost)||0,
      });
      if (error) throw error;
      return sendJson(res, { success: true });
    }

    // ════════════════════════════════════════════════════════════════════════
    // ADMIN: TOGGLE RENT
    // ════════════════════════════════════════════════════════════════════════
    if (action === "adminToggleRent") {
      const { monthYear, targetEmail, targetName, status } = req.body;
      const normalizedEmail = String(targetEmail || "").toLowerCase().trim();
      const normalizedName = String(targetName || "").toUpperCase();
      const normalizedStatus = String(status || "").trim().toLowerCase() === "paid" ? "Paid" : "Due";

      const { data: monthMember, error: memberRentError } = await db.from(MONTHLY_MEMBER_TABLE)
        .select("rent_amount")
        .eq("month_key", monthYear)
        .eq("member_email", normalizedEmail)
        .maybeSingle();
      if (memberRentError) throw memberRentError;

      const rentAmount = parseFloat(monthMember?.rent_amount) || 0;

      const { error } = await db.from("rent_status").upsert(
        {
          month_key: monthYear,
          member_email: normalizedEmail,
          member_name:  normalizedName,
          status: normalizedStatus,
          pay_date: normalizedStatus === "Paid" ? todayStr() : null,
        },
        { onConflict: "month_key,member_email" }
      );
      if (error) throw error;

      const clearExistingCredit = () => db.from("adjustments")
        .delete()
        .eq("month_key", monthYear)
        .eq("member_email", normalizedEmail)
        .eq("remarks", RENT_PAYMENT_REMARKS);

      const { error: clearError } = await clearExistingCredit();
      if (clearError) throw clearError;

      if (normalizedStatus === "Paid" && rentAmount > 0) {
        const { error: creditError } = await db.from("adjustments").insert({
          adjustment_date: todayStr(),
          member_name: normalizedName,
          member_email: normalizedEmail,
          amount: rentAmount,
          remarks: RENT_PAYMENT_REMARKS,
          month_key: monthYear,
        });
        if (creditError) throw creditError;
      }

      return sendJson(res, { success: true });
    }

    // ════════════════════════════════════════════════════════════════════════
    // ADMIN: ADJUST BALANCE
    // ════════════════════════════════════════════════════════════════════════
    if (action === "adminAdjustBalance") {
      const { targetEmail, targetName, monthYear, amount, remarks } = req.body;
      const { error } = await db.from("adjustments").insert({
        adjustment_date: todayStr(),
        member_name:  targetName.toUpperCase(),
        member_email: targetEmail.toLowerCase().trim(),
        amount: parseFloat(amount),
        remarks, month_key: monthYear,
      });
      if (error) throw error;
      return sendJson(res, { success: true });
    }

    // ════════════════════════════════════════════════════════════════════════
    // ADMIN: OVERRIDE MEAL
    // ════════════════════════════════════════════════════════════════════════
    if (action === "adminOverrideMeal") {
      const { targetDate, targetEmail, targetName, lunch, dinner, guestLunch, guestDinner } = req.body;
      const { error } = await db.from("meals").upsert(
        {
          meal_date: targetDate, month_key: monthOf(targetDate),
          member_name:  targetName.toUpperCase(),
          member_email: targetEmail.toLowerCase().trim(),
          lunch: parseFloat(lunch)||0, dinner: parseFloat(dinner)||0,
          guest_lunch: parseFloat(guestLunch)||0, guest_dinner: parseFloat(guestDinner)||0,
        },
        { onConflict: "meal_date,member_email" }
      );
      if (error) throw error;
      return sendJson(res, { success: true });
    }

    // ════════════════════════════════════════════════════════════════════════
    // ADMIN: SUBMIT UTILITY COSTS
    // ════════════════════════════════════════════════════════════════════════
    if (action === "adminSubmitFixedCosts") {
      const { monthYear, electricity, wifi, gas, filter, bua, other } = req.body;
      const { error } = await db.from("utilities").upsert(
        {
          month_key: monthYear,
          electricity: parseFloat(electricity)||0, wifi: parseFloat(wifi)||0,
          gas: parseFloat(gas)||0, filter: parseFloat(filter)||0,
          bua: parseFloat(bua)||0, other: parseFloat(other)||0,
        },
        { onConflict: "month_key" }
      );
      if (error) throw error;
      await recalcAndStoreMealRate(db, monthYear);
      return sendJson(res, { success: true });
    }

    // ════════════════════════════════════════════════════════════════════════
    // ADMIN: EDIT BAZAR
    // ════════════════════════════════════════════════════════════════════════
    if (action === "adminEditBazar") {
      const { date, buyerEmail, items, cost } = req.body;
      const { error } = await db.from("bazar_entries")
        .update({ items, cost: parseFloat(cost)||0 })
        .eq("bazar_date", date)
        .eq("buyer_email", buyerEmail.toLowerCase().trim());
      if (error) throw error;
      await recalcAndStoreMealRate(db, monthOf(date));
      return sendJson(res, { success: true });
    }

    // ════════════════════════════════════════════════════════════════════════
    // ADMIN: DELETE BAZAR
    // ════════════════════════════════════════════════════════════════════════
    if (action === "adminDeleteBazar") {
      const { date, buyerEmail, cost } = req.body;
      const { error } = await db.from("bazar_entries")
        .delete()
        .eq("bazar_date", date)
        .eq("buyer_email", buyerEmail.toLowerCase().trim())
        .eq("cost", parseFloat(cost));
      if (error) throw error;
      await recalcAndStoreMealRate(db, monthOf(date));
      return sendJson(res, { success: true });
    }

    // ════════════════════════════════════════════════════════════════════════
    // ADMIN: EDIT ADJUSTMENT
    // ════════════════════════════════════════════════════════════════════════
    if (action === "adminEditAdjustment") {
      const { originalDate, email, newAmount, newRemarks } = req.body;
      const { error } = await db.from("adjustments")
        .update({ amount: parseFloat(newAmount), remarks: newRemarks })
        .eq("adjustment_date", originalDate)
        .eq("member_email", email.toLowerCase().trim());
      if (error) throw error;
      return sendJson(res, { success: true });
    }

    // ════════════════════════════════════════════════════════════════════════
    // ADMIN: DELETE ADJUSTMENT
    // ════════════════════════════════════════════════════════════════════════
    if (action === "adminDeleteAdjustment") {
      const { originalDate, email, amount } = req.body;
      const { error } = await db.from("adjustments")
        .delete()
        .eq("adjustment_date", originalDate)
        .eq("member_email", email.toLowerCase().trim())
        .eq("amount", parseFloat(amount));
      if (error) throw error;
      return sendJson(res, { success: true });
    }

    // ════════════════════════════════════════════════════════════════════════
    // ADMIN: SAVE MEMBER (directory only — no rent/status)
    // ════════════════════════════════════════════════════════════════════════
    if (action === "adminSaveMember") {
      const { originalEmail, name, email, password, mobileNumber, authority } = req.body;
      const newEmail    = email.toLowerCase().trim();
      const searchEmail = (originalEmail || newEmail).toLowerCase().trim();

      const row = {
        name:             name.toUpperCase(),
        email:            newEmail,
        password_legacy:  password,
        mobile_number:    String(mobileNumber || "").trim(),
        authority:        authority || "Member",
      };

      const { data: existing } = await db.from("members").select("email")
        .eq("email", searchEmail).maybeSingle();

      let error;
      if (existing) {
        ({ error } = await db.from("members").update(row).eq("email", searchEmail));
      } else {
        ({ error } = await db.from("members").insert(row));
      }
      if (isMissingMobileNumberColumn(error)) throw missingMobileNumberColumnError();
      if (error) throw error;
      return sendJson(res, { success: true });
    }

    // ════════════════════════════════════════════════════════════════════════
    // ADMIN: GET PRIOR MONTH ROSTER  (for approval suggestion)
    // ════════════════════════════════════════════════════════════════════════
    if (action === "getPriorMonthRoster") {
      const { monthYear } = req.query;
      const prior = priorMonth(monthYear);

      const [priorRes, allMembersRes] = await Promise.all([
        db.from(MONTHLY_MEMBER_TABLE).select("*").eq("month_key", prior).eq("status", "Active"),
        db.from("members").select("*"),
      ]);

      const priorList   = priorRes.data   || [];
      const allMembers  = allMembersRes.data || [];

      // Build suggestion: prior month active members with their rent
      const suggestion = priorList.map(m => ({
        email:      m.member_email,
        name:       m.member_name,
        rentAmount: m.rent_amount || 0,
      }));

      // All directory members (so admin can add new ones not in prior month)
      const directory = allMembers.map(m => ({ email: m.email, name: m.name }));

      return sendJson(res, { success: true, suggestion, directory, priorMonth: prior });
    }

    // ════════════════════════════════════════════════════════════════════════
    // ADMIN: APPROVE MONTH ROSTER
    // Writes monthly_members rows for the target month.
    // members = [{ email, name, rentAmount }]
    // ════════════════════════════════════════════════════════════════════════
    if (action === "approveMonthRoster") {
      const { monthYear, members, approvedBy } = req.body;

      // Delete existing rows for this month first (full replace)
      await db.from(MONTHLY_MEMBER_TABLE).delete().eq("month_key", monthYear);

      if (members && members.length > 0) {
        const rows = members.map(m => ({
          month_key:     monthYear,
          member_email:  m.email.toLowerCase().trim(),
          member_name:   m.name.toUpperCase(),
          rent_amount:   parseFloat(m.rentAmount) || 0,
          status:        "Active",
          approved_by:   approvedBy || "",
          approved_at:   todayStr(),
        }));
        const { error } = await db.from(MONTHLY_MEMBER_TABLE).insert(rows);
        if (error) throw error;
      }

      // Seed rent_status "Due" rows for each approved member
      if (members && members.length > 0) {
        const { data: existingRent } = await db.from("rent_status")
          .select("member_email").eq("month_key", monthYear);
        const existingEmails = new Set((existingRent||[]).map(r => r.member_email));
        const rentRows = members
          .filter(m => !existingEmails.has(m.email.toLowerCase().trim()))
          .map(m => ({
            month_key:    monthYear,
            member_email: m.email.toLowerCase().trim(),
            member_name:  m.name.toUpperCase(),
            status:       "Due",
          }));
        if (rentRows.length > 0) {
          await db.from("rent_status").insert(rentRows);
        }
      }

      return sendJson(res, { success: true });
    }

    // ════════════════════════════════════════════════════════════════════════
    // ADMIN: ADD/REMOVE SINGLE MEMBER FROM MONTH  (mid-month changes)
    // ════════════════════════════════════════════════════════════════════════
    if (action === "monthlyMemberUpsert") {
      const { monthYear, email, name, rentAmount, status, approvedBy } = req.body;
      const { error } = await db.from(MONTHLY_MEMBER_TABLE).upsert(
        {
          month_key:    monthYear,
          member_email: email.toLowerCase().trim(),
          member_name:  name.toUpperCase(),
          rent_amount:  parseFloat(rentAmount) || 0,
          status:       status || "Active",
          approved_by:  approvedBy || "",
          approved_at:  todayStr(),
        },
        { onConflict: "month_key,member_email" }
      );
      if (error) throw error;

      // Seed rent row if activating
      if (status === "Active") {
        await db.from("rent_status").upsert(
          {
            month_key:    monthYear,
            member_email: email.toLowerCase().trim(),
            member_name:  name.toUpperCase(),
            status:       "Due",
          },
          { onConflict: "month_key,member_email" }
        );
      }
      return sendJson(res, { success: true });
    }

    // ════════════════════════════════════════════════════════════════════════
    // NOTIFICATIONS
    // ════════════════════════════════════════════════════════════════════════
    if (action === "getNotifications") {
      const userEmail = String(req.query.email || "").toLowerCase().trim();
      await cleanupOldNotifications(db);

      const { data: rows, error } = await db
        .from(NOTIFICATIONS_TABLE)
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;

      let readSet = new Set();
      if (userEmail) {
        const { data: reads, error: readsErr } = await db
          .from(NOTIFICATION_READS_TABLE)
          .select("notification_id")
          .eq("member_email", userEmail);
        if (readsErr) throw readsErr;
        readSet = new Set((reads || []).map(r => r.notification_id));
      }

      const notifications = (rows || []).map(n => ({
        id: n.id,
        title: n.title,
        message: n.message,
        type: n.notif_type,
        createdByEmail: n.created_by_email,
        createdByName: n.created_by_name,
        createdAt: n.created_at,
        isMine: Boolean(userEmail) && n.created_by_email === userEmail,
        read: readSet.has(n.id),
      }));
      const unreadCount = notifications.filter(n => !n.read).length;

      return sendJson(res, { success: true, notifications, unreadCount });
    }

    if (action === "sendNotification") {
      const { email, name, title, message } = req.body;
      const userEmail = String(email || "").toLowerCase().trim();
      const cleanTitle = String(title || "").trim();
      const cleanMessage = String(message || "").trim();
      if (!userEmail) return sendJson(res, { success: false, error: "You must be logged in to send a notification." });
      if (!cleanTitle || !cleanMessage) return sendJson(res, { success: false, error: "Title and message are required." });

      const { data: sender } = await db.from("members").select("authority")
        .eq("email", userEmail).maybeSingle();
      if (String(sender?.authority || "").toLowerCase() === "bua") {
        return sendJson(res, { success: false, error: "Not permitted." });
      }

      const { error } = await db.from(NOTIFICATIONS_TABLE).insert({
        title: cleanTitle.slice(0, 140),
        message: cleanMessage.slice(0, 1000),
        notif_type: "custom",
        created_by_email: userEmail,
        created_by_name: name || "Member",
      });
      if (error) throw error;
      await cleanupOldNotifications(db);
      return sendJson(res, { success: true });
    }

    if (action === "editNotification") {
      const { id, email, title, message } = req.body;
      const userEmail = String(email || "").toLowerCase().trim();
      const cleanTitle = String(title || "").trim();
      const cleanMessage = String(message || "").trim();
      if (!cleanTitle || !cleanMessage) return sendJson(res, { success: false, error: "Title and message are required." });

      const { data: requester } = await db.from("members").select("authority")
        .eq("email", userEmail).maybeSingle();
      const isAdmin = String(requester?.authority || "").toLowerCase() === "admin";

      let query = db.from(NOTIFICATIONS_TABLE)
        .update({ title: cleanTitle.slice(0, 140), message: cleanMessage.slice(0, 1000) })
        .eq("id", id);
      if (!isAdmin) query = query.eq("created_by_email", userEmail);
      const { error } = await query;
      if (error) throw error;
      return sendJson(res, { success: true });
    }

    if (action === "deleteNotification") {
      const { id, email } = req.body;
      const userEmail = String(email || "").toLowerCase().trim();

      const { data: requester } = await db.from("members").select("authority")
        .eq("email", userEmail).maybeSingle();
      const isAdmin = String(requester?.authority || "").toLowerCase() === "admin";

      let query = db.from(NOTIFICATIONS_TABLE).delete().eq("id", id);
      if (!isAdmin) query = query.eq("created_by_email", userEmail);
      const { error } = await query;
      if (error) throw error;
      return sendJson(res, { success: true });
    }

    if (action === "markNotificationRead") {
      const { id, email } = req.body;
      const userEmail = String(email || "").toLowerCase().trim();
      if (!userEmail) return sendJson(res, { success: false, error: "Missing user." });
      const { error } = await db.from(NOTIFICATION_READS_TABLE)
        .upsert({ notification_id: id, member_email: userEmail }, { onConflict: "notification_id,member_email" });
      if (error) throw error;
      return sendJson(res, { success: true });
    }

    if (action === "markAllNotificationsRead") {
      const { email } = req.body;
      const userEmail = String(email || "").toLowerCase().trim();
      if (!userEmail) return sendJson(res, { success: false, error: "Missing user." });
      const { data: rows, error } = await db.from(NOTIFICATIONS_TABLE).select("id");
      if (error) throw error;
      const upsertRows = (rows || []).map(r => ({ notification_id: r.id, member_email: userEmail }));
      if (upsertRows.length) {
        const { error: upErr } = await db.from(NOTIFICATION_READS_TABLE)
          .upsert(upsertRows, { onConflict: "notification_id,member_email" });
        if (upErr) throw upErr;
      }
      return sendJson(res, { success: true });
    }

    return sendJson(res, { success: false, error: `Unknown action: ${action}` });

  } catch (err) {
    console.error("API Error:", err);
    return sendJson(res, { success: false, error: err.message || String(err) }, 500);
  }
}

// ── Recalculate and store meal rate ──────────────────────────────────────────
async function recalcAndStoreMealRate(db, monthKey) {
  const [mealsRes, bazarRes] = await Promise.all([
    db.from("meals").select("lunch,dinner,guest_lunch,guest_dinner").eq("month_key", monthKey),
    db.from("bazar_entries").select("cost").eq("month_key", monthKey),
  ]);
  const totalMeals = (mealsRes.data||[]).reduce(
    (s,r) => s+(r.lunch||0)+(r.dinner||0)+(r.guest_lunch||0)+(r.guest_dinner||0), 0
  );
  const totalCost = (bazarRes.data||[]).reduce((s,r) => s+(r.cost||0), 0);
  const rate = totalMeals > 0 && totalCost > 0 ? totalCost / totalMeals : 0;
  await db.from("monthly_meal_rates").upsert(
    { month_key: monthKey, meal_rate: parseFloat(rate.toFixed(4)) },
    { onConflict: "month_key" }
  );
  return rate;
}
