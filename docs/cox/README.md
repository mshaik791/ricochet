# Cox / VinSolutions reference docs

The PDFs and docx from Cox (API overview, Step 2 Service Agreement, initial assessment form) were received under NDA.
They live in this folder locally and are gitignored. Ask Hameed for copies. Same for `email-*.md` drafts.

## OpenAPI specs (download from the storefront product pages, keep these exact filenames)
- lead-management.openapi.json         <- "Lead Management - 1.0" product page
- connect-event-solution.openapi.json  <- "Connect Event Solution - 1.0" product page

`npm run cox:spec-check` reads these and verifies every path in `src/adapters/vin/cox.ts` ENDPOINTS
exists in the spec. Run it after downloading and again whenever Cox bumps a version.
Specs are safe to commit (no credentials). Keys go in `.env` only.
