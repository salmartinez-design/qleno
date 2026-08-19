# Customer book audit — 2026-08-19

Run `npx tsx ares-migration/audit-accounts.ts` (read-only) to regenerate.

## 1. The account structure is disconnected

25 of 26 accounts have properties on file and **zero clients linked**.
`clients.account_id` was never populated outside one consolidation on
2026-07-22 (Daveco, account #36 — the only account wired up correctly).

Pinnacle has 5 buildings, KMA 7, Cucci 6, ProManage 4 — all attached to nothing.

`match-clients-to-accounts.ts` places 46 clients across 23 accounts by street
address, covering **$10,175.53/mo**. Zero ambiguous, zero conflicts.

Four accounts match nothing and need a human: #1 Pinnacle Property Management,
#9 Meg Daday, #37 Chicago Straford Memorial, #42 Ricardo Davis.

## 2. Seven inactive clients carry $4,883.08/mo of live revenue

Ares says these are active paying customers; Qleno has them `is_active = false`.
One of the two systems is wrong — either Qleno is stale, or Ares is billing
accounts that stopped being served. 13% of the book.

| client | mrr | subs |
|---|---|---|
| #1359 Cucci Property Management | $2,090.98 | 6 |
| #1380 Joe Cusimano | $1,367.10 | 1 |
| #1271 10308 Circle Drive | $300.00 | 1 |
| #1272 5641 Circle Drive | $300.00 | 1 |
| #1289 Hickory Hills Condominium | $300.00 | 1 |
| #1461 Auto-Chlor System | $300.00 | 1 |
| #220 4128 W Cullom Condo Assoc | $225.00 | 1 |

## 3. ~20 duplicate residential records

Kourtney Witten x3, Shirley Chen, Ann Pancotto, Robert Soudan and others.
Same person entered twice. Nearly all carry $0 and one job. Dedup, not accounts.

## Before applying any linking

Two traps found while reviewing the proposal:

**Residents are not their building's account.** Address matching links an
individual who *lives* in a managed building to the manager's account:
#146 David De Arruda -> Heritage Condominium, #47 Jennifer Joy -> Erickson,
#1208 Sanaa Mohamed -> ProManage. Hold these for a human.

**Linking is not cosmetic.** `accounts.comms_enabled = false` is a master pause
on all automated SMS/email for every linked client, and
`auto_charge_on_completion` governs card charging. Run
`check-account-settings.ts` and exclude any account where either would change
behaviour.

**Test records to skip:** #1393 TESTMARIBEL CCCC, #1479 test, #1476 test test,
#1089 Phes Office — all match Phes's own office at 9850 S Cicero.
