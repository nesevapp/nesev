# Tax notes and open questions

nesev's tax output (UVA, ZM, EAR, AfA, FinanzOnline upload files, BMD export) is a **helper, not tax advice**. It
follows Austrian rules as the author understands them and may be incomplete or wrong for a given situation. This page
lists the simplifications and the questions that should be checked with a tax advisor (Steuerberater). How the
calculations work is described in [architecture.md](architecture.md#taxes).

If you know the answer to one of these, or find a rule nesev gets wrong, please open an issue and cite the source
(law, BMF documentation, USP, a court decision).

## Revenue and VAT

1. **B2B services to EU clients in the UVA.** They are currently reported only in the ZM, not in the UVA (per BMF
   guidance). A setting reports them in KZ 000/021 instead. To confirm.
2. **Wording of the tax notes** printed on documents for reverse charge, third country and Kleinunternehmer. The
   defaults are editable in Einstellungen and should be checked.
3. **Goods vs. services.** All documents are treated as services: there is no ig. Lieferung (KZ 017), no Ausfuhr
   (KZ 011), no goods flag in the ZM and no domestic reverse charge (§ 19 Abs 1a UStG). Third-country private persons
   default to `THIRD_COUNTRY` under regular taxation, although for most B2C services the place of supply is Austria
   (§ 3a Abs 7 UStG; catalogue services under § 3a Abs 14 excepted).
4. **Sollbesteuerung by invoice date.** The UVA assigns invoices by their issue date, not by the end of the month of
   supply (§ 19 Abs 2 Z 1 lit a UStG). Late invoices can shift by at most one month.
5. **4,9 % rate (KZ 124/125, from 07/2026)** is not supported (no rate, no Kennzahl). The U30 XML would need it if the
   rate is ever used.

## Steuerstatus (Kleinunternehmer, Ist/Soll)

6. **Ist- vs. Sollbesteuerung and the UVA period** are set per date in Einstellungen → Belege → Umsatzsteuer
   (Steuerstatus with valid-from dates). nesev only checks that a Soll/Ist change starts on the first day of a UVA
   period; the other switch rules of § 17 UStG are not checked.
7. **Reference dates for the dated status:** issue date for revenue, Belegdatum for expenses, credit notes follow
   their invoice. Also to confirm: the treatment of invoices issued under Istbesteuerung and paid after a switch to
   Sollbesteuerung (currently counted at their payment).
8. **Kleinunternehmergrenze** is counted by the time of supply (end of the service period, else its start, else the
   invoice date), regardless of Ist/Soll; credit notes subtract by their issue date. Not every turnover counts towards
   the limit (e.g. Hilfsgeschäfte), which nesev can't tell apart.

## Reminders

9. **Default interest rate** in Mahnwesen: the placeholder is 11.2 % p.a. (base rate + 9.2 percentage points). Check
   it against the current OeNB base rate.

## Fixed assets / AfA

10. **AfA details:**
    - Halbjahresregel in the disposal year (currently full AfA plus the remaining book value, same total);
    - whether the remaining book value belongs in KZ 9130;
    - the useful-life defaults (Computer 3, Software 4, Büromöbel 10, Maschinen 8, PKW 8 years);
    - PKW Angemessenheitsgrenze (€ 40.000) and private use (not modelled);
    - Investitionsfreibetrag and degressive AfA (not modelled);
    - GWG ≤ € 1.000 may also be capitalized (allowed; the form only warns).

## Accountant export (BMD)

11. The BMD export is built from public interface descriptions and **has not been tested against BMD**. To check with
    the tax advisor, ideally with one test import:
    - Kontenplan (defaults: EKR 4000/4010/4013/4111/4210/4062, expenses 5000/5700/7xxx, SVS 6580, Anlagen 0620,
      Debitoren 20000, Kreditoren 33000, Bank 2800) and the number of digits of personal accounts;
    - Buchungssymbole (GU vs. AG for credit notes);
    - Steuercodes (77 vs. 21 for EU services, 81 vs. 20 for third-country revenue, EUSt 34; BMD can remap them per
      client) and the 13 % revenue account (4013 vs. 4011);
    - the receipt column name (`dokument`), the sign of `steuer` for self-assessed tax, encoding;
    - Istbesteuerung (BMD codes 903/904 are not used) and whether bank payments should be booked.

## FinanzOnline

12. The UVA (U30) and ZM (U13) upload files are checked against the BMF XML schemas and plausibility rules, but nesev
    transmits nothing: you upload the file in FinanzOnline yourself and check the values there.
