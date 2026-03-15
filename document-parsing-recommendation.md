# Document Parsing Recommendation

## Short answer

Do not use `TextDecoder` for PDF or DOCX knowledge files.

Use:

- `txt/csv/md/html`: parse directly in the edge function
- `pdf/docx/pptx/xlsx/images`: use LlamaParse from the edge function, or send to a dedicated parser service

## Best immediate choice for your app

Use **LlamaParse directly from the Supabase Edge Function**.

That means:

- no extra parser app deployment
- no Netlify / DO parser service needed right now
- only update the `process-knowledge-file` edge function

## Env variable to add

Add this to your **Supabase Edge Function secrets**:

```env
LLAMA_CLOUD_API_KEY=your_llamaparse_key
```

Optional, if you want to keep these configurable:

```env
LLAMA_PARSE_TIER=agentic
LLAMA_PARSE_VERSION=latest
```

Do **not** hardcode the key in the function source.

## Best practical stack

### Best open-source parser

For "best in class" open-source document parsing, use one of these:

1. `Docling`
   - Best fit for GenAI-ready parsing
   - Strong on PDF structure, reading order, tables, OCR, markdown-like output
   - Good when you want cleaner RAG chunks

2. `Unstructured`
   - Very popular production choice
   - Broad file type support
   - Good for ETL-style document pipelines

3. `Apache Tika`
   - Very mature universal extractor
   - Great fallback/parser gateway
   - Better for extraction than GenAI-optimized structure

## Recommendation for your app

Use this architecture:

1. Keep the current Supabase edge function for:
   - auth
   - storage lookup
   - chunk insertion
   - embedding

2. For the **current implementation**, call **LlamaParse** directly from the edge function for:
   - PDF
   - DOCX
   - PPTX
   - XLSX
   - scanned/image documents

3. Have the edge function receive from LlamaParse:
   - extracted plain text
   - optionally markdown / structured blocks

4. Only introduce a parser microservice later if:
   - you want lower long-term parsing cost
   - you need deeper customization
   - you hit edge-function/runtime limitations

## Why not parse everything inside Supabase Edge Functions

Edge Functions are fine for light text processing, but not ideal for:

- heavy PDF parsing
- OCR
- LibreOffice-based DOCX conversion
- larger binary dependencies
- advanced table/layout extraction

## Recommended deployment choice

### Best overall long-term

Deploy a small Python parser service on DigitalOcean using `Docling`.

Why:

- strong document understanding
- good PDF handling
- better RAG-ready output than raw byte decoding

### Best immediate path for you

Call **LlamaParse API from the edge function**.

Why:

- no extra deployment
- fastest to production
- much better than raw PDF byte decoding

### Good alternative

Use `Unstructured` if you want a very common production ingestion stack.

### Fallback

Use `Tika` if you want a simpler broad-format text extractor and can live with less structure.

## Suggested flow

1. User uploads file
2. Supabase edge function receives metadata
3. Edge function downloads file from Supabase Storage
4. If file is `txt/csv/md`, parse locally
5. If file is `pdf/docx/...`, send bytes or file reference to LlamaParse
6. LlamaParse returns extracted text/markdown
7. Edge function chunks text
8. Edge function creates embeddings
9. Chunks go into `knowledge_chunks`

## Exact code changes you need

### In `process-knowledge-file`

Keep this for simple text files:

- `text/plain`
- `text/csv`
- `text/markdown`

For PDFs and other rich documents, replace:

```ts
const text = extractTextFromBytes(bytes, mime_type || "text/plain");
```

with logic like:

```ts
let text = "";

if (
  mime_type === "text/plain" ||
  mime_type === "text/csv" ||
  mime_type === "text/markdown"
) {
  text = extractTextFromBytes(bytes, mime_type || "text/plain");
} else {
  text = await extractViaLlamaParse(fileData, file_name, mime_type);
}
```

### New helper to add

Add an `extractViaLlamaParse(...)` helper in the same edge function.

That helper should:

1. read `LLAMA_CLOUD_API_KEY` from env
2. upload or reference the document
3. request parse output with:
   - `tier: "agentic"`
   - `version: "latest"`
   - `expand: ["text_full", "markdown_full"]`
4. return:
   - `text_full` if available
   - otherwise `markdown_full`

## Where to add the env variable

Add it in **Supabase project -> Edge Functions -> Secrets**.

Set:

```env
LLAMA_CLOUD_API_KEY=your_key_here
```

If you also mirror envs in local `.env` files for documentation, that is fine, but the real runtime value must exist in Supabase Edge Function secrets.

## Parser service API shape

### Request

```json
{
  "file_url": "https://...",
  "file_name": "report.pdf",
  "mime_type": "application/pdf"
}
```

### Response

```json
{
  "success": true,
  "text": "full extracted text here",
  "markdown": "optional markdown form",
  "meta": {
    "pages": 12
  }
}
```

## What platforms like DigitalOcean Agents likely use

From public docs, DigitalOcean exposes:

- knowledge bases
- data sources
- embedding model selection
- OpenSearch as storage

But it does not publicly document the exact parsing library in the user-facing docs.

So the safe conclusion is:

- they use a managed ingestion pipeline
- they store indexed data in OpenSearch
- parser internals are abstracted away

Do not assume they are doing raw text decoding like the current edge function.

## If you want zero parser service

You now have two valid choices:

1. Restrict uploads to:
   - `.txt`
   - `.md`
   - `.csv`

2. Use **LlamaParse directly from the edge function**

That is the recommended no-extra-app path.

## Final recommendation

For your production knowledge base:

- keep Supabase for storage, chunk metadata, embeddings, retrieval
- use **LlamaParse directly inside the edge function** right now
- only parse simple text files locally
- move to a dedicated `Docling` service later only if you outgrow the API-based approach
