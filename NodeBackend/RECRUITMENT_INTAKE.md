# Accountant recruitment intake

The `/recruitment` page shows CV files and the four requested answers for explicitly enrolled applicants. Recruitment is also available through the sidebar for accounts with Leads access. Super administrators can select an account to inspect its candidates.

Candidates are tied to their tenant, receiving official session and exact normalized phone. Unenrolled senders continue to use the existing clinical, guide and sales bots. Enrolled applicants route before the clinical media allow-list, so CV documents/photos are saved rather than ignored.

The initial invitation uses `accountant_application_cv_request` in English, populated with the candidate's name. It asks for an updated CV to continue processing their Accountant application at MediTrust Clinics, Shela. Launch requires the template to be APPROVED in the UTILITY category. The official campaign worker handles pacing, suppression, attempt history and delivery receipts. Enrollment alone sends nothing. Starting requires the permission source for recruitment follow-ups and exact candidate IDs. A malformed exported phone is excluded rather than corrected by guessing. Duplicate protection covers both this template and the earlier `cv_received` template.

CV-sourced numbers must be the applicant's own contact number and must remain tied to the source application. Do not import references' or previous employers' numbers from a CV, or add applicants for other positions to the Accountant follow-up. Receiving a CV in an existing WhatsApp chat does not automatically start a second conversation on a different number mentioned in the file. Separate WhatsApp-specific consent is not required, but permission for relevant messages from the clinic still needs to be recorded.

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
