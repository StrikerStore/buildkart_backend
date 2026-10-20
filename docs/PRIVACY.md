# BuildKart: privacy and data protection runbook

How the shop meets the **Digital Personal Data Protection Act, 2023** and the **DPDP Rules, 2025**: what is
held, who receives it, how long it is kept, how requests and breaches are handled, and what to do when
something goes wrong. Most of the rules take effect on **13 May 2027**.

This is the operating manual. The customer-facing promises are in the Privacy Notice
(`content/policies/json/privacy-policy.json`); where the two describe the same thing, they must agree.

---

## 1. Who does what

| Role | Who | What |
|---|---|---|
| Data Fiduciary | The business | Decides why and how personal data is used. Answers for everything below. |
| Grievance officer | Named in **Admin → Settings → Grievance officer** | Answers privacy requests and complaints; named on the website and in every breach notice. |
| Owner account(s) | `OWNER` role | The only role with `privacy:manage` (requests, downloads, erasure, breaches) and `audit:read` (change log, records opened). |
| Staff accounts | `STAFF` role | Orders, catalogue, customers and support. No settings, payments, privacy, change log or deletions. |
| Processors | See §2 | Act on the shop's instructions only. |

---

## 2. What is held, and who receives it

**Held about customers:** phone number (the account), name, email, GSTIN, delivery addresses and map
pins, orders and invoices, payments (gateway references, never full card numbers), wallet credit, support
conversations and photos, WhatsApp message log, consents, nominee, and — only with consent — visit
analytics and Meta ad measurement.

**Held about people without an account:** a phone number and pincode for "tell me when you deliver
here", and receivers' names and numbers on orders.

**Processors** — `PROCESSORS` in `shared/src/privacy.ts` is the single list; the data export and the
notice read it:

| Processor | For | Receives |
|---|---|---|
| Railway | Hosting the website, API and database | Everything stored |
| Cloudflare | Files and photos (R2), delivering the site | Photos, pages loaded |
| AiSensy (Meta WhatsApp Business) | WhatsApp messages | Phone, name, message contents |
| Razorpay, PayU | Online payments | Name, phone, email |
| Google Maps, Mapbox, OpenStreetMap | Maps and address search | Coordinates and searches, no name or number |
| Meta | Ad measurement — **consent only** | Hashed phone, email, name, city, pincode; IP; pages and purchases |

**Owner task:** accept or sign each processor's data-processing terms and keep a copy. Rule 6(1)(f)
needs the contracts to require them to keep data safe.

---

## 3. How long it is kept

`RETENTION` in `shared/src/privacy.ts` is the schedule; the daily **`/cron/privacy`** job enforces it
(`core/src/write/privacy-retention.ts`). Change one and change the Privacy Notice with it.

| Data | Kept for |
|---|---|
| Sign-in codes, admin sign-in attempts | 1 year |
| Records opened by staff (`pii.view.*` in the change log) | 1 year |
| Admin change log | 3 years |
| WhatsApp messages | contents 90 days; log row 1 year |
| Meta events | IP and browser 10 days; event 1 year |
| Finished checkout copies (address, receiver, GSTIN) | 30 days |
| "Tell me when you deliver here" | 30 days after telling them, or 1 year |
| Browser and click ids on orders | 1 year (channel and campaign kept) |
| Closed support conversations | words and photos 2 years |
| Order and invoice personal details | 8 years after the financial year ends (then city, state, pincode only) |
| Deleted accounts | removed 7 days after the customer confirms |
| Breach records (`PrivacyIncident`) | kept — they are the proof the duties were met |
| Consent records | kept, without the phone after erasure — proof under §6(10) |

**The cron must run daily.** Railway → the API service → Cron: `GET <api>/cron/privacy` with header
`Authorization: Bearer <CRON_SECRET>`. The Privacy page in the admin shows when it last finished and
turns amber after 36 hours. A run that fails sends a "Privacy clean-up failed" WhatsApp to the shop.

---

## 4. Requests from customers

Customers serve themselves from **Account → Privacy and data**: download their data, change their
choices, correct their email, name a nominee, delete their account (code-confirmed, 7-day cooling-off),
and file a correction or complaint. Anything that arrives another way — a call, an email, a letter, someone
without an account — is recorded with **Privacy → Record a request**.

| Step | What |
|---|---|
| 1 | Every request lands in **Privacy → Requests** with a 90-day legal deadline. The shop's own target is the grievance officer's reply time (default 30 days). |
| 2 | Check it is really them: the account's own phone, or a WhatsApp from the number on file. Never act on a request about someone else's data. |
| 3 | Do what was asked — the request page says how for each kind. Erasure: **Erase now**, which refuses while an order is open or money is owed. |
| 4 | Close it with what was done, written for the customer. They are told on WhatsApp ("Privacy request answered"). |
| 5 | If they are not satisfied, they may complain to the Data Protection Board; the notice tells them so. |

---

## 5. Who can see what

- **Roles.** `shared/src/permissions.ts` is the matrix. Customer edits need `customers:write`, split from
  `customers:read` so a role can look a customer up without changing them. Staff have both today; take
  `customers:write` away from `STAFF` there if that is ever wanted.
- **Two-step sign-in.** Owners must sign in with a password and a code from an authenticator app; staff
  may turn it on under **Settings → Account**. Ten single-use recovery codes are shown once. The secret is
  sealed with `SETTINGS_ENCRYPTION_KEY`. `ADMIN_2FA_OPTIONAL=true` lifts the requirement — local
  development only.
- **Sessions last a day.** Changing a password, or turning on or moving two-step sign-in, signs out every
  other device.
- **Records opened.** Opening a customer, an order (including its invoice or challan) or a support
  conversation writes a `pii.view.*` row — once per admin, record and hour. **Change log → Area →
  Records opened** shows them; the default view hides them. Look through it monthly: anyone opening records
  with no order or ticket behind them is the thing to ask about.
- **Sign-in limits.** Five failures in 15 minutes, counted per email and per address, pauses sign-in
  and sends a "Security alert" WhatsApp to the shop. Five wrong codes after a right password also alerts —
  the password is known to whoever is typing.

### A lost phone

1. Sign in with one of the recovery codes (the shop is alerted that one was used).
2. **Settings → Account → Two-step sign-in → Move to a new phone.**
3. Make new recovery codes if few are left.

If the recovery codes are lost too, a developer resets it in the database, after confirming who is asking:

```sql
UPDATE `AdminUser`
   SET `totpSecretEnc` = NULL, `totpPendingEnc` = NULL, `totpEnabledAt` = NULL,
       `totpLastStep` = NULL, `totpRecoveryHashes` = NULL,
       `sessionVersion` = `sessionVersion` + 1
 WHERE `email` = 'owner@example.com';
```

An owner is then asked to set it up again at the next sign-in.

---

## 6. Alerts

The **Security alert** WhatsApp (`shop.securityAlert`) goes to the alert numbers under Messages → WhatsApp.
Approve its AiSensy template and switch it on, or these go only to the server log:

| Alert | Means | Do |
|---|---|---|
| Admin sign-in locked | Five wrong passwords | If it was not staff, change that password. Repeats from one address: block it at Cloudflare. |
| Wrong sign-in codes | Right password, five wrong codes | Change that password now. |
| Recovery code used | Someone signed in without the phone | Confirm it was them; if not, change the password and move two-step sign-in. |
| Change log not recording | Audit rows are failing to write | Check the database. Until fixed, changes are not traced. |
| Privacy clean-up failed | `/cron/privacy` threw | Read the API log for the run; fix, then call the endpoint by hand. |
| Breach notices stopped | A send was cut short | Press Send again on the incident; nobody is sent it twice. |

---

## 7. A breach

A personal data breach is any unauthorised use, sharing, loss or exposure of personal data — a leaked
export, a lost phone with the admin signed in, a delivery sheet sent to the wrong group, a hacked
account. **The clock starts when the shop becomes aware of it.**

1. **Contain.** Stop it continuing: change passwords, sign everyone out (change the password of every
   affected admin — it bumps `sessionVersion`), revoke keys (§9), delete what was shared, take the
   affected screen or service down if needed.
2. **Record.** **Privacy → Incidents → Record a breach**, at once, even with gaps. "When you found out"
   starts the 72-hour clock the page counts down.
3. **Assess.** What data, whose, how many, since when, and what it could lead to. Pick the audience:
   everyone, customers who ordered in a window, or a pasted list of numbers.
4. **Tell the people affected — without delay.** The incident page sends the "Data breach notice"
   WhatsApp (`customer.securityNotice`) to each, regardless of their message settings, once each. It must
   say what happened and when, what it could mean for them, what the shop has done, what they should do,
   and who to contact (rule 7(1)) — the form has one field for each, and the grievance officer's details are
   added automatically. The template must already be approved in AiSensy; set it up **before** it is
   needed.
5. **Tell the Data Protection Board — without delay**, on its online portal: what happened, when, where,
   how much, and the likely impact. Record the date on the incident.
6. **Detailed report to the Board within 72 hours** of becoming aware: the updated facts, the
   circumstances and reasons, what was done to limit it, what was found about who or what caused it, the
   remedial measures, and a report on how the people affected were told (the incident page's counts).
   Record the date and any reference.
7. **Close it** with notes: the cause, the fix, and what changes so it does not recur.

---

## 8. Backups

Rule 6(1)(d) asks for measures that keep personal data available after an incident.

- Turn on scheduled backups for the MySQL service in Railway, daily, and check they are running.
- Once a quarter, restore the latest backup into a separate database and open the admin against it:
  a backup never restored is a guess.
- A backup holds erased customers until it ages out. After a restore, run `/cron/privacy` and re-run any
  erasure done since the backup was taken (Privacy → Requests, closed erasures since that date).

---

## 9. Rotating keys

| Key | After changing it |
|---|---|
| `ADMIN_SESSION_SECRET` | Every admin is signed out. Nothing else. |
| `CUSTOMER_SESSION_SECRET` | Every customer is signed out. |
| `CRON_SECRET` | Update every Railway cron's header. |
| `SETTINGS_ENCRYPTION_KEY` | **Every sealed value stops opening**: re-enter each payment gateway's credentials, and reset two-step sign-in for every admin (§5). Only after a leak. |
| Gateway, AiSensy, R2, Meta keys | Generate in their dashboards, then paste into the admin or Railway. |

---

## 10. Where it lives in the code

| What | Where |
|---|---|
| Purposes, retention, processors, request and breach schemas | `shared/src/privacy.ts` |
| Consent records and choices | `core/src/write/privacy.ts` |
| Data export | `core/src/read/privacy-export.ts` |
| Requests | `core/src/{read,write}/privacy-requests.ts` |
| Erasure | `core/src/write/privacy-erasure.ts` |
| Retention job | `core/src/write/privacy-retention.ts` (`/cron/privacy`) |
| Breaches | `core/src/{read,write}/privacy-incidents.ts` |
| Two-step sign-in | `core/src/totp.ts`, `core/src/two-factor.ts`, `core/src/auth.ts` |
| Records opened | `recordAccess` in `core/src/audit.ts` |
| Security alerts | `notifyShopSecurityAlert` in `core/src/notify/dispatch.ts` |
| Consent banner and cookie | `website/components/analytics/consent-banner.tsx`, `website/lib/consent.ts` |
