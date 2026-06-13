# Case Paper Upload and Parsing Guide

This document describes the case-paper pipeline currently implemented in this
application and a safer version to reuse in another application.

## 1. Current End-to-End Flow

The entry point is `processCasePaperWithAI()` in `src/services/ocrService.ts`.

1. The user selects an image or PDF.
2. The UI accepts JPEG, PNG, HEIC, HEIF, WebP, or PDF up to 10 MB.
3. A PDF is rendered in the browser at 2x scale as JPEG quality 0.92.
4. Although every PDF page is rendered, only the first generated image is used.
5. The processed image is uploaded to the Supabase Storage bucket
   `ocruploads`.
6. A row is inserted in `ocr_uploads` with status `processing`.
7. The image is converted to a base64 data URL in the browser.
8. `vision-ocr` sends the base64 image to Google Cloud Vision
   `images:annotate` with `TEXT_DETECTION`.
9. `gemini-clean-medical-text` removes clinic branding and non-clinical text.
10. `gemini-nlp` converts the cleaned text into structured JSON.
11. `validate-extracted-data` applies rule-based cleanup and fills some missing
    fields.
12. The result is inserted into `ocr_results`.
13. The `ocr_uploads` row is marked `completed`, and the structured values are
    loaded into the editable EMR form.

The frontend sends the Supabase access token to every Edge Function:

```http
Authorization: Bearer <supabase-access-token>
Content-Type: application/json
```

The Google API key is server-side only and is read from the Supabase secret:

```text
ALLGOOGLE_KEY
```

## 2. Upload Rules

Current client-side rules:

```text
Allowed MIME types:
- image/jpeg
- image/jpg
- image/png
- image/heic
- image/heif
- image/webp
- application/pdf

Maximum selected file size: 10 MB
```

PDF conversion:

```ts
convertPDFToSingleImage(file, {
  scale: 2.0,
  outputFormat: "image/jpeg",
  quality: 0.92
});
```

Important: `convertPDFToSingleImage()` returns only page 1. Multi-page case
papers are therefore only partially parsed.

## 3. Stage 1: Google Vision OCR

Endpoint:

```text
POST /functions/v1/vision-ocr
```

Request:

```json
{
  "imageBase64": "data:image/jpeg;base64,..."
}
```

Google Vision request:

```json
{
  "requests": [
    {
      "image": {
        "content": "<base64-without-data-url-prefix>"
      },
      "features": [
        {
          "type": "TEXT_DETECTION",
          "maxResults": 1
        }
      ]
    }
  ]
}
```

The function returns:

```json
{
  "success": true,
  "extractedText": "raw OCR text"
}
```

No language hint, handwriting hint, image preprocessing, deskewing, rotation
correction, or OCR confidence threshold is configured.

## 4. Stage 2: Medical Text Cleaning

Model:

```text
gemini-2.5-flash
```

Current application limits:

```text
Raw OCR input is truncated to: 30,000 characters
Approximate input allowance used by the code comment: 7,500 tokens
maxOutputTokens: 8,192
temperature: 0.1
topK: 1
topP: 1
```

The 30,000-character restriction is an application limit, not the Gemini
model's full context limit.

Provider limits documented for `gemini-2.5-flash`:

```text
Maximum input tokens:  1,048,576
Maximum output tokens: 65,536
```

This application uses only 8,192 maximum output tokens and intentionally
restricts OCR text to 30,000 characters.

Reusable cleaning prompt:

```text
You are a medical text cleaning AI specializing in processing raw OCR text
from Indian clinical prescriptions and case papers.

Your task is to extract only the medically relevant content from the input.
Remove all non-medical, administrative, and branding information. Return only
the core clinical data.

REMOVE:
- Clinic or hospital names, logos, slogans, and addresses
- Doctor names, degrees, titles, and registration numbers
- Phone numbers, email addresses, websites, and appointment timings
- Administrative headers, footers, and stationery marks
- Dates unless explicitly tied to symptom onset or follow-up
- Promotional lines, branding, legal disclaimers, billing, signatures, stamps

KEEP:
- Patient complaints and symptoms
- Vital signs
- Clinical examination findings and notes
- Diagnoses, including provisional diagnoses
- Medicines with dosage, frequency, duration, and instructions
- Laboratory and imaging tests ordered
- Medical advice, recommended procedures, and follow-up plans

Rules:
1. Do not interpret, infer, correct, or normalize clinical facts.
2. Preserve the original clinical language and dosages.
3. Return readable clinical text only, with no explanation.
4. If no clinical content exists, return exactly:
   No medical content detected

INPUT TEXT:
{{RAW_OCR_TEXT}}
```

Response:

```json
{
  "success": true,
  "cleanedMedicalText": "clinical text only",
  "originalLength": 1234,
  "cleanedLength": 650
}
```

## 5. Stage 3: Structured Medical Extraction

Current model in the repository:

```text
gemini-2.0-flash
```

Current generation settings:

```text
maxOutputTokens: 4,096
temperature: 0.1
topK: 1
topP: 1
```

The retired `gemini-2.0-flash` provider limits were 1,048,576 input tokens and
8,192 output tokens. This application requested at most 4,096 output tokens.

As of June 1, 2026, Google has shut down Gemini 2.0 Flash. Do not copy this
model identifier into a new application. Use a supported stable model and keep
the model name in configuration. `gemini-2.5-flash` is already used by the
cleaning stage and supports structured output.

Reusable extraction prompt:

```text
You are a highly accurate medical data extraction system for Indian clinical
case papers.

Extract only facts explicitly supported by the supplied clinical text. Do not
invent missing dosage, frequency, duration, instructions, diagnosis, ICD code,
test, symptom, or vital. Use null or an empty array when information is absent
or unreadable.

Requirements:
- Include every symptom and complaint that is present.
- Preserve medicine brand names and strengths as written.
- Distinguish tablets, capsules, syrups, injections, creams, ointments,
  lotions, shampoos, serums, drops, inhalers, and other dosage forms.
- Normalize frequency only when its meaning is unambiguous:
  once daily -> OD, twice daily -> BD, three times daily -> TID,
  four times daily -> QID, as needed -> PRN.
- Include ICD-10 only when the diagnosis clearly supports the code.
- Put laboratory and imaging orders in testsOrdered, not advice.
- Do not include clinic branding, doctor identity, contact details, billing,
  signatures, or administrative content.
- Return valid JSON only. Do not use Markdown fences.

Return this exact shape:
{
  "symptoms": [
    {
      "name": "string",
      "severity": "mild | moderate | severe | null",
      "duration": "string | null",
      "notes": "string | null",
      "sourceText": "string | null"
    }
  ],
  "vitals": {
    "temperature": "number | null",
    "bloodPressure": "string | null",
    "pulse": "number | null",
    "weight": "number | null",
    "height": "number | null",
    "respiratoryRate": "number | null",
    "oxygenSaturation": "number | null"
  },
  "diagnoses": [
    {
      "name": "string",
      "icd10Code": "string | null",
      "notes": "string | null",
      "isPrimary": "boolean",
      "sourceText": "string | null"
    }
  ],
  "prescriptions": [
    {
      "medicine": "string",
      "dosage": "string | null",
      "frequency": "string | null",
      "duration": "string | null",
      "instructions": "string | null",
      "quantity": "number | null",
      "refills": "number | null",
      "sourceText": "string | null"
    }
  ],
  "testsOrdered": [
    {
      "testName": "string",
      "testType": "lab | radiology | other",
      "instructions": "string | null",
      "urgency": "routine | urgent | stat | null",
      "sourceText": "string | null"
    }
  ],
  "advice": ["string"],
  "chiefComplaint": "string | null",
  "doctorNotes": "string | null",
  "warnings": ["string"]
}

CLINICAL TEXT:
{{CLEANED_MEDICAL_TEXT}}
```

For Gemini, prefer native structured output with:

```json
{
  "responseMimeType": "application/json",
  "responseSchema": "<JSON schema matching the object above>"
}
```

This is safer than extracting the first `{ ... }` block with a regular
expression.

## 6. Stage 4: Current Rule-Based Validation

The current validator:

- Ensures arrays and the vitals object exist.
- Searches the source text for a fixed list of common symptoms.
- Adds a small hard-coded ICD-10 map for selected diagnoses.
- Converts some vital strings to numbers.
- Tries to correct topical medicines incorrectly described as oral.
- Normalizes common frequency phrases to OD, BD, TID, or QID.
- Searches for a fixed list of common tests.
- Calculates completeness, accuracy, and quality scores.

It also fabricates values when fields are missing:

```text
Oral dosage:       1 tablet
Topical dosage:    Apply as directed
Frequency:         BD
Oral duration:     5 days
Topical duration:  2 weeks
Oral instructions: After meals
Topical instructions: Apply to affected area
```

These defaults should not be written into a medical record as extracted facts.
In a new application, leave missing fields as null and show them as
"Needs doctor confirmation".

## 7. Persistence

`ocr_uploads` stores:

```text
clinic_id, patient_id, visit_id, file_name, file_url, file_size, mime_type,
uploaded_by, status, processed_at
```

`ocr_results` stores:

```text
ocr_upload_id, raw_text, cleaned_medical_text, extracted_data, confidence,
processing_time, validation_report
```

Recommended additions:

```text
model_name
model_version
prompt_version
ocr_provider
input_page_count
processed_page_count
provider_usage_metadata
processing_error
reviewed_by
reviewed_at
doctor_approved
```

## 8. Important Problems in the Current Implementation

1. `gemini-2.0-flash` is shut down and must be replaced.
2. Multi-page PDFs only use page 1.
3. The file URL is generated with `getPublicUrl()`. Case papers contain
   sensitive health data and should use a private bucket with short-lived
   signed URLs.
4. The browser uploads the image before OCR and no cleanup/retention policy is
   visible in this flow.
5. The extraction prompt declares vital values as strings, but normalization
   accepts most vital values only when Gemini returns numbers. This can discard
   valid vitals.
6. Missing prescription fields are silently filled with clinical defaults.
7. The final frontend confidence is hard-coded to `0.85`; it does not use
   Gemini confidence or the validation quality score.
8. Parsing uses a greedy `{[\s\S]*}` regular expression instead of a provider
   JSON schema.
9. The main service catches processing errors and returns an empty result
   object. The UI can therefore open the EMR as though processing succeeded.
10. No per-field provenance or confidence is retained, so a doctor cannot see
    which source text produced a value.
11. Google Vision's JSON request limit is 10 MB, and base64 commonly increases
    image size by roughly 37%. A client-side 10 MB original-file limit can
    therefore produce a request that exceeds the Vision JSON limit.

## 9. Recommended Production Architecture

```text
Client
  -> private upload or direct authenticated processing endpoint
  -> create processing job
  -> render every PDF page
  -> OCR each page
  -> join text with page markers
  -> clean text
  -> structured extraction using JSON schema
  -> deterministic validation without invented clinical values
  -> save draft extraction plus source provenance
  -> doctor review and confirmation
  -> save approved EMR
```

Use these statuses:

```text
uploaded -> processing -> needs_review -> approved
                         -> failed
```

Keep AI output as a draft. Do not automatically treat it as a confirmed
prescription or diagnosis.

## 10. Suggested Configuration

```env
GOOGLE_API_KEY=server-side-secret
OCR_PROVIDER=google-vision
GEMINI_MODEL=gemini-2.5-flash
CASE_PAPER_MAX_FILE_BYTES=10485760
CASE_PAPER_MAX_PAGES=10
CASE_PAPER_MAX_OCR_CHARS=120000
CASE_PAPER_PROMPT_VERSION=case-paper-v2
CASE_PAPER_SIGNED_URL_TTL_SECONDS=300
```

Suggested generation settings:

```json
{
  "temperature": 0.0,
  "maxOutputTokens": 8192,
  "responseMimeType": "application/json"
}
```

Use token counting before the model call. If the OCR text is too large, split
by page, extract each page independently, and merge deterministically. Do not
truncate the end of a medical document without warning.
