// ==UserScript==
// @name         TornQuest — Daily Objective Tracker
// @namespace    https://github.com/tornquest
// @version      0.2.2
// @description  Compact dark-fantasy MMORPG-style quest tracker for a 60-day Torn money campaign. Tracks merc hits, training energy, crimes/nerve, bounty slots and war mode with adaptive daily pacing. Read-only (official API only) — never automates any in-game action.
// @author       TornQuest
// @match        https://www.torn.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @connect      api.torn.com
// @updateURL    https://raw.githubusercontent.com/Scrilleri/TornQuest/main/TornQuest.user.js
// @downloadURL  https://raw.githubusercontent.com/Scrilleri/TornQuest/main/TornQuest.user.js
// ==/UserScript==

// Auto-update: @updateURL/@downloadURL above point at the public GitHub raw file, so
// Tampermonkey auto-updates on its normal interval (or via "Check for userscript
// updates"). To go private instead, set both to
// file:///C:/discordbotit/TornQuest/TornQuest.user.js and enable TM "Allow access to
// file URLs".

/*
 * COMPLIANCE / ANTI-DETECTION (hard requirement):
 *   - No game-action automation of any kind. This script only READS state via the
 *     official Torn API and DISPLAYS objectives. The human performs every action
 *     manually in Torn's own UI. Nothing here clicks, submits, attacks, or uses items.
 *   - Official API only, read-only selections (bars / attacks / log) over
 *     GM_xmlhttpRequest to api.torn.com. This is the intended use of the API and does
 *     not trip Torn's captcha / anti-bot guards.
 *   - Rate limit respected (Torn allows ~100 req/min): one sync cycle issues only a
 *     few batched calls; a single throttle guards the interval; manual sync is debounced.
 *   - Backs off on API errors (esp. code 5 "too many requests") instead of hammering.
 *   - Minimal, idempotent DOM: we only inject our own overlay; we never rewrite or
 *     automate Torn's page elements.
 */

(function () {
  "use strict";

  // Run once even if Torn's SPA injects the script context oddly.
  if (window.__tornQuestLoaded) return;
  window.__tornQuestLoaded = true;

  // ========================================================================== //
  // DEFAULTS
  // ========================================================================== //

  const NS = "tornquest:v1";
  const API_BASE = "https://api.torn.com/v2";

  const DEFAULT_SETTINGS = {
    campaign: {
      target: 6_000_000_000, // "Cane Fund" total goal ($)
      days: 60, // campaign length in days (start captured on first run)
      startDate: null, // YYYY-MM-DD (UTC), set on first launch
      endDate: null, // YYYY-MM-DD (UTC), derived from start+days if null
    },
    energy: {
      dailyBudget: 1380, // 3 xanax (750) + refill (150) + natural regen (480)
      mercPct: 80, // % of energy budget aimed at merc hits
      trainingPct: 20, // % of energy budget aimed at training
      energyPerHit: 25, // energy per merc attack (lower with Love Juice)
    },
    merc: {
      hitValue: 1_000_000, // conservative $ per paid merc hit
    },
    crime: {
      maxNerve: 125,
      baseDailyNerve: 288, // 1 nerve / 5 min = 288/day
      avgPayoutPer125N: 3_000_000, // avg $ per full 125 nerve bar
      beerUsesPerDay: 0, // bottles of beer/day (booster cooldown, max 48h pool)
      beerAvgNerve: 1.5, // beer gives 1-2 nerve random
      otherAlcoholNerve: 0, // extra nerve/day from stronger alcohol (manual estimate)
      nerveRefillsPerDay: 1, // points nerve refills/day; each restores to max nerve
    },
    bounty: {
      slotValue: 100_000, // $ per filled/claimed bounty slot
      dailyTarget: 64, // slots to fill per day (objective)
    },
    sync: {
      autoSync: true,
      intervalSec: 60, // poll cadence (kept well under the rate limit)
    },
    ui: {
      pos: { right: 18, bottom: 18 },
      collapsed: false,
      hidden: false,
      openRows: {}, // rowKey -> bool (dropdown expanded)
    },
  };

  // ========================================================================== //
  // STORAGE  (one namespaced localStorage key)
  // ========================================================================== //

  function freshDaily(dayKey) {
    return {
      dayKey,
      // merc
      mercHitsAuto: 0,
      mercHitsManual: 0,
      ignoredAttacks: 0, // attacks made while War Mode ON (excluded from merc income)
      // training
      trainingEnergyUsed: 0, // manual entry (API can't reliably attribute training E)
      // crimes
      crimeNerveAuto: 0,
      crimeNerveManual: 0,
      crimeIncomeAuto: 0,
      crimeIncomeManual: 0,
      // bounty
      bountyFilled: 0,
      bountyClaimedAuto: 0,
      bountyClaimedManual: 0,
      bountyExpired: 0,
      activeSlots: 0,
      // war / misc
      warPayout: 0,
      manualIncome: 0,
    };
  }

  function defaultState() {
    return {
      settings: structuredClone(DEFAULT_SETTINGS),
      daily: freshDaily(utcDayKey()),
      campaign: { bankedIncome: 0, warPayouts: [] }, // banked daily income + sporadic war payout ledger
      history: [], // [{dayKey, income, mercHits, crimeIncome, bountyClaimed, nerveUsed, ...}]
      seenEventIds: {}, // event-id -> 1 (dedupe within the current day)
      meta: { selfId: null, lastSync: 0, lastSyncStatus: "", warMode: false },
      apiKey: "",
    };
  }

  // Deep-merge persisted settings onto defaults so new fields appear after upgrades.
  function mergeDefaults(target, defaults) {
    const out = Array.isArray(defaults) ? [] : {};
    for (const k of Object.keys(defaults)) {
      const d = defaults[k];
      const t = target ? target[k] : undefined;
      if (d && typeof d === "object" && !Array.isArray(d)) {
        out[k] = mergeDefaults(t || {}, d);
      } else {
        out[k] = t === undefined ? d : t;
      }
    }
    // keep any extra keys the caller had
    if (target && typeof target === "object") {
      for (const k of Object.keys(target)) if (!(k in out)) out[k] = target[k];
    }
    return out;
  }

  const store = {
    state: null,
    load() {
      let raw = null;
      try {
        raw = JSON.parse(localStorage.getItem(NS) || "null");
      } catch (e) {
        raw = null;
      }
      if (!raw) {
        this.state = defaultState();
      } else {
        this.state = raw;
        this.state.settings = mergeDefaults(raw.settings, DEFAULT_SETTINGS);
        this.state.daily = raw.daily || freshDaily(utcDayKey());
        this.state.campaign = raw.campaign || { bankedIncome: 0, warPayouts: [] };
        if (!Array.isArray(this.state.campaign.warPayouts)) this.state.campaign.warPayouts = [];
        this.state.history = raw.history || [];
        this.state.seenEventIds = raw.seenEventIds || {};
        this.state.meta = Object.assign(
          { selfId: null, lastSync: 0, lastSyncStatus: "", warMode: false },
          raw.meta || {}
        );
        this.state.apiKey = raw.apiKey || "";
      }
      // Capture campaign start on first run.
      const c = this.state.settings.campaign;
      if (!c.startDate) c.startDate = utcDayKey();
      if (!c.endDate) c.endDate = addDaysKey(c.startDate, c.days);
      this.save();
      return this.state;
    },
    save() {
      try {
        localStorage.setItem(NS, JSON.stringify(this.state));
      } catch (e) {
        console.warn("[TornQuest] save failed", e);
      }
    },
    exportJSON() {
      return JSON.stringify(this.state, null, 2);
    },
    importJSON(text) {
      const parsed = JSON.parse(text); // throws on bad input -> caller handles
      this.state = parsed;
      this.state.settings = mergeDefaults(parsed.settings, DEFAULT_SETTINGS);
      this.save();
    },
  };

  // ========================================================================== //
  // TIME  (TCT == UTC, per spec)
  // ========================================================================== //

  function utcDayKey(date) {
    const d = date ? new Date(date) : new Date();
    return d.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  }
  function addDaysKey(key, days) {
    const d = new Date(key + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }
  function daysBetween(fromKey, toKey) {
    const a = new Date(fromKey + "T00:00:00Z").getTime();
    const b = new Date(toKey + "T00:00:00Z").getTime();
    return Math.round((b - a) / 86400000);
  }
  function msUntilUtcMidnight() {
    const now = new Date();
    const next = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0)
    );
    return next.getTime() - now.getTime();
  }
  function secondsToHMS(totalSec) {
    totalSec = Math.max(0, Math.floor(totalSec));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
  }
  function todayStartUnix() {
    const now = new Date();
    return Math.floor(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0) / 1000
    );
  }

  // ========================================================================== //
  // FORMAT
  // ========================================================================== //

  function fmtMoney(n) {
    n = Number(n) || 0;
    const abs = Math.abs(n);
    if (abs >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (abs >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (abs >= 1e3) return (n / 1e3).toFixed(1) + "K";
    return String(Math.round(n));
  }
  function fmtMoneyShort(n) {
    n = Number(n) || 0;
    const abs = Math.abs(n);
    if (abs >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (abs >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (abs >= 1e3) return Math.round(n / 1e3) + "K";
    return String(Math.round(n));
  }
  function fmtInt(n) {
    return String(Math.round(Number(n) || 0));
  }
  function pct(part, whole) {
    if (!whole) return 0;
    return Math.max(0, Math.min(100, (part / whole) * 100));
  }
  function genId() {
    return "wp" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  // ========================================================================== //
  // CALC  (pure — adaptive pacing)
  // ========================================================================== //

  const calc = {
    // --- merc ---
    mercEnergyBudget(s) {
      return s.energy.dailyBudget * (s.energy.mercPct / 100);
    },
    mercTargetHits(s) {
      const perHit = s.energy.energyPerHit || 25;
      return Math.floor(this.mercEnergyBudget(s) / perHit);
    },
    mercHitsDone(d) {
      return (d.mercHitsAuto || 0) + (d.mercHitsManual || 0);
    },
    mercIncome(s, d) {
      return this.mercHitsDone(d) * s.merc.hitValue;
    },
    mercIncomeTarget(s) {
      return this.mercTargetHits(s) * s.merc.hitValue;
    },
    mercEnergyUsed(s, d) {
      return this.mercHitsDone(d) * (s.energy.energyPerHit || 25);
    },

    // --- training ---
    trainingTarget(s) {
      return Math.round(s.energy.dailyBudget * (s.energy.trainingPct / 100));
    },

    // --- crimes / nerve ---
    potentialDailyNerve(s) {
      // A points nerve refill always restores to MAX nerve, which itself grows over
      // time — so the refill bonus tracks s.crime.maxNerve (auto-synced from the API).
      return (
        s.crime.baseDailyNerve +
        (s.crime.nerveRefillsPerDay || 0) * (s.crime.maxNerve || 0) +
        (s.crime.beerUsesPerDay || 0) * (s.crime.beerAvgNerve || 0) +
        (s.crime.otherAlcoholNerve || 0)
      );
    },
    nerveUsed(d) {
      return (d.crimeNerveAuto || 0) + (d.crimeNerveManual || 0);
    },
    crimeIncome(d) {
      return (d.crimeIncomeAuto || 0) + (d.crimeIncomeManual || 0);
    },
    crimeDailyTarget(s) {
      return (this.potentialDailyNerve(s) / 125) * s.crime.avgPayoutPer125N;
    },
    crimeNeededToday(s, d) {
      return Math.max(0, this.crimeDailyTarget(s) - this.crimeIncome(d));
    },

    // --- bounty ---
    bountyEstIncome(s, d) {
      return (d.bountyFilled || 0) * s.bounty.slotValue;
    },
    bountyClaimed(d) {
      return (d.bountyClaimedAuto || 0) + (d.bountyClaimedManual || 0);
    },
    bountyClaimedIncome(s, d) {
      return this.bountyClaimed(d) * s.bounty.slotValue;
    },
    bountyIncomeTarget(s) {
      return s.bounty.dailyTarget * s.bounty.slotValue;
    },

    // --- war payouts (campaign-level ledger; sporadic, persist across daily resets) ---
    warPayoutsTotal(st) {
      return (st.campaign.warPayouts || []).reduce((a, e) => a + (Number(e.amount) || 0), 0);
    },
    warPayoutsInRange(st, startSec, endSec) {
      return (st.campaign.warPayouts || []).reduce((a, e) => {
        const sec = (e.ts || 0) / 1000;
        return sec >= startSec && sec < endSec ? a + (Number(e.amount) || 0) : a;
      }, 0);
    },
    warPayoutsToday(st) {
      const start = todayStartUnix();
      return this.warPayoutsInRange(st, start, start + 86400);
    },

    // --- daily / campaign ---
    // Base = the day's recurring income (banked into the campaign at reset).
    dailyIncomeBase(s, d) {
      return (
        this.mercIncome(s, d) +
        this.crimeIncome(d) +
        this.bountyClaimedIncome(s, d) +
        (d.manualIncome || 0)
      );
    },
    // Display total for today = base + any war payouts received today.
    dailyIncome(st) {
      return this.dailyIncomeBase(st.settings, st.daily) + this.warPayoutsToday(st);
    },
    campaignIncome(st) {
      return (
        (st.campaign.bankedIncome || 0) +
        this.dailyIncomeBase(st.settings, st.daily) +
        this.warPayoutsTotal(st)
      );
    },
    daysLeft(s) {
      const left = daysBetween(utcDayKey(), s.campaign.endDate);
      return Math.max(0, left);
    },
    neededPerDay(st) {
      const s = st.settings;
      const remaining = Math.max(0, s.campaign.target - this.campaignIncome(st));
      const left = Math.max(1, this.daysLeft(s));
      return remaining / left;
    },
  };

  // ========================================================================== //
  // API  (read-only, GM_xmlhttpRequest)
  // ========================================================================== //

  const api = {
    _backoffUntil: 0,

    _get(path, params) {
      const key = store.state.apiKey;
      return new Promise((resolve, reject) => {
        if (!key) return reject(new Error("no-key"));
        if (Date.now() < this._backoffUntil) return reject(new Error("backoff"));
        const qs = new URLSearchParams(Object.assign({ key }, params || {})).toString();
        const url = `${API_BASE}${path}${path.includes("?") ? "&" : "?"}${qs}`;
        GM_xmlhttpRequest({
          method: "GET",
          url,
          timeout: 20000,
          onload: (resp) => {
            let data;
            try {
              data = JSON.parse(resp.responseText);
            } catch (e) {
              return reject(new Error("bad-json"));
            }
            if (data && data.error) {
              const code = Number(data.error.code);
              // 5 = too many requests -> back off hard.
              if (code === 5) this._backoffUntil = Date.now() + 90000;
              return reject(
                Object.assign(new Error(data.error.error || "api-error"), { code })
              );
            }
            resolve(data);
          },
          onerror: () => reject(new Error("network")),
          ontimeout: () => reject(new Error("timeout")),
        });
      });
    },

    async fetchSelf() {
      // v2 basic returns { profile: { id, name, ... } }; own player id is profile.id.
      const data = await this._get("/user", { selections: "basic" });
      const p = data.profile || data;
      const id = p.id || p.player_id || data.player_id;
      if (id) store.state.meta.selfId = id;
      return id;
    },

    async fetchBars() {
      // v2: /user?selections=bars -> { energy:{current,maximum}, nerve:{...}, ... }
      const data = await this._get("/user", { selections: "bars" });
      const bars = data.bars || data; // tolerate both shapes
      return {
        energy: bars.energy || null,
        nerve: bars.nerve || null,
      };
    },

    async fetchAttacks(fromTs) {
      // v2: /user/attacks -> { attacks: [ { id, code, started, ended, attacker:{id}, defender:{id}, result, ... } ] }
      // TODO: confirm exact pagination param names; current API returns recent window.
      const data = await this._get("/user/attacks", { limit: 100 });
      let list = data.attacks || [];
      if (!Array.isArray(list)) list = Object.values(list);
      const self = store.state.meta.selfId;
      return list.filter((a) => {
        const ended = a.ended || a.timestamp_ended || a.started || 0;
        const attackerId = a.attacker && (a.attacker.id || a.attacker.ID);
        return ended >= fromTs && (!self || attackerId === self);
      });
    },

    async fetchLog(fromTs) {
      // v2: /user/log -> { log: [ { id, timestamp, title, category, data:{...} } ] }
      // TODO: confirm exact crime-success + bounty-claim category ids; we parse defensively.
      const data = await this._get("/user/log", { limit: 100 });
      let list = data.log || [];
      if (!Array.isArray(list)) list = Object.values(list);
      return list.filter((e) => (e.timestamp || 0) >= fromTs);
    },

    async testApi() {
      const result = { key: !!store.state.apiKey, bars: false, attacks: false, log: false, error: "" };
      if (!store.state.apiKey) {
        result.error = "Missing key";
        return result;
      }
      try {
        await this.fetchSelf();
      } catch (e) {
        /* basic may still work for bars below */
      }
      try {
        await this.fetchBars();
        result.bars = true;
      } catch (e) {
        result.error = e.message;
      }
      try {
        await this.fetchAttacks(todayStartUnix());
        result.attacks = true;
      } catch (e) {
        if (!result.error) result.error = e.message;
      }
      try {
        await this.fetchLog(todayStartUnix());
        result.log = true;
      } catch (e) {
        if (!result.error) result.error = e.message;
      }
      return result;
    },
  };

  // --- log parsing helpers (best-effort, manual fallback always available) --- //

  // Pull money + nerve from a crime log entry. Verified v2 shape (Crimes 2.0):
  //   { details:{ category:"Crimes", title:"Crime success money gain (new)" },
  //     data:{ crime_action, money_gained, nerve, outcome, items_gained } }
  // money_gained is present only when cash was gained; many crimes give items instead.
  function parseCrimeEntry(entry) {
    const details = entry.details || {};
    const category = (details.category || "").toLowerCase();
    const title = (details.title || entry.title || "").toLowerCase();
    const d = entry.data || {};
    const isCrime =
      category === "crimes" ||
      title.includes("crime") ||
      ("nerve" in d && "crime_action" in d);
    if (!isCrime) return null;
    let money = Number(d.money_gained ?? d.money ?? d.gain ?? d.profit ?? 0) || 0;
    let nerve = Number(d.nerve ?? d.nerve_used ?? 0) || 0;
    // legacy text fallback (older log lines like "...gaining $16,800")
    if (!money) {
      const m = title.match(/\$([\d,]+)/);
      if (m) money = Number(m[1].replace(/,/g, ""));
    }
    if (!money && !nerve) return null;
    return { money, nerve };
  }

  // Detect a "bounty claimed/collected (by you)" log entry.
  // TODO: confirm exact Bounties category title once a real claim is observed.
  function isBountyClaim(entry) {
    const details = entry.details || {};
    const category = (details.category || "").toLowerCase();
    const title = (details.title || entry.title || "").toLowerCase();
    return (
      (category.includes("bount") || title.includes("bounty")) &&
      /claim|collect|receiv|paid/.test(title)
    );
  }

  // ========================================================================== //
  // SYNC  (cumulative, spam-proof: re-aggregate today's events, dedupe by id)
  // ========================================================================== //

  let bars = { energy: null, nerve: null };

  async function syncNow(opts) {
    opts = opts || {};
    const st = store.state;
    if (!st.apiKey) {
      st.meta.lastSyncStatus = "No API key — manual mode";
      ui.render();
      return;
    }
    rolloverIfNeeded();
    const fromTs = todayStartUnix();
    let ok = [];
    let failed = [];

    if (!st.meta.selfId) {
      try {
        await api.fetchSelf();
      } catch (e) {
        /* non-fatal */
      }
    }

    // Bars (current energy/nerve display only).
    try {
      bars = await api.fetchBars();
      // Max nerve grows over time; keep it current so the refill bonus stays accurate.
      if (bars.nerve && bars.nerve.maximum > 0) st.settings.crime.maxNerve = bars.nerve.maximum;
      ok.push("bars");
    } catch (e) {
      failed.push("bars");
    }

    // Attacks -> merc hits (war-mode aware), deduped by attack id.
    try {
      const attacks = await api.fetchAttacks(fromTs);
      for (const a of attacks) {
        const id = "atk:" + (a.id || a.code);
        if (st.seenEventIds[id]) continue;
        st.seenEventIds[id] = 1;
        if (st.meta.warMode) st.daily.ignoredAttacks += 1;
        else st.daily.mercHitsAuto += 1;
      }
      ok.push("attacks");
    } catch (e) {
      failed.push("attacks");
    }

    // Log -> crime income + bounty claims, deduped by log id.
    try {
      const log = await api.fetchLog(fromTs);
      for (const e of log) {
        const id = "log:" + (e.id || `${e.timestamp}:${e.title}`);
        if (st.seenEventIds[id]) continue;
        const crime = parseCrimeEntry(e);
        const bounty = isBountyClaim(e);
        if (!crime && !bounty) continue; // don't burn the id on unrelated entries
        st.seenEventIds[id] = 1;
        if (crime) {
          st.daily.crimeIncomeAuto += crime.money;
          st.daily.crimeNerveAuto += crime.nerve;
        }
        if (bounty) st.daily.bountyClaimedAuto += 1;
      }
      ok.push("log");
    } catch (e) {
      failed.push("log");
    }

    st.meta.lastSync = Date.now();
    st.meta.lastSyncStatus =
      (ok.length ? "OK: " + ok.join(", ") : "") +
      (failed.length ? "  ·  unavailable: " + failed.join(", ") : "");
    store.save();
    ui.render();
  }

  // ========================================================================== //
  // RESET / HISTORY  (UTC 00:00 rollover)
  // ========================================================================== //

  function rolloverIfNeeded() {
    const st = store.state;
    const today = utcDayKey();
    if (st.daily.dayKey === today) return;

    // Bank the finished day's recurring income into the campaign. War payouts are NOT
    // banked here — they live in the campaign-level ledger and already count toward the
    // campaign total, so banking them too would double-count.
    const s = st.settings;
    const d = st.daily;
    const base = calc.dailyIncomeBase(s, d);
    const dayStartSec = Math.floor(new Date(d.dayKey + "T00:00:00Z").getTime() / 1000);
    const warForDay = calc.warPayoutsInRange(st, dayStartSec, dayStartSec + 86400);
    st.campaign.bankedIncome = (st.campaign.bankedIncome || 0) + base;
    st.history.push({
      dayKey: d.dayKey,
      income: base + warForDay, // total earned that day (for trends), war included
      mercHits: calc.mercHitsDone(d),
      mercIncome: calc.mercIncome(s, d),
      crimeIncome: calc.crimeIncome(d),
      nerveUsed: calc.nerveUsed(d),
      bountyClaimed: calc.bountyClaimed(d),
      bountyFilled: d.bountyFilled,
      trainingEnergy: d.trainingEnergyUsed,
      warPayout: warForDay,
      manualIncome: d.manualIncome,
    });
    if (st.history.length > 400) st.history = st.history.slice(-400);

    // Fresh day: zero counters, clear dedupe ids (yesterday's events are out of window).
    st.daily = freshDaily(today);
    st.seenEventIds = {};
    store.save();
  }

  // ========================================================================== //
  // UI
  // ========================================================================== //

  const ICON_GOLD = "#d9b65c";

  GM_addStyle(`
    #tq-root, #tq-root * { box-sizing: border-box; }
    #tq-root {
      position: fixed; z-index: 2147483000;
      width: 312px; max-width: calc(100vw - 16px);
      font-family: "Trebuchet MS", "Segoe UI", system-ui, sans-serif;
      color: #cdbb8a;
      background: rgba(12, 10, 8, 0.92);
      border: 1px solid ${ICON_GOLD};
      border-radius: 10px;
      box-shadow: 0 6px 26px rgba(0,0,0,.6), inset 0 0 22px rgba(0,0,0,.5);
      backdrop-filter: blur(2px);
      user-select: none;
    }
    #tq-root.tq-hidden { display: none; }
    .tq-header {
      display:flex; align-items:center; gap:8px;
      padding: 8px 10px; cursor: move;
      border-bottom: 1px solid rgba(217,182,92,.35);
      background: linear-gradient(180deg, rgba(217,182,92,.10), rgba(0,0,0,0));
      border-radius: 10px 10px 0 0;
    }
    .tq-title { font-weight: 700; letter-spacing:.5px; color:${ICON_GOLD}; font-size:13px; flex:1; }
    .tq-hbtn { cursor:pointer; color:#9c895c; font-size:14px; padding:0 4px; }
    .tq-hbtn:hover { color:${ICON_GOLD}; }
    .tq-body { padding: 6px 8px 8px; }
    #tq-root.tq-collapsed .tq-body { display:none; }

    .tq-row { border:1px solid rgba(217,182,92,.28); border-radius:8px; margin:6px 0;
      background: rgba(0,0,0,.25); overflow:hidden; }
    .tq-row-head { display:flex; align-items:center; gap:8px; padding:7px 9px; cursor:pointer; }
    .tq-ic { font-size:16px; width:20px; text-align:center; }
    .tq-name { font-weight:700; font-size:12.5px; flex:1; }
    .tq-vals { text-align:right; font-size:11px; line-height:1.25; }
    .tq-v1 { font-weight:700; }
    .tq-v2 { color:#9c895c; opacity:.85; }
    .tq-caret { color:#7d6c45; font-size:10px; width:12px; text-align:center; transition:transform .15s; }
    .tq-row.tq-open .tq-caret { transform: rotate(180deg); }
    .tq-drop { display:none; padding:6px 9px 9px; border-top:1px dashed rgba(217,182,92,.22);
      font-size:11px; }
    .tq-row.tq-open .tq-drop { display:block; }
    .tq-kv { display:flex; justify-content:space-between; padding:2px 0; }
    .tq-kv span:last-child { color:#e8d9a8; font-weight:600; }

    .tq-bar { height:4px; background:rgba(255,255,255,.08); border-radius:3px; margin-top:5px; overflow:hidden; }
    .tq-bar > i { display:block; height:100%; background:linear-gradient(90deg,#7a5,#d9b65c); }

    .tq-btns { display:flex; flex-wrap:wrap; gap:4px; margin-top:6px; }
    .tq-btn { cursor:pointer; font-size:10.5px; padding:3px 7px; border-radius:5px;
      border:1px solid rgba(217,182,92,.4); background:rgba(217,182,92,.08); color:#d9c890; }
    .tq-btn:hover { background:rgba(217,182,92,.2); }
    .tq-btn:active { transform:translateY(1px); }
    .tq-num { width:64px; background:#0c0a08; border:1px solid rgba(217,182,92,.4);
      color:#e8d9a8; border-radius:5px; padding:2px 5px; font-size:11px; }

    .tq-ledger { margin-top:6px; border-top:1px dashed rgba(217,182,92,.2); }
    .tq-led-row { display:flex; align-items:center; gap:6px; padding:3px 0; font-size:10.5px; }
    .tq-led-row > span:nth-child(1) { color:#9c895c; width:46px; }
    .tq-led-row > span:nth-child(2) { flex:1; color:#e8d9a8; font-weight:600; }
    .tq-mini { cursor:pointer; color:#b59a55; padding:1px 5px; border:1px solid rgba(217,182,92,.3); border-radius:4px; }
    .tq-mini:hover { color:#e8d9a8; background:rgba(217,182,92,.15); }
    .tq-empty { font-size:10.5px; color:#7d6c45; margin-top:5px; font-style:italic; }

    .tq-foot { margin-top:8px; padding-top:7px; border-top:1px solid rgba(217,182,92,.3); font-size:11px; }
    .tq-foot .tq-kv span:last-child { color:#e8d9a8; }
    .tq-reset { text-align:center; margin-top:6px; font-size:11px; color:#b59a55; letter-spacing:.5px; }

    .tq-toggle {
      position:fixed; z-index:2147483000; right:18px; bottom:18px;
      width:38px; height:38px; border-radius:50%; cursor:pointer;
      background:rgba(12,10,8,.92); border:1px solid ${ICON_GOLD}; color:${ICON_GOLD};
      font-size:18px; display:none; align-items:center; justify-content:center;
      box-shadow:0 4px 14px rgba(0,0,0,.5);
    }

    /* War mode pill */
    .tq-pill { font-weight:700; }
    .tq-pill.on { color:#e06666; }
    .tq-pill.off { color:#7faf6a; }

    /* settings panel */
    .tq-settings { padding:8px 10px; font-size:11.5px; max-height:70vh; overflow:auto; }
    .tq-settings h4 { color:${ICON_GOLD}; margin:10px 0 4px; font-size:11.5px; border-bottom:1px solid rgba(217,182,92,.25); padding-bottom:3px; }
    .tq-set-row { display:flex; justify-content:space-between; align-items:center; gap:8px; margin:4px 0; }
    .tq-set-row label { flex:1; color:#bbab7e; }
    .tq-set-row input { width:110px; background:#0c0a08; border:1px solid rgba(217,182,92,.4);
      color:#e8d9a8; border-radius:5px; padding:3px 6px; font-size:11px; }
    .tq-status { font-size:10.5px; color:#9c895c; margin-top:4px; min-height:14px; }
    .tq-status.ok { color:#7faf6a; } .tq-status.warn { color:#d9b65c; } .tq-status.err { color:#e06666; }

    @media (max-width: 600px) {
      #tq-root { width: calc(100vw - 16px); right:8px !important; left:auto; }
      .tq-btn { padding:5px 9px; font-size:11.5px; }
      .tq-num { width:72px; }
    }
  `);

  const ui = {
    root: null,
    toggleBtn: null,
    view: "main", // "main" | "settings"

    ensure() {
      if (this.root && document.body.contains(this.root)) return;
      this.build();
    },

    build() {
      // toggle button (shown when hidden)
      if (!this.toggleBtn) {
        const t = document.createElement("div");
        t.className = "tq-toggle";
        t.id = "tq-toggle";
        t.textContent = "🎃";
        t.title = "Show TornQuest";
        t.addEventListener("click", () => {
          store.state.settings.ui.hidden = false;
          store.save();
          this.render();
        });
        document.body.appendChild(t);
        this.toggleBtn = t;
      }

      const root = document.createElement("div");
      root.id = "tq-root";
      document.body.appendChild(root);
      this.root = root;
      this.applyPos();
      this.render();
      this.makeDraggable();
    },

    applyPos() {
      const p = store.state.settings.ui.pos || {};
      const r = this.root;
      if (p.left != null) {
        r.style.left = p.left + "px";
        r.style.right = "auto";
      } else {
        r.style.right = (p.right ?? 18) + "px";
        r.style.left = "auto";
      }
      if (p.top != null) {
        r.style.top = p.top + "px";
        r.style.bottom = "auto";
      } else {
        r.style.bottom = (p.bottom ?? 18) + "px";
        r.style.top = "auto";
      }
    },

    makeDraggable() {
      let sx, sy, ox, oy, dragging = false;
      const onDown = (e) => {
        if (e.target.closest(".tq-hbtn")) return;
        dragging = true;
        const t = e.touches ? e.touches[0] : e;
        sx = t.clientX; sy = t.clientY;
        const rect = this.root.getBoundingClientRect();
        ox = rect.left; oy = rect.top;
        e.preventDefault();
      };
      const onMove = (e) => {
        if (!dragging) return;
        const t = e.touches ? e.touches[0] : e;
        const nx = ox + (t.clientX - sx);
        const ny = oy + (t.clientY - sy);
        this.root.style.left = Math.max(0, nx) + "px";
        this.root.style.top = Math.max(0, ny) + "px";
        this.root.style.right = "auto";
        this.root.style.bottom = "auto";
      };
      const onUp = () => {
        if (!dragging) return;
        dragging = false;
        const rect = this.root.getBoundingClientRect();
        store.state.settings.ui.pos = { left: Math.round(rect.left), top: Math.round(rect.top) };
        store.save();
      };
      this.root.addEventListener("mousedown", (e) => {
        if (e.target.closest(".tq-header")) onDown(e);
      });
      this.root.addEventListener("touchstart", (e) => {
        if (e.target.closest(".tq-header")) onDown(e);
      }, { passive: false });
      window.addEventListener("mousemove", onMove);
      window.addEventListener("touchmove", onMove, { passive: false });
      window.addEventListener("mouseup", onUp);
      window.addEventListener("touchend", onUp);
    },

    toggleRow(key) {
      const o = store.state.settings.ui.openRows;
      o[key] = !o[key];
      store.save();
      this.render();
    },

    render() {
      if (!this.root) return;
      const st = store.state;
      const ui = st.settings.ui;

      // hidden state
      if (ui.hidden) {
        this.root.classList.add("tq-hidden");
        this.toggleBtn.style.display = "flex";
        return;
      }
      this.root.classList.remove("tq-hidden");
      this.toggleBtn.style.display = "none";
      this.root.classList.toggle("tq-collapsed", !!ui.collapsed);

      if (this.view === "settings") {
        this.renderSettings();
        return;
      }
      this.renderMain();
    },

    header(titleText, extraBtns) {
      return `
        <div class="tq-header">
          <span class="tq-title">${titleText}</span>
          ${extraBtns || ""}
        </div>`;
    },

    renderMain() {
      const st = store.state;
      const s = st.settings;
      const d = st.daily;
      const o = s.ui.openRows;

      const campIncome = calc.campaignIncome(st);
      const dailyIncome = calc.dailyIncome(st);
      const needPerDay = calc.neededPerDay(st);
      const warTotal = calc.warPayoutsTotal(st);
      const warToday = calc.warPayoutsToday(st);
      const warPayouts = st.campaign.warPayouts || [];

      const mercHits = calc.mercHitsDone(d);
      const mercTarget = calc.mercTargetHits(s);
      const mercInc = calc.mercIncome(s, d);
      const mercIncTarget = calc.mercIncomeTarget(s);

      const trainTarget = calc.trainingTarget(s);

      const potNerve = calc.potentialDailyNerve(s);
      const nerveUsed = calc.nerveUsed(d);
      const crimeInc = calc.crimeIncome(d);
      const crimeTarget = calc.crimeDailyTarget(s);
      const crimeNeed = calc.crimeNeededToday(s, d);

      const bFilled = d.bountyFilled || 0;
      const bEst = calc.bountyEstIncome(s, d);
      const bIncTarget = calc.bountyIncomeTarget(s);

      const warOn = st.meta.warMode;
      const daysLeft = calc.daysLeft(s);

      const energyNow = bars.energy ? `${bars.energy.current}/${bars.energy.maximum}` : "—";
      const nerveNow = bars.nerve ? `${bars.nerve.current}/${bars.nerve.maximum}` : "—";

      const row = (key, icon, name, v1, v2, barPct, dropHtml) => `
        <div class="tq-row ${o[key] ? "tq-open" : ""}" data-row="${key}">
          <div class="tq-row-head" data-toggle="${key}">
            <span class="tq-ic">${icon}</span>
            <span class="tq-name">${name}</span>
            <span class="tq-vals"><div class="tq-v1">${v1}</div>${v2 ? `<div class="tq-v2" style="color:#9c895c">${v2}</div>` : ""}</span>
            <span class="tq-caret">▼</span>
          </div>
          <div class="tq-drop">
            ${barPct != null ? `<div class="tq-bar"><i style="width:${barPct}%"></i></div>` : ""}
            ${dropHtml || ""}
          </div>
        </div>`;

      const headBtns = `
        <span class="tq-hbtn" data-act="sync" title="Sync now">⟳</span>
        <span class="tq-hbtn" data-act="settings" title="Settings">⚙</span>
        <span class="tq-hbtn" data-act="collapse" title="Collapse">${s.ui.collapsed ? "▢" : "—"}</span>
        <span class="tq-hbtn" data-act="hide" title="Hide">✕</span>`;

      this.root.innerHTML =
        this.header("⚔ CAMPAIGN", headBtns) +
        `<div class="tq-body">` +
        // Cane Fund
        row(
          "cane", "🎃", "Cane Fund",
          `${fmtMoney(campIncome)} / ${fmtMoney(s.campaign.target)}`,
          `${pct(campIncome, s.campaign.target).toFixed(1)}%`,
          pct(campIncome, s.campaign.target),
          `<div class="tq-kv"><span>Banked (prev days)</span><span>${fmtMoney(st.campaign.bankedIncome)}</span></div>
           <div class="tq-kv"><span>Today so far</span><span>${fmtMoney(dailyIncome)}</span></div>
           <div class="tq-kv"><span>Needed / day</span><span>${fmtMoney(needPerDay)}</span></div>`
        ) +
        // Merc Hits
        row(
          "merc", "⚔", "Merc Hits",
          `${fmtInt(mercHits)} / ${fmtInt(mercTarget)}`,
          `${fmtMoney(mercInc)} / ${fmtMoney(mercIncTarget)}`,
          pct(mercHits, mercTarget),
          `<div class="tq-kv"><span>Energy used (merc)</span><span>${fmtInt(calc.mercEnergyUsed(s, d))}E</span></div>
           <div class="tq-kv"><span>Hit value</span><span>$${fmtMoneyShort(s.merc.hitValue)}</span></div>
           <div class="tq-kv"><span>Auto / manual</span><span>${d.mercHitsAuto} / ${d.mercHitsManual}</span></div>
           <div class="tq-btns">
             <span class="tq-btn" data-act="merc+1">+1 hit</span>
             <span class="tq-btn" data-act="merc+5">+5</span>
             <span class="tq-btn" data-act="merc-1">−1</span>
           </div>`
        ) +
        // Training
        row(
          "train", "💪", "Training",
          `${fmtInt(d.trainingEnergyUsed)} / ${fmtInt(trainTarget)}E`,
          `${pct(d.trainingEnergyUsed, trainTarget).toFixed(0)}%`,
          pct(d.trainingEnergyUsed, trainTarget),
          `<div class="tq-kv"><span>Daily energy budget</span><span>${fmtInt(s.energy.dailyBudget)}E</span></div>
           <div class="tq-kv"><span>Split merc / train</span><span>${s.energy.mercPct}% / ${s.energy.trainingPct}%</span></div>
           <div class="tq-kv"><span>Current energy (API)</span><span>${energyNow}</span></div>
           <div class="tq-btns">
             <span class="tq-btn" data-act="train+25">+25E</span>
             <span class="tq-btn" data-act="train+100">+100E</span>
             <span class="tq-btn" data-act="train-25">−25E</span>
           </div>`
        ) +
        // Crimes
        row(
          "crime", "🧠", "Crimes",
          `${fmtInt(nerveUsed)}N / ${fmtInt(potNerve)}N`,
          `${fmtMoney(crimeInc)} / ${fmtMoney(crimeTarget)}`,
          pct(crimeInc, crimeTarget),
          `<div class="tq-kv"><span>Needed today</span><span>${fmtMoney(crimeNeed)}</span></div>
           <div class="tq-kv"><span>Avg / 125N</span><span>$${fmtMoneyShort(s.crime.avgPayoutPer125N)}</span></div>
           <div class="tq-kv"><span>Refill nerve (= max ${fmtInt(s.crime.maxNerve)})</span><span>+${fmtInt((s.crime.nerveRefillsPerDay||0)*(s.crime.maxNerve||0))}N</span></div>
           <div class="tq-kv"><span>Beer / alcohol nerve</span><span>+${fmtInt((s.crime.beerUsesPerDay||0)*(s.crime.beerAvgNerve||0)+(s.crime.otherAlcoholNerve||0))}N</span></div>
           <div class="tq-kv"><span>Current nerve (API)</span><span>${nerveNow}</span></div>
           <div class="tq-btns">
             <span class="tq-btn" data-act="crimeinc">+ income</span>
             <input class="tq-num" data-num="crimeinc" type="number" placeholder="$" />
             <span class="tq-btn" data-act="crimenerve">+ nerve</span>
             <input class="tq-num" data-num="crimenerve" type="number" placeholder="N" />
           </div>`
        ) +
        // Bounty
        row(
          "bounty", "💰", "Bounty Slots",
          `${fmtInt(bFilled)} / ${fmtInt(s.bounty.dailyTarget)}`,
          `${fmtMoney(bEst)} / ${fmtMoney(bIncTarget)}`,
          pct(bFilled, s.bounty.dailyTarget),
          `<div class="tq-kv"><span>Active slots</span><span>${d.activeSlots}</span></div>
           <div class="tq-kv"><span>Claimed today</span><span>${calc.bountyClaimed(d)} ($${fmtMoneyShort(calc.bountyClaimedIncome(s,d))})</span></div>
           <div class="tq-kv"><span>Expired today</span><span>${d.bountyExpired}</span></div>
           <div class="tq-kv"><span>Slot value</span><span>$${fmtMoneyShort(s.bounty.slotValue)}</span></div>
           <div class="tq-btns">
             <span class="tq-btn" data-act="bf1">+1 filled</span>
             <span class="tq-btn" data-act="bf5">+5</span>
             <span class="tq-btn" data-act="bf10">+10</span>
             <span class="tq-btn" data-act="bc1">+1 claimed</span>
             <span class="tq-btn" data-act="be1">+1 expired</span>
             <span class="tq-btn" data-act="bactive">edit active</span>
           </div>`
        ) +
        // War Mode + war-payout ledger (sporadic; re-addable, editable, persists)
        row(
          "war", "🛡", "War Mode",
          `<span class="tq-pill ${warOn ? "on" : "off"}">${warOn ? "ON" : "OFF"}</span>`,
          `${fmtMoney(warTotal)} payout`,
          null,
          `<div class="tq-kv"><span>Attacks ignored (war on)</span><span>${d.ignoredAttacks}</span></div>
           <div class="tq-kv"><span>Payout today</span><span>${fmtMoney(warToday)}</span></div>
           <div class="tq-kv"><span>Payout total (campaign)</span><span>${fmtMoney(warTotal)}</span></div>
           <div class="tq-btns">
             <span class="tq-btn" data-act="wartoggle">War mode: ${warOn ? "Turn OFF" : "Turn ON"}</span>
           </div>
           <div class="tq-btns">
             <input class="tq-num" data-num="warpay" type="number" placeholder="$ payout" />
             <span class="tq-btn" data-act="warpay">+ Add payout</span>
           </div>
           ${
             warPayouts.length
               ? `<div class="tq-ledger">` +
                 warPayouts
                   .slice()
                   .reverse()
                   .map(
                     (e) =>
                       `<div class="tq-led-row">
                          <span>${new Date(e.ts).toISOString().slice(5, 10)}</span>
                          <span>${fmtMoney(e.amount)}</span>
                          <span class="tq-mini" data-wpedit="${e.id}">edit</span>
                          <span class="tq-mini" data-wpdel="${e.id}">✕</span>
                        </div>`
                   )
                   .join("") +
                 `</div>`
               : `<div class="tq-empty">No war payouts added yet</div>`
           }`
        ) +
        // Footer
        `<div class="tq-foot">
           <div class="tq-kv"><span>Daily Income</span><span>${fmtMoney(dailyIncome)} / ${fmtMoney(needPerDay)}</span></div>
           <div class="tq-kv"><span>Monthly Income</span><span>${fmtMoney(campIncome)} / ${fmtMoney(s.campaign.target)}</span></div>
           <div class="tq-kv"><span>Days Left</span><span>${daysLeft} / ${s.campaign.days}</span></div>
           <div class="tq-kv"><span style="color:#7d6c45">War payouts → 🛡 War Mode row</span><span></span></div>
           <div class="tq-btns" style="margin-top:4px">
             <input class="tq-num" data-num="income" type="number" placeholder="$ OC / misc" />
             <span class="tq-btn" data-act="income">+ OC / misc income</span>
           </div>
           <div class="tq-reset" id="tq-reset">Reset in --:--:-- · TCT 00:00</div>
         </div>` +
        `</div>`;

      this.bindMain();
      this.tickReset();
    },

    bindMain() {
      const self = this;
      // header acts
      this.root.querySelectorAll(".tq-hbtn[data-act]").forEach((el) => {
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          const act = el.dataset.act;
          const s = store.state.settings;
          if (act === "settings") { self.view = "settings"; self.render(); }
          else if (act === "collapse") { s.ui.collapsed = !s.ui.collapsed; store.save(); self.render(); }
          else if (act === "hide") { s.ui.hidden = true; store.save(); self.render(); }
          else if (act === "sync") { syncNow({ manual: true }); }
        });
      });
      // row toggles
      this.root.querySelectorAll("[data-toggle]").forEach((el) => {
        el.addEventListener("click", () => self.toggleRow(el.dataset.toggle));
      });
      // action buttons
      this.root.querySelectorAll(".tq-btn[data-act]").forEach((el) => {
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          self.handleAction(el.dataset.act);
        });
      });
      // war-payout ledger edit / remove
      this.root.querySelectorAll("[data-wpedit]").forEach((el) => {
        el.addEventListener("click", (e) => { e.stopPropagation(); self.editWarPayout(el.dataset.wpedit); });
      });
      this.root.querySelectorAll("[data-wpdel]").forEach((el) => {
        el.addEventListener("click", (e) => { e.stopPropagation(); self.delWarPayout(el.dataset.wpdel); });
      });
    },

    numVal(key) {
      const inp = this.root.querySelector(`.tq-num[data-num="${key}"]`);
      const v = inp ? Number(inp.value) : 0;
      return isFinite(v) ? v : 0;
    },

    handleAction(act) {
      const st = store.state;
      const d = st.daily;
      const map = {
        "merc+1": () => (d.mercHitsManual += 1),
        "merc+5": () => (d.mercHitsManual += 5),
        "merc-1": () => (d.mercHitsManual = Math.max(-d.mercHitsAuto, d.mercHitsManual - 1)),
        "train+25": () => (d.trainingEnergyUsed += 25),
        "train+100": () => (d.trainingEnergyUsed += 100),
        "train-25": () => (d.trainingEnergyUsed = Math.max(0, d.trainingEnergyUsed - 25)),
        "crimeinc": () => (d.crimeIncomeManual += this.numVal("crimeinc")),
        "crimenerve": () => (d.crimeNerveManual += this.numVal("crimenerve")),
        "bf1": () => { d.bountyFilled += 1; d.activeSlots += 1; },
        "bf5": () => { d.bountyFilled += 5; d.activeSlots += 5; },
        "bf10": () => { d.bountyFilled += 10; d.activeSlots += 10; },
        "bc1": () => { d.bountyClaimedManual += 1; d.activeSlots = Math.max(0, d.activeSlots - 1); },
        "be1": () => { d.bountyExpired += 1; d.activeSlots = Math.max(0, d.activeSlots - 1); },
        "bactive": () => {
          const v = prompt("Active bounty slots:", d.activeSlots);
          if (v != null && isFinite(Number(v))) d.activeSlots = Math.max(0, Number(v));
        },
        "wartoggle": () => (st.meta.warMode = !st.meta.warMode),
        "warpay": () => {
          const amt = this.numVal("warpay");
          if (amt > 0) {
            if (!Array.isArray(st.campaign.warPayouts)) st.campaign.warPayouts = [];
            st.campaign.warPayouts.push({ id: genId(), ts: Date.now(), amount: amt });
          }
        },
        "income": () => (d.manualIncome += this.numVal("income")),
      };
      if (map[act]) {
        map[act]();
        store.save();
        this.render();
      }
    },

    editWarPayout(id) {
      const list = store.state.campaign.warPayouts || [];
      const e = list.find((x) => x.id === id);
      if (!e) return;
      const v = prompt("War payout amount ($):", e.amount);
      if (v != null && isFinite(Number(v))) {
        e.amount = Math.max(0, Number(v));
        store.save();
        this.render();
      }
    },
    delWarPayout(id) {
      const c = store.state.campaign;
      const e = (c.warPayouts || []).find((x) => x.id === id);
      if (!e) return;
      if (confirm(`Remove war payout of $${fmtInt(e.amount)}?`)) {
        c.warPayouts = c.warPayouts.filter((x) => x.id !== id);
        store.save();
        this.render();
      }
    },

    // ---- settings view ---- //
    renderSettings() {
      const st = store.state;
      const s = st.settings;
      const keyState = st.apiKey ? "Saved" : "Missing";
      const last = st.meta.lastSync
        ? new Date(st.meta.lastSync).toISOString().slice(11, 19) + " UTC"
        : "never";

      const num = (label, path, val, step) =>
        `<div class="tq-set-row"><label>${label}</label>
           <input type="number" step="${step || 1}" data-set="${path}" value="${val}"></div>`;
      const txt = (label, path, val) =>
        `<div class="tq-set-row"><label>${label}</label>
           <input type="text" data-set="${path}" value="${val ?? ""}"></div>`;

      this.root.classList.remove("tq-collapsed");
      this.root.innerHTML =
        this.header("⚙ SETTINGS", `<span class="tq-hbtn" data-back="1" title="Back">←</span>`) +
        `<div class="tq-settings">
          <h4>API key</h4>
          <div class="tq-set-row"><label>Key: <b>${keyState}</b></label>
            <input type="password" id="tq-key" placeholder="paste key"></div>
          <div class="tq-btns">
            <span class="tq-btn" data-s="savekey">Save</span>
            <span class="tq-btn" data-s="testkey">Test API</span>
            <span class="tq-btn" data-s="clearkey">Clear</span>
          </div>
          <div class="tq-status" id="tq-keystatus">Last sync: ${last}</div>
          <div style="font-size:10px;color:#7d6c45;margin-top:3px">Stored locally only · sent only to api.torn.com · never shown after save. Use a Limited/Full key for crime &amp; bounty logs.</div>

          <h4>Campaign</h4>
          ${num("Target $", "campaign.target", s.campaign.target, 1000000)}
          ${num("Days", "campaign.days", s.campaign.days)}
          ${txt("Start (UTC)", "campaign.startDate", s.campaign.startDate)}
          ${txt("End (UTC)", "campaign.endDate", s.campaign.endDate)}

          <h4>Energy</h4>
          ${num("Daily budget E", "energy.dailyBudget", s.energy.dailyBudget)}
          ${num("Merc %", "energy.mercPct", s.energy.mercPct)}
          ${num("Training %", "energy.trainingPct", s.energy.trainingPct)}
          ${num("Energy / hit", "energy.energyPerHit", s.energy.energyPerHit)}

          <h4>Merc</h4>
          ${num("Hit value $", "merc.hitValue", s.merc.hitValue, 50000)}

          <h4>Crimes</h4>
          ${num("Max nerve (auto from API)", "crime.maxNerve", s.crime.maxNerve)}
          ${num("Base nerve / day", "crime.baseDailyNerve", s.crime.baseDailyNerve)}
          ${num("Avg $ / 125N", "crime.avgPayoutPer125N", s.crime.avgPayoutPer125N, 100000)}
          ${num("Refills / day (= max nerve each)", "crime.nerveRefillsPerDay", s.crime.nerveRefillsPerDay)}
          ${num("Beer uses / day", "crime.beerUsesPerDay", s.crime.beerUsesPerDay)}
          ${num("Beer avg nerve", "crime.beerAvgNerve", s.crime.beerAvgNerve, 0.1)}
          ${num("Other alcohol nerve", "crime.otherAlcoholNerve", s.crime.otherAlcoholNerve)}

          <h4>Bounty</h4>
          ${num("Slot value $", "bounty.slotValue", s.bounty.slotValue, 10000)}
          ${num("Daily target", "bounty.dailyTarget", s.bounty.dailyTarget)}

          <h4>Sync</h4>
          ${num("Interval (sec)", "sync.intervalSec", s.sync.intervalSec)}
          <div class="tq-set-row"><label>Auto-sync</label>
            <input type="checkbox" data-set="sync.autoSync" ${s.sync.autoSync ? "checked" : ""}></div>

          <h4>Backup</h4>
          <div class="tq-btns">
            <span class="tq-btn" data-s="export">Export JSON</span>
            <span class="tq-btn" data-s="import">Import JSON</span>
            <span class="tq-btn" data-s="resethard">Reset all</span>
          </div>
          <div class="tq-status" id="tq-backupstatus"></div>
        </div>`;

      this.bindSettings();
    },

    bindSettings() {
      const self = this;
      this.root.querySelector("[data-back]").addEventListener("click", () => {
        self.view = "main";
        self.render();
      });

      // live-edit numeric/text/checkbox settings
      this.root.querySelectorAll("[data-set]").forEach((el) => {
        el.addEventListener("change", () => {
          const path = el.dataset.set.split(".");
          let obj = store.state.settings;
          for (let i = 0; i < path.length - 1; i++) obj = obj[path[i]];
          const leaf = path[path.length - 1];
          if (el.type === "checkbox") obj[leaf] = el.checked;
          else if (el.type === "number") obj[leaf] = Number(el.value);
          else obj[leaf] = el.value;
          store.save();
          restartSyncTimer();
        });
      });

      const status = (id, msg, cls) => {
        const e = self.root.querySelector("#" + id);
        if (e) { e.textContent = msg; e.className = "tq-status " + (cls || ""); }
      };

      this.root.querySelectorAll(".tq-btn[data-s]").forEach((el) => {
        el.addEventListener("click", async () => {
          const act = el.dataset.s;
          if (act === "savekey") {
            const inp = self.root.querySelector("#tq-key");
            const v = (inp.value || "").trim();
            if (v) { store.state.apiKey = v; store.save(); inp.value = ""; status("tq-keystatus", "Key saved.", "ok"); self.render(); }
            else status("tq-keystatus", "Nothing to save.", "warn");
          } else if (act === "clearkey") {
            store.state.apiKey = ""; store.save(); status("tq-keystatus", "Key cleared.", "warn"); self.render();
          } else if (act === "testkey") {
            status("tq-keystatus", "Testing…", "");
            const r = await api.testApi();
            if (!r.key) status("tq-keystatus", "No key saved.", "err");
            else {
              const parts = [`bars:${r.bars ? "✓" : "✗"}`, `attacks:${r.attacks ? "✓" : "✗"}`, `log:${r.log ? "✓" : "✗"}`];
              const allLog = r.log;
              status("tq-keystatus", parts.join("  ") + (allLog ? "" : "  · Log access unavailable — use manual controls or check key permissions"), allLog ? "ok" : "warn");
            }
          } else if (act === "export") {
            const text = store.exportJSON();
            navigator.clipboard?.writeText(text).then(
              () => status("tq-backupstatus", "Copied JSON to clipboard.", "ok"),
              () => { prompt("Copy your backup JSON:", text); }
            );
          } else if (act === "import") {
            const text = prompt("Paste backup JSON:");
            if (text) {
              try { store.importJSON(text); status("tq-backupstatus", "Imported.", "ok"); self.view = "main"; self.render(); }
              catch (e) { status("tq-backupstatus", "Invalid JSON.", "err"); }
            }
          } else if (act === "resethard") {
            if (confirm("Reset ALL TornQuest data and settings?")) {
              store.state = defaultState();
              store.state.settings.campaign.startDate = utcDayKey();
              store.state.settings.campaign.endDate = addDaysKey(utcDayKey(), store.state.settings.campaign.days);
              store.save(); self.view = "main"; self.render();
            }
          }
        });
      });
    },

    tickReset() {
      const el = this.root && this.root.querySelector("#tq-reset");
      if (!el) return;
      el.textContent = `Reset in ${secondsToHMS(msUntilUtcMidnight() / 1000)} · TCT 00:00`;
    },
  };

  // ========================================================================== //
  // TIMERS / BOOT
  // ========================================================================== //

  let syncTimer = null;
  function restartSyncTimer() {
    if (syncTimer) clearInterval(syncTimer);
    const s = store.state.settings.sync;
    if (s.autoSync && store.state.apiKey) {
      const ms = Math.max(20, s.intervalSec) * 1000;
      syncTimer = setInterval(() => syncNow(), ms);
    }
  }

  function boot() {
    store.load();
    rolloverIfNeeded();
    ui.ensure();

    // Keep the overlay alive across Torn's SPA re-renders (gentle, idempotent).
    setInterval(() => ui.ensure(), 2000);

    // 1s tick: live reset countdown + midnight rollover.
    setInterval(() => {
      rolloverIfNeeded();
      if (ui.view === "main") ui.tickReset();
    }, 1000);

    restartSyncTimer();
    if (store.state.apiKey) syncNow();
  }

  if (document.body) boot();
  else window.addEventListener("DOMContentLoaded", boot);
})();
