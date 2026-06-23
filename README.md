# TornQuest — Torn.com Daily Objective Tracker

A compact, dark-fantasy **MMORPG quest-tracker overlay** for a temporary 60-day money
campaign in [Torn.com](https://www.torn.com). It shows your daily objectives and the
**adaptive pace** needed to hit a monthly money goal — merc hits, training energy,
crimes/nerve, bounty slots and war mode — without warnings, KPI boards, or spreadsheet
clutter.

It reads your state from the **official Torn API** (energy/nerve bars, attacks, activity
log) and falls back to manual override buttons everywhere.

> **Read-only & rule-compliant.** TornQuest never automates any in-game action. It only
> *reads* via the official API and *displays* objectives — you do every action yourself
> in Torn's own UI. It will not trigger Torn's captcha / anti-bot guards. See
> "Compliance" below.

---

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) (Chrome, Edge, Firefox, etc.).
2. Open the Tampermonkey dashboard → **Create a new script** (or **Utilities → Import**).
3. Paste the contents of [`TornQuest.user.js`](TornQuest.user.js) and save
   (`Ctrl+S`). Tampermonkey installs it for `https://www.torn.com/*`.
4. Open Torn. The overlay appears in the **bottom-right** corner. Drag it anywhere;
   its position is remembered.

To update: re-paste the file over the old script, or use Tampermonkey's editor.

---

## API key setup

1. Click the ⚙ gear in the overlay header.
2. Get a key at **Torn → Settings → API Key**. A **Limited** or **Full Access** key is
   recommended so crime income and bounty claims can be read from your activity log.
   (A minimal/public key still powers the energy/nerve bars; the rest stays manual.)
3. Paste the key, click **Save**, then **Test API**.
   - Test shows per-scope results: `bars ✓ attacks ✓ log ✓`.
   - If you see `Log access unavailable`, just use the manual buttons or upgrade the key.
4. The key is stored **only in your browser's localStorage**, is sent **only to
   `api.torn.com`**, and is **never shown again** after saving (status reads
   `Saved` / `Missing`).

---

## How it works

### Adaptive pacing (no warnings)
- **Cane Fund** = campaign income vs target (default $6.00B over 60 days).
- **Needed / day** = remaining ÷ days left. If you fall behind it rises; if you get
  ahead it falls. The overlay only shows pace — it never says "you failed".

### Quest rows
| Row | Shows | Source |
|---|---|---|
| 🎃 Cane Fund | campaign $ / target, % | computed |
| ⚔ Merc Hits | hits done / target, $ income | attacks API (War OFF) + manual |
| 💪 Training | energy used / target | manual + split % |
| 🧠 Crimes | nerve used / potential, $ income / target, needed today | log API + manual |
| 💰 Bounty Slots | filled / target, est $ | manual + log claims |
| 🛡 War Mode | ON/OFF, attacks ignored, war payout | toggle + manual |

Footer: **Daily Income**, **Monthly Income**, **Days Left**, and a live **Reset in
HH:MM:SS · TCT 00:00** countdown.

### Spam-proof sync
Crime/attack income is **never** inferred from nerve-bar diffs (which would miss fast
crime spamming). Each sync re-fetches the day's events (attacks + crime/bounty log) and
**re-sums them, deduped by event id** — so bursts are never lost and never double-counted.
Bars are polled only for the current energy/nerve display. Default cadence is 60s (well
under Torn's ~100 req/min limit); there's also a manual ⟳ **Sync now** button.

### Daily reset (TCT = UTC)
At **UTC 00:00** the finished day is snapshotted into history (for later trends/averages),
daily counters zero out, and the campaign total carries over.

---

## Manual controls

Every row has override buttons (open a row with `▼`):
- **Merc:** +1 / +5 / −1 hit
- **Training:** +25E / +100E / −25E
- **Crimes:** + income ($), + nerve (N)
- **Bounty:** +1 / +5 / +10 filled, +1 claimed, +1 expired, edit active slots
- **War:** toggle ON/OFF + a **war-payout ledger** — add a payout any time (wars recur),
  see each one listed with its date, and **edit** or **remove** individual entries. War
  payouts are campaign-level (they persist across the daily reset and feed the campaign
  total directly), and any added today also show in Daily Income.
- **Footer:** + OC / misc income ($) — for other sporadic income (organised-crime
  payouts, etc.). War payouts go in the War Mode row, not here.

Header buttons: ⟳ sync · ⚙ settings · — collapse · ✕ hide (a floating 🎃 re-opens it).

## Backup
Settings → **Export JSON** (copies all data + settings to clipboard) / **Import JSON** /
**Reset all**.

---

## Settings reference (defaults)

| Setting | Default |
|---|---|
| Campaign target | $6,000,000,000 |
| Campaign length | 60 days |
| Daily energy budget | 1380 E (≈ 3 xanax + refill + regen) |
| Energy split | 80% merc / 20% training |
| Energy per hit | 25 |
| Merc hit value | $1,000,000 |
| Max nerve / regen | 125 / 288 per day |
| Avg crime $ / 125N | $3,000,000 |
| Nerve refill | = max nerve (auto-synced) × 1 refill/day |
| Beer | uses/day × 1.5 N (+ "other alcohol" nerve) |
| Bounty slot value | $100,000 |
| Bounty daily target | 64 |
| Sync interval | 60 s |

All are editable in the gear panel.

---

## Compliance

Mirrors the read-only ethos of this workspace's TornWatcher bot:

- **No game-action automation** — no clicking/submitting attacks, crimes, or item use.
- **Official API only**, read-only selections (`bars`, `attacks`, `log`) via
  `GM_xmlhttpRequest` to `api.torn.com`.
- **Rate limit respected** (few batched calls per cycle) with **backoff on error code 5**.
- **Minimal, idempotent DOM** — only our own overlay is injected.
- **Key** stored locally, never logged, never shown after save, sent only to Torn.

---

## Known limitations / TODO

- Exact Torn API v2 shapes for `/user/attacks` pagination and `/user/log` category ids
  are parsed **defensively** with `// TODO` markers in the source; if a future API change
  breaks auto-parsing, the manual buttons keep everything working. Verify against your
  own log/attacks output and tighten the parsers as needed.
- Merc income assumes external (offsite) payment, so it is `hits × hit value`, not a
  value the API can see.
