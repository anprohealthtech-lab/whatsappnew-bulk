# Accountant recruitment intake

The `/recruitment` page shows CV files and the four requested answers for explicitly enrolled applicants. Recruitment is also available through the sidebar for accounts with Leads access. Super administrators can select an account to inspect its candidates.

Candidates are tied to their tenant, receiving official session and exact normalized phone. Unenrolled senders continue to use the existing clinical, guide and sales bots. Enrolled applicants route before the clinical media allow-list, so CV documents/photos are saved rather than ignored.

The initial invitation uses the existing approved `cv_received` English template, populated with the candidate's name and `Accounts Executive`. The official campaign worker handles pacing, suppression, attempt history and delivery receipts. Enrollment alone sends nothing. Starting requires the opt-in source and exact candidate IDs. A malformed exported phone is excluded rather than corrected by guessing.

After a reply the bot requests a latest CV, then asks current organisation, current CTC, expected CTC and area/city of residence one at a time. Candidates can defer their CV, provide labeled answers together, decline to share CTC, ask for a person, or decline the recruitment conversation. Bare salaries require a monthly/annual clarification. This flow records information for review and makes no hiring decisions.

CVs (PDF, DOC/DOCX, JPEG/PNG, up to 10 MB) are saved as bytes in `recruitment_cv_files` in the existing managed PostgreSQL database. They have no public upload URL. Downloads require authentication and the candidate's tenant. The `recruitment_candidates` and `recruitment_events` tables retain answers and deduplicate incoming message IDs across restarts. Reply intent is recorded before sending; ambiguous reply attempts are not automatically repeated.

## API

All routes require authentication. Super administrators may specify `?userId=<owner>`; other accounts can access only their own records.

- `GET /api/recruitment/candidates` — candidates, collected answers, CV count.
- `GET /api/recruitment/senders` — official sender session IDs.
- `POST /api/recruitment/enroll` — `{sessionId, recipients:[{name,phone,sourceLeadId,consentNote?}]}`. Idempotent enrollment; no outbound messages.
- `POST /api/recruitment/start` — `{sessionId,consentSource,candidateIds}`. Creates and starts the approved CV template campaign, reserving candidates to prevent duplicate initiation.
- `GET /api/recruitment/report.csv` — contact and answer export.
- `GET /api/recruitment/candidates/:id/files` — private CV metadata.
- `GET /api/recruitment/files/:id` — private attachment download.

The candidate states distinguish invitation queued, collecting, complete, declined and paused. A complete profile means the five requested inputs have been recorded, not that the candidate is shortlisted. Incoming messages older than 24 hours are not answered with free-form replies. STOP remains enforced by the existing tenant blocklist and official receipt ledger.

## Validation

Run `npx tsx --test server/recruitment/recruitment.test.ts server/cloud/cloud-campaigns.test.ts` from NodeBackend. Tests use isolated PGlite databases and make no live WhatsApp sends.
